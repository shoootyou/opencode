import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type {
  Hooks,
  PluginInput,
  Plugin as PluginInstance,
  PluginModule,
  PluginUiPublish,
  WorkspaceAdapter as PluginWorkspaceAdapter,
} from "@opencode-ai/plugin"
import { Config } from "@/config/config"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { ServerAuth } from "@/server/auth"
import { CodexAuthPlugin } from "./openai/codex"
import { Session } from "@/session/session"
import { NamedError } from "@opencode-ai/core/util/error"
import { CopilotAuthPlugin } from "./github-copilot/copilot"
import { ModalPlugin } from "./modal/modal"
import { gitlabAuthPlugin as GitlabAuthPlugin } from "opencode-gitlab-auth"
import { PoeAuthPlugin } from "opencode-poe-auth"
import { CloudflareAIGatewayAuthPlugin, CloudflareWorkersAuthPlugin } from "./cloudflare"
import { AzureAuthPlugin } from "./azure"
import { DigitalOceanAuthPlugin } from "./digitalocean"
import { XaiAuthPlugin } from "./xai"
import { SnowflakeCortexAuthPlugin } from "./snowflake-cortex"
import { Deferred, Effect, Layer, Context } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { errorMessage } from "@/util/error"
import { PluginLoader } from "./loader"
import { publishDirect } from "./ui-store"
import { PluginUiEvent } from "@opencode-ai/schema/plugin-ui-event"
import { parsePluginSpecifier, readPluginId, readV1Plugin, resolvePluginId } from "./shared"
import { registerAdapter } from "@/control-plane/adapters"
import type { WorkspaceAdapter } from "@/control-plane/types"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstallationChannel } from "@opencode-ai/core/installation/version"

// Module-level (process-wide) re-entrancy guard, keyed by directory: tracks a
// directory whose input.ui.publish flush is currently being awaited by
// init() below. Server.Default() unconditionally re-bootstraps every
// configured plugin for a directory on first touch (InstanceContextMiddleware
// -> InstanceStore.load -> bootstrap.run -> plugin.init()) — including THIS
// plugin, for the SAME directory, if it is one of the directory's own
// configured plugins. Without this guard, that nested plugin.init() call
// would itself try to await its own flush, recursing into the very
// InstanceStore.load() Deferred the outer flush's HTTP call is blocked on
// resolving — a genuine circular deadlock, not just added latency. A
// directory string can never collide across concurrent, unrelated flushes
// because each directory's own outer init() call owns the entry for the
// full duration of its own await.
const directoriesFlushing = new Set<string>()

type State = {
  hooks: Hooks[]
  // Drains everything queued in `input.ui.publish` while plugins were still
  // loading. Deliberately NOT invoked from inside the `Plugin.state` closure
  // itself: flushing round-trips an HTTP call back through Server.Default()
  // -> InstanceContextMiddleware -> InstanceStore.load -> bootstrap.run ->
  // plugin.init() -> InstanceState.get(state) for this SAME directory — a
  // reentrant ScopedCache.get() on an entry that is still being computed.
  // `init()` below calls this AFTER InstanceState.get(state) has already
  // returned (entry cached), so the reentrant call safely short-circuits to
  // the cached value instead of re-running this closure.
  flushPendingPublishes: () => Promise<unknown>
}

// Hook names that follow the (input, output) => Promise<void> trigger pattern
type TriggerName = {
  [K in keyof Hooks]-?: NonNullable<Hooks[K]> extends (input: any, output: any) => Promise<void> ? K : never
}[keyof Hooks]

export interface Interface {
  readonly trigger: <
    Name extends TriggerName,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(
    name: Name,
    input: Input,
    output: Output,
  ) => Effect.Effect<Output>
  readonly list: () => Effect.Effect<Hooks[]>
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Plugin") {}

export function experimentalWebSocketsEnabled(input: { enabled: boolean; channel?: string }) {
  return input.enabled || ["local", "dev", "beta"].includes(input.channel ?? InstallationChannel)
}

// Built-in plugins that are directly imported (not installed from npm)
function internalPlugins(flags: RuntimeFlags.Info): PluginInstance[] {
  return [
    // Temporary rollout: pre-release builds use WebSockets by default; releases require explicit opt-in.
    (input) =>
      CodexAuthPlugin(input, {
        experimentalWebSockets: experimentalWebSocketsEnabled({ enabled: flags.experimentalWebSockets }),
      }),
    CopilotAuthPlugin,
    ModalPlugin,
    GitlabAuthPlugin,
    PoeAuthPlugin,
    CloudflareWorkersAuthPlugin,
    CloudflareAIGatewayAuthPlugin,
    AzureAuthPlugin,
    DigitalOceanAuthPlugin,
    SnowflakeCortexAuthPlugin,
    XaiAuthPlugin,
  ]
}

function isServerPlugin(value: unknown): value is PluginInstance {
  return typeof value === "function"
}

function getServerPlugin(value: unknown) {
  if (isServerPlugin(value)) return value
  if (!value || typeof value !== "object" || !("server" in value)) return
  if (!isServerPlugin(value.server)) return
  return value.server
}

function getLegacyPlugins(mod: Record<string, unknown>) {
  const seen = new Set<unknown>()
  const result: PluginInstance[] = []

  for (const entry of Object.values(mod)) {
    if (seen.has(entry)) continue
    seen.add(entry)
    const plugin = getServerPlugin(entry)
    if (!plugin) throw new TypeError("Plugin export is not a function")
    result.push(plugin)
  }

  return result
}

async function applyPlugin(
  load: PluginLoader.Loaded,
  input: PluginInput,
  hooks: Hooks[],
  makeUi: (pluginID: string) => { publish: PluginUiPublish },
) {
  const plugin = readV1Plugin(load.mod, load.spec, "server", "detect")
  if (plugin) {
    const id = await resolvePluginId(load.source, load.spec, load.target, readPluginId(plugin.id, load.spec), load.pkg)
    hooks.push(await (plugin as PluginModule).server({ ...input, ui: makeUi(id) }, load.options))
    return
  }

  // OQ2/D7: legacy plugins (no exported id, never pass through resolvePluginId)
  // still get a populated `input.ui`, bound to a fallback id derived from
  // `load.spec` — rodo's explicit Option B choice, not the RFC's own leaning.
  const legacyPlugins = getLegacyPlugins(load.mod)
  for (const [index, server] of legacyPlugins.entries()) {
    const fallbackID = legacyPlugins.length > 1 ? `${load.spec}#${index}` : load.spec
    hooks.push(await server({ ...input, ui: makeUi(fallbackID) }, load.options))
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Plugin.state")(function* (ctx) {
        const hooks: Hooks[] = []
        const bridge = yield* EffectBridge.make()

        function publishPluginError(message: string) {
          bridge.fork(events.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() }))
        }

        const { Server } = yield* Effect.promise(() => import("../server/server"))

        const serverUrl = Server.url
        const client = createOpencodeClient({
          baseUrl: serverUrl?.toString() ?? "http://localhost:4096",
          directory: ctx.directory,
          headers: ServerAuth.headers(),
          ...(serverUrl ? {} : { fetch: async (...args) => Server.Default().app.fetch(...args) }),
        })
        const cfg = yield* config.get()
        const input: PluginInput = {
          client,
          project: ctx.project,
          worktree: ctx.worktree,
          directory: ctx.directory,
          experimental_workspace: {
            register(type: string, adapter: PluginWorkspaceAdapter) {
              registerAdapter(ctx.project.id, type, adapter as WorkspaceAdapter)
            },
          },
          get serverUrl(): URL {
            return Server.url ?? new URL("http://localhost:4096")
          },
          // @ts-expect-error
          $: typeof Bun === "undefined" ? undefined : Bun.$,
        }

        // D15/OQ3c: the `pluginsLoaded` gate and its pending-publish queue live
        // INSIDE this per-directory closure (never module-level). The external
        // plugin-load loop below runs once per directory via ScopedCache
        // (InstanceState.make), so a process-global gate would resolve on
        // whichever directory loads first and stay inert — silently
        // reinstating the deadlock — for every directory after it.
        const pluginsLoaded = yield* Deferred.make<void>()
        const pendingByPlugin = new Map<string, Array<{ event: string; body: string }>>()
        const draining = new Set<string>()
        const PENDING_QUEUE_CAP = 16

        function warnPublishFailure(pluginID: string, event: string, reason: string) {
          console.warn("plugin-ui publish failed", { pluginID, event, reason })
        }

        function enqueuePending(pluginID: string, event: string, body: string) {
          const queue = pendingByPlugin.get(pluginID) ?? []
          if (!pendingByPlugin.has(pluginID)) pendingByPlugin.set(pluginID, queue)
          queue.push({ event, body })
          if (queue.length <= PENDING_QUEUE_CAP) return
          const dropped = queue.shift()
          if (dropped) warnPublishFailure(pluginID, dropped.event, "pending_queue_full")
        }

        // E6c (D1): the self-flush no longer round-trips HTTP at all. It calls `publishDirect`
        // using the `InstanceContext` this closure already has in hand (`ctx.directory`) — so it
        // never re-enters InstanceContextMiddleware -> InstanceStore.load() for its own
        // still-booting directory, and therefore cannot deadlock regardless of transport
        // (in-process Server.Default() OR a real TCP Server.listen()). `publishDirect` validates
        // with the SAME gate the HTTP handler uses (D3) before writing into the shared
        // `@/plugin/ui-store` module-level store (D2).
        async function sendPublish(pluginID: string, event: string, body: string) {
          try {
            const parsed = JSON.parse(body) as typeof PluginUiEvent.Custom.data.Type
            const reason = publishDirect({
              directory: ctx.directory,
              workspaceID: undefined,
              pluginID: parsed.pluginID,
              event: parsed.event,
              data: parsed.data,
            })
            if (reason) {
              warnPublishFailure(pluginID, event, reason)
              return
            }
            // Retention alone is not enough: the HTTP handler also relays the event live over
            // SSE so already-connected UI subscribers see it without refetching the snapshot.
            // Mirror that here, or the direct path silently loses the live push.
            bridge.fork(events.publish(PluginUiEvent.Custom, parsed))
          } catch (err) {
            warnPublishFailure(pluginID, event, errorMessage(err))
          }
        }

        async function flushPending(pluginID: string) {
          if (draining.has(pluginID)) return
          draining.add(pluginID)
          try {
            const queue = pendingByPlugin.get(pluginID)
            while (queue && queue.length > 0) {
              const item = queue.shift()
              if (item) await sendPublish(pluginID, item.event, item.body)
            }
          } finally {
            draining.delete(pluginID)
          }
        }

        function makeUi(pluginID: string): { publish: PluginUiPublish } {
          return {
            // Resolves on ENQUEUE, not delivery — safe to call synchronously
            // inside a plugin's own server() body without deadlocking the
            // still-constructing InstanceState. Never rejects: every failure
            // path (unserializable data, oversized/non-2xx server response,
            // transport failure) is caught and logged at warn instead.
            publish: async (event, data) => {
              let body: string
              try {
                body = JSON.stringify({ pluginID, event, data })
              } catch (err) {
                warnPublishFailure(pluginID, event, "unserializable")
                return
              }
              enqueuePending(pluginID, event, body)
              if (Deferred.isDoneUnsafe(pluginsLoaded)) void flushPending(pluginID)
            },
          }
        }

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            pendingByPlugin.clear()
            draining.clear()
          }),
        )

        for (const plugin of flags.disableDefaultPlugins ? [] : internalPlugins(flags)) {
          const init = yield* Effect.tryPromise({
            try: () => plugin(input),
            catch: errorMessage,
          }).pipe(
            Effect.tapError((error) => Effect.logError("failed to load internal plugin", { name: plugin.name, error })),
            Effect.option,
          )
          if (init._tag === "Some") hooks.push(init.value)
        }

        const plugins = flags.pure ? [] : (cfg.plugin_origins ?? [])
        if (flags.pure && cfg.plugin_origins?.length) {
        }
        if (plugins.length) yield* config.waitForDependencies()

        const loaded = yield* Effect.promise(() =>
          PluginLoader.loadExternal({
            items: plugins,
            kind: "server",
            report: {
              start(candidate) {},
              missing(candidate, _retry, message) {},
              error(candidate, _retry, stage, error, resolved) {
                const spec = candidate.plan.spec
                const cause = error instanceof Error ? (error.cause ?? error) : error
                const message = stage === "load" ? errorMessage(error) : errorMessage(cause)

                if (stage === "install") {
                  const parsed = parsePluginSpecifier(spec)
                  publishPluginError(`Failed to install plugin ${parsed.pkg}@${parsed.version}: ${message}`)
                  return
                }

                if (stage === "compatibility") {
                  publishPluginError(`Plugin ${spec} skipped: ${message}`)
                  return
                }

                if (stage === "entry") {
                  publishPluginError(`Failed to load plugin ${spec}: ${message}`)
                  return
                }

                publishPluginError(`Failed to load plugin ${spec}: ${message}`)
              },
            },
          }),
        )
        for (const load of loaded) {
          if (!load) continue

          // Keep plugin execution sequential so hook registration and execution
          // order remains deterministic across plugin runs.
          yield* Effect.tryPromise({
            try: () => applyPlugin(load, input, hooks, makeUi),
            catch: (err) => {
              const message = errorMessage(err)
              return message
            },
          }).pipe(
            Effect.tapError((error) => Effect.logError("failed to load plugin", { path: load.spec, error })),
            Effect.catch(() => {
              // TODO: make proper events for this
              // events.publish(Session.Event.Error, {
              //   error: new NamedError.Unknown({
              //     message: `Failed to load plugin ${load.spec}: ${message}`,
              //   }).toObject(),
              // })
              return Effect.void
            }),
          )
        }

        // Resolve the gate after every plugin has attempted to load —
        // success or failure — regardless. It must resolve even when every
        // plugin fails, or a failed load strands every queued publish forever.
        // The actual HTTP flush is NOT triggered here — see State's own
        // `flushPendingPublishes` doc comment for why. makeUi(...).publish
        // above reads this same deferred (via Deferred.isDoneUnsafe) to
        // decide whether a publish arriving after this point should
        // self-flush immediately instead of waiting on flushPendingPublishes.
        yield* Deferred.succeed(pluginsLoaded, void 0)

        // Notify plugins of current config
        for (const hook of hooks) {
          yield* Effect.tryPromise({
            try: () => Promise.resolve((hook as any).config?.(cfg)),
            catch: errorMessage,
          }).pipe(
            Effect.tapError((error) => Effect.logError("plugin config hook failed", { error })),
            Effect.ignore,
          )
        }

        const unsubscribe = yield* events.listen((event) => {
          if (event.location?.directory !== ctx.directory) return Effect.void
          return Effect.sync(() => {
            for (const hook of hooks) {
              void hook["event"]?.({ event: { id: event.id, type: event.type, properties: event.data } as any })
            }
          })
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            hooks,
            (hook) =>
              Effect.tryPromise({
                try: () => Promise.resolve(hook.dispose?.()),
                catch: errorMessage,
              }).pipe(
                Effect.tapError((error) => Effect.logError("plugin dispose hook failed", { error })),
                Effect.ignore,
              ),
            { discard: true },
          ),
        )

        return {
          hooks,
          flushPendingPublishes: () =>
            Promise.all(Array.from(pendingByPlugin.keys(), (pluginID) => flushPending(pluginID))),
        }
      }),
    )

    const trigger = Effect.fn("Plugin.trigger")(function* <
      Name extends TriggerName,
      Input = Parameters<Required<Hooks>[Name]>[0],
      Output = Parameters<Required<Hooks>[Name]>[1],
    >(name: Name, input: Input, output: Output) {
      if (!name) return output
      const s = yield* InstanceState.get(state)
      for (const hook of s.hooks) {
        const fn = hook[name] as any
        if (!fn) continue
        yield* Effect.promise(async () => fn(input, output))
      }
      return output
    })

    const list = Effect.fn("Plugin.list")(function* () {
      const s = yield* InstanceState.get(state)
      return s.hooks
    })

    const init = Effect.fn("Plugin.init")(function* () {
      const s = yield* InstanceState.get(state)
      const directory = yield* InstanceState.directory
      // Re-entrant call: Server.Default()'s own bootstrap for this SAME
      // directory (triggered by the outer flush's own HTTP call, still
      // in flight below) is what reached this init() — see
      // `directoriesFlushing`'s own module-level doc comment for why
      // awaiting here would deadlock. Fire the flush without joining it;
      // the OUTER call below owns delivering this directory's data.
      if (directoriesFlushing.has(directory)) {
        void s.flushPendingPublishes()
        return
      }
      directoriesFlushing.add(directory)
      try {
        yield* Effect.promise(() => s.flushPendingPublishes())
      } finally {
        directoriesFlushing.delete(directory)
      }
    })

    return Service.of({ trigger, list, init })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [EventV2Bridge.node, Config.node, RuntimeFlags.node],
})

export * as Plugin from "."
