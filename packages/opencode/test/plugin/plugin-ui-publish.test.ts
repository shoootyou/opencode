/**
 * @spec-handoff
 * @interface `PluginInput.ui?: { publish: (event: string, data: Record<string, JsonValue>) => Promise<void> }`
 *   (`packages/plugin/src/index.ts`). Bound per-plugin inside `applyPlugin` (`plugin/index.ts:112-123`)
 *   via `makeUi(id)`, where `id` is `resolvePluginId(...)`'s currently-discarded return value at `:115`.
 * @behavior
 *   - `publish` NEVER rejects: unserializable data, oversized data, non-2xx server response, and
 *     transport/dead-server failure are all no-ops from the caller's perspective (logged, not thrown).
 *   - `publish`'s promise resolves on ENQUEUE, not delivery — safe to call synchronously inside a
 *     plugin's own `server()` body without deadlocking the still-constructing `InstanceState`.
 *   - One `pluginsLoaded` gate + one pending-publish queue per `InstanceState` scope (per directory),
 *     created INSIDE the `Effect.fn("Plugin.state")` closure (`:132`) — never module-level. Resolved
 *     at the end of the `for (const load of loaded)` loop (`:217+`), regardless of individual plugin
 *     success/failure. The HTTP publish only fires after that resolution.
 *   - Pending queue bounded at 16 entries per plugin, per directory, oldest-dropped, warn-logged.
 * @edge-cases
 *   - Two directories loading concurrently: directory A's loop finishing must NOT flush directory B's
 *     still-queued publishes (the OQ3c discriminating case — a module-level gate fails this).
 *   - JSON's own lossy transforms (Date→ISO, undefined dropped, NaN/Infinity→null) are accepted, not
 *     treated as an error.
 * @see .yui-soul/rfcs/approved/050-opencode-plugin-ui-event-channel/README.md §1e
 * @see ../../src/server/routes/instance/httpapi/groups/plugin-ui.ts (already-implemented relay this sugar calls through)
 */

import { afterEach, beforeEach, describe, expect, spyOn } from "bun:test"
import { Effect, Exit, Fiber } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Npm } from "@opencode-ai/core/npm"
import path from "path"
import { pathToFileURL } from "url"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin/index"
import { Server } from "../../src/server/server"

import { TestInstance, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffectShared } from "../lib/effect"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const it = testEffectShared(
  AppNodeBuilder.build(LayerNode.group([Plugin.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  ]),
)

let warnSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  // publish's own pre-flight/queue-drop warnings are expected to fire in several of these tests —
  // suppress stdout noise while keeping every call available for assertion via warnSpy.mock.calls.
  // Console.warn is Effect's own routing target for Warn-level logs regardless of whether the
  // eventual implementation calls `console.warn` directly or `Effect.logWarning` (whose default
  // logger writes Warn through `console.warn`), so this spy is implementation-agnostic.
  warnSpy = spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
})

// ---------------------------------------------------------------------------
// Shared plugin-loading helpers
// ---------------------------------------------------------------------------

// V1-plugin-with-id shape — the ONLY branch `applyPlugin` resolves a pluginID and constructs
// `makeUi(id)` for (`plugin/index.ts:113-118`). The bare-function legacy shape
// (`export default async () => ({...})`, used by trigger.test.ts) falls into `getLegacyPlugins`
// instead, whose `ui` treatment is RFC OQ2 — explicitly out of scope for E5 per this step's own
// Notes section.
function pluginSource(id: string, body: string) {
  return [
    `export default {`,
    `  id: ${JSON.stringify(id)},`,
    `  server: async (input, options) => {`,
    body,
    `    return {}`,
    `  },`,
    `}`,
    ``,
  ].join("\n")
}

// Writes plugin.ts + opencode.json into an already-bound TestInstance directory, mirroring
// trigger.test.ts's own withProject helper.
function withProject<A, E, R>(source: string, self: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const test = yield* TestInstance
    const file = path.join(test.directory, "plugin.ts")
    yield* Effect.all(
      [
        Effect.promise(() => Bun.write(file, source)),
        Effect.promise(() =>
          Bun.write(
            path.join(test.directory, "opencode.json"),
            JSON.stringify(
              { $schema: "https://opencode.ai/config.json", plugin: [pathToFileURL(file).href] },
              null,
              2,
            ),
          ),
        ),
      ],
      { discard: true, concurrency: 2 },
    )
    return yield* self
  })
}

// Writes TWO plugin files into one already-bound TestInstance directory, loaded sequentially in
// array order (plugin/index.ts:220-221's own sequential-execution comment) — used by the
// "flushed only after the loop completes" test, where plugin B observes plugin A's mid-load state.
function withTwoPluginProject<A, E, R>(sourceA: string, sourceB: string, self: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const test = yield* TestInstance
    const fileA = path.join(test.directory, "plugin-a.ts")
    const fileB = path.join(test.directory, "plugin-b.ts")
    yield* Effect.all(
      [
        Effect.promise(() => Bun.write(fileA, sourceA)),
        Effect.promise(() => Bun.write(fileB, sourceB)),
        Effect.promise(() =>
          Bun.write(
            path.join(test.directory, "opencode.json"),
            JSON.stringify(
              {
                $schema: "https://opencode.ai/config.json",
                plugin: [pathToFileURL(fileA).href, pathToFileURL(fileB).href],
              },
              null,
              2,
            ),
          ),
        ),
      ],
      { discard: true, concurrency: 3 },
    )
    return yield* self
  })
}

// Writes a single plugin + config into an EXPLICIT directory (not the ambient TestInstance) — used
// by the two-directory discriminating case, where each directory's load is triggered independently
// via `provideInstance(dir)` rather than the single-instance `it.instance` harness.
function writeProject(directory: string, source: string) {
  const file = path.join(directory, "plugin.ts")
  return Effect.all(
    [
      Effect.promise(() => Bun.write(file, source)),
      Effect.promise(() =>
        Bun.write(
          path.join(directory, "opencode.json"),
          JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: [pathToFileURL(file).href] }, null, 2),
        ),
      ),
    ],
    { discard: true, concurrency: 2 },
  )
}

// Triggers a full plugin-load for the given directory (InstanceState.get, via Plugin.Service.init())
// without depending on the ambient TestInstance — scoped explicitly via provideInstance(directory).
function loadDirectory(directory: string) {
  return Effect.gen(function* () {
    const plugin = yield* Plugin.Service
    yield* plugin.init()
  }).pipe(provideInstance(directory))
}

// Reads the retained plugin-ui snapshot for a directory through the SAME production route tree
// (Server.Default().app / HttpApiApp.context singleton) that a plugin's own in-process client
// fallback (plugin/index.ts:148) calls into — not a separate test-only router, so this observes
// exactly what the real implementation would have written.
async function readSnapshot(directory: string) {
  const res = await Server.Default().app.request("/plugin-ui/snapshot", {
    headers: { "x-opencode-directory": directory },
  })
  if (res.status !== 200) throw new Error(`snapshot read failed with status ${res.status}: ${await res.text()}`)
  return (await res.json()) as {
    serverTime: number
    // `directory` is part of the wire shape since RFC 050 revision 5 (D20/D22) — every
    // aggregated row is attributed with its own origin directory. Kept in this local type
    // (rather than widened to `unknown`) so the OQ3c reconciliation below can assert on it.
    entries: Array<{ directory: string; pluginID: string; event: string; data: Record<string, unknown>; publishedAt: number }>
  }
}

function findEntry(snapshot: Awaited<ReturnType<typeof readSnapshot>>, pluginID: string, event: string) {
  return snapshot.entries.find((entry) => entry.pluginID === pluginID && entry.event === event)
}

// Polls the snapshot until the given (pluginID, event) entry appears, or times out. Used instead of
// a single immediate read for POSITIVE presence assertions, since the RFC only specifies that the
// flush happens "after the loop completes" — not whether the closure itself awaits flush completion
// before InstanceState.get/plugin.init() returns. Polling is robust to either implementation choice
// without racing (test/AGENTS.md "Synchronizing With Concurrent Work").
function waitForEntry(directory: string, pluginID: string, event: string, timeoutMs = 3000) {
  return pollWithTimeout(
    Effect.promise(async () => {
      const snapshot = await readSnapshot(directory)
      const entry = findEntry(snapshot, pluginID, event)
      return entry ?? undefined
    }),
    `entry ${pluginID}/${event} never appeared in the ${directory} snapshot`,
    `${timeoutMs} millis`,
  )
}

// Polls a marker file's existence — the readiness-signal mechanism for coordinating with a
// dynamically-imported plugin module, which cannot share Effect Deferred/Queue primitives directly
// with the test fiber. Mirrors pollWithTimeout's own "wait on a signal, not wall-clock time" shape.
function waitForMarker(markerPath: string, timeoutMs = 5000) {
  return pollWithTimeout(
    Effect.promise(async () => ((await Bun.file(markerPath).exists()) ? true : undefined)),
    `marker ${markerPath} never appeared`,
    `${timeoutMs} millis`,
  )
}

function readMarker(markerPath: string) {
  return Effect.promise(() => Bun.file(markerPath).text())
}

// ---------------------------------------------------------------------------
// Task 1 — never-rejects + pre-flight serialization semantics (RFC 050 §1e)
// ---------------------------------------------------------------------------

describe("input.ui.publish — never-rejects + pre-flight serialization (RFC 050 §1e)", () => {
  it.instance(
    "resolves (never rejects) when data contains a circular reference, logged at warn with reason unserializable",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const marker = path.join(test.directory, "marker.txt")
        yield* withProject(
          pluginSource(
            "circular-plugin",
            [
              `    const data = {}`,
              `    data.self = data`,
              `    try {`,
              `      await input.ui.publish("status", data)`,
              `      await Bun.write(${JSON.stringify(marker)}, "resolved")`,
              `    } catch (err) {`,
              `      await Bun.write(${JSON.stringify(marker)}, "rejected:" + (err && err.message || String(err)))`,
              `    }`,
            ].join("\n"),
          ),
          Effect.gen(function* () {
            const plugin = yield* Plugin.Service
            yield* plugin.init()
            expect(yield* readMarker(marker)).toBe("resolved")
            expect(
              warnSpy.mock.calls.some((call: unknown[]) =>
                call.some((arg: unknown) => JSON.stringify(arg).includes("unserializable")),
              ),
            ).toBe(true)
          }),
        )
      }),
    { git: true },
  )

  it.instance(
    "resolves (never rejects) when data contains a BigInt, logged at warn with reason unserializable",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const marker = path.join(test.directory, "marker.txt")
        yield* withProject(
          pluginSource(
            "bigint-plugin",
            [
              `    try {`,
              `      await input.ui.publish("status", { big: 10n })`,
              `      await Bun.write(${JSON.stringify(marker)}, "resolved")`,
              `    } catch (err) {`,
              `      await Bun.write(${JSON.stringify(marker)}, "rejected:" + (err && err.message || String(err)))`,
              `    }`,
            ].join("\n"),
          ),
          Effect.gen(function* () {
            const plugin = yield* Plugin.Service
            yield* plugin.init()
            expect(yield* readMarker(marker)).toBe("resolved")
            expect(
              warnSpy.mock.calls.some((call: unknown[]) =>
                call.some((arg: unknown) => JSON.stringify(arg).includes("unserializable")),
              ),
            ).toBe(true)
          }),
        )
      }),
    { git: true },
  )

  it.instance(
    "accepts JSON's own lossy transforms (Date→ISO, undefined dropped, NaN/Infinity→null) and stores the transformed data",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const marker = path.join(test.directory, "marker.txt")
        yield* withProject(
          pluginSource(
            "lossy-plugin",
            [
              `    const data = { when: new Date(0), missing: undefined, notANumber: NaN, huge: Infinity, tinyHuge: -Infinity, kept: "ok" }`,
              `    try {`,
              `      await input.ui.publish("status", data)`,
              `      await Bun.write(${JSON.stringify(marker)}, "resolved")`,
              `    } catch (err) {`,
              `      await Bun.write(${JSON.stringify(marker)}, "rejected:" + (err && err.message || String(err)))`,
              `    }`,
            ].join("\n"),
          ),
          Effect.gen(function* () {
            const plugin = yield* Plugin.Service
            yield* plugin.init()
            expect(yield* readMarker(marker)).toBe("resolved")
            const entry = yield* waitForEntry(test.directory, "lossy-plugin", "status")
            expect(entry?.data).toMatchObject({
              when: "1970-01-01T00:00:00.000Z",
              notANumber: null,
              huge: null,
              tinyHuge: null,
              kept: "ok",
            })
            expect(entry?.data).not.toHaveProperty("missing")
          }),
        )
      }),
    { git: true },
  )

  it.instance(
    "resolves (never rejects) and logs payload_too_large when data exceeds 16 KiB of UTF-8 bytes, and never reaches the snapshot",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const marker = path.join(test.directory, "marker.txt")
        yield* withProject(
          pluginSource(
            "oversized-plugin",
            [
              `    try {`,
              `      await input.ui.publish("status", { blob: "x".repeat(17 * 1024) })`,
              `      await Bun.write(${JSON.stringify(marker)}, "resolved")`,
              `    } catch (err) {`,
              `      await Bun.write(${JSON.stringify(marker)}, "rejected:" + (err && err.message || String(err)))`,
              `    }`,
            ].join("\n"),
          ),
          Effect.gen(function* () {
            const plugin = yield* Plugin.Service
            yield* plugin.init()
            expect(yield* readMarker(marker)).toBe("resolved")
            expect(
              warnSpy.mock.calls.some((call: unknown[]) =>
                call.some((arg: unknown) => JSON.stringify(arg).includes("payload_too_large")),
              ),
            ).toBe(true)
            // Grace window before asserting permanent absence — the pre-flight rejection means this
            // publish was never even enqueued, so there is nothing for a later flush to deliver;
            // this is not racing a "becomes true" condition, it is confirming a negative after the
            // load (and any flush it triggers) has had time to settle.
            yield* Effect.sleep("300 millis")
            const snapshot = yield* Effect.promise(() => readSnapshot(test.directory))
            expect(findEntry(snapshot, "oversized-plugin", "status")).toBeUndefined()
          }),
        )
      }),
    { git: true },
  )

  it.instance(
    "resolves (never rejects) even when the server independently rejects the publish with a real non-2xx response",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const marker = path.join(test.directory, "marker.txt")
        // "constructor" is a real, already-implemented reserved_key rejection (E4) — this forces a
        // genuine 400 from the production handler, not a mock, proving non-2xx is never observable.
        yield* withProject(
          pluginSource(
            "reserved-plugin",
            [
              `    try {`,
              `      await input.ui.publish("constructor", { ok: true })`,
              `      await Bun.write(${JSON.stringify(marker)}, "resolved")`,
              `    } catch (err) {`,
              `      await Bun.write(${JSON.stringify(marker)}, "rejected:" + (err && err.message || String(err)))`,
              `    }`,
            ].join("\n"),
          ),
          Effect.gen(function* () {
            const plugin = yield* Plugin.Service
            yield* plugin.init()
            expect(yield* readMarker(marker)).toBe("resolved")
            yield* Effect.sleep("300 millis")
            const snapshot = yield* Effect.promise(() => readSnapshot(test.directory))
            expect(findEntry(snapshot, "reserved-plugin", "constructor")).toBeUndefined()
          }),
        )
      }),
    { git: true },
  )

  it.instance(
    "resolves (never rejects) even when the underlying transport fails (dead server / network error)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const marker = path.join(test.directory, "marker.txt")
        // Start a real listener so plugin/index.ts's client construction (:144-149) takes the
        // `baseUrl: serverUrl.toString()` branch and falls through to the SDK's default transport
        // (globalThis.fetch) instead of the in-process `Server.Default().app.fetch` override — only
        // then does mocking globalThis.fetch genuinely exercise a transport-failure path rather than
        // being silently bypassed.
        const listener = yield* Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 }))
        const originalFetch = globalThis.fetch
        globalThis.fetch = (() => Promise.reject(new Error("simulated dead server"))) as unknown as typeof fetch
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            globalThis.fetch = originalFetch
            await listener.stop(true)
          }),
        )

        yield* withProject(
          pluginSource(
            "dead-server-plugin",
            [
              `    try {`,
              `      await input.ui.publish("status", { ok: true })`,
              `      await Bun.write(${JSON.stringify(marker)}, "resolved")`,
              `    } catch (err) {`,
              `      await Bun.write(${JSON.stringify(marker)}, "rejected:" + (err && err.message || String(err)))`,
              `    }`,
            ].join("\n"),
          ),
          Effect.gen(function* () {
            const plugin = yield* Plugin.Service
            yield* plugin.init()
            expect(yield* readMarker(marker)).toBe("resolved")
          }),
        )
      }),
    { git: true },
    10_000,
  )
})

// ---------------------------------------------------------------------------
// Task 2 — per-directory pluginsLoaded gate + bounded queue (RFC 050 §1e/D15/OQ3c)
// ---------------------------------------------------------------------------

describe("input.ui.publish — per-directory pluginsLoaded gate + bounded queue (RFC 050 §1e/D15/OQ3c)", () => {
  it.instance(
    "resolves immediately when called synchronously inside server() — enqueue, not delivery, no deadlock on the still-constructing InstanceState",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const marker = path.join(test.directory, "marker.txt")
        yield* withProject(
          pluginSource(
            "sync-publish-plugin",
            [
              // The very first thing this plugin does — before anything else — is publish. If the
              // gate were absent or module-level-inert, this would attempt an HTTP call back into
              // the instance that is still constructing (plugin/index.ts:141-149 builds `client`
              // in the very same closure this server() call runs inside of).
              `    await input.ui.publish("status", { phase: "sync" })`,
              `    await Bun.write(${JSON.stringify(marker)}, "resolved-during-server")`,
            ].join("\n"),
          ),
          Effect.gen(function* () {
            const plugin = yield* Plugin.Service
            // Completing this within the test's own timeout IS the no-deadlock proof.
            yield* plugin.init()
            expect(yield* readMarker(marker)).toBe("resolved-during-server")
          }),
        )
      }),
    { git: true },
    5_000,
  )

  it.instance(
    "flushes the underlying HTTP publish only after the applyPlugin loop for the directory completes — a still-loading sibling plugin does not yet see it",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const bStarted = path.join(test.directory, "b-started.marker")
        const release = path.join(test.directory, "release.marker")
        const midLoadSnapshot = path.join(test.directory, "mid-load-snapshot.json")

        const pluginA = pluginSource("flush-order-plugin-a", [
          `    await input.ui.publish("status", { from: "a" })`,
        ].join("\n"))

        // Plugin B loads SECOND (sequential execution, plugin/index.ts:220-221) — it signals it has
        // started (proving A's server() call, including A's publish, already returned) and then
        // blocks until the test releases it, keeping the directory's loop "in progress".
        const pluginB = pluginSource("flush-order-plugin-b", [
          `    await Bun.write(${JSON.stringify(bStarted)}, "started")`,
          `    while (!(await Bun.file(${JSON.stringify(release)}).exists())) {`,
          `      await new Promise((resolve) => setTimeout(resolve, 20))`,
          `    }`,
        ].join("\n"))

        yield* withTwoPluginProject(
          pluginA,
          pluginB,
          Effect.gen(function* () {
            const plugin = yield* Plugin.Service
            const fiber = yield* Effect.forkChild(plugin.init())

            // Confirms the loop is now on plugin B — meaning plugin A's server() (and its publish
            // call) has already returned, but the loop (and therefore pluginsLoaded) has not.
            yield* waitForMarker(bStarted)

            const midSnapshot = yield* Effect.promise(() => readSnapshot(test.directory))
            expect(findEntry(midSnapshot, "flush-order-plugin-a", "status")).toBeUndefined()
            yield* Effect.promise(() => Bun.write(midLoadSnapshot, JSON.stringify(midSnapshot)))

            yield* Effect.promise(() => Bun.write(release, "go"))
            const exit = yield* Fiber.await(fiber)
            expect(Exit.isSuccess(exit)).toBe(true)

            const entry = yield* waitForEntry(test.directory, "flush-order-plugin-a", "status")
            expect(entry?.data).toMatchObject({ from: "a" })
          }),
        )
      }),
    { git: true },
    10_000,
  )

  // Uses the file's own `it.live` (not `it.instance`, which only binds ONE ambient directory) so
  // two independently directory-scoped loads can run concurrently via explicit provideInstance(dir)
  // per fiber. testInstanceStoreLayer is provided locally since only `it.instance` wires it
  // automatically; CrossSpawnSpawner (needed by tmpdirScoped) is already in this file's top-level
  // `it` layer (LayerNode.group([Plugin.node, CrossSpawnSpawner.node])), so no extra provide needed.
  it.live(
    "== OQ3c discriminating case == a second directory's pluginsLoaded gate and pending queue stay independent of the first — a module-level gate would incorrectly flush directory B when directory A finishes; RFC 050 D20 (revision 5) widens cross-directory READ visibility, but leaves this WRITE-side gate scoping untouched",
    () =>
      Effect.gen(function* () {
        const dirA = yield* tmpdirScoped({ git: true })
        const dirB = yield* tmpdirScoped({ git: true })

        const release = path.join(dirB, "release.marker")
        const bStarted = path.join(dirB, "b-loading.marker")

        yield* writeProject(dirA, pluginSource("oq3c-plugin-a", `    await input.ui.publish("status", { dir: "a" })`))
        yield* writeProject(
          dirB,
          pluginSource(
            "oq3c-plugin-b",
            [
              `    await input.ui.publish("status", { dir: "b" })`,
              `    await Bun.write(${JSON.stringify(bStarted)}, "loading")`,
              `    while (!(await Bun.file(${JSON.stringify(release)}).exists())) {`,
              `      await new Promise((resolve) => setTimeout(resolve, 20))`,
              `    }`,
            ].join("\n"),
          ),
        )

        // Directory B is forked FIRST so its plugin has already published and is blocking well
        // before directory A (the fast, non-blocking directory) is even started — this specifically
        // rules out a "B just hasn't gotten around to publishing yet" explanation for B's absence
        // below; B's publish has demonstrably already happened by the time A finishes.
        const fiberB = yield* Effect.forkChild(loadDirectory(dirB))
        yield* waitForMarker(bStarted)

        const fiberA = yield* Effect.forkChild(loadDirectory(dirA))
        const exitA = yield* Fiber.await(fiberA)
        expect(Exit.isSuccess(exitA)).toBe(true)

        // Directory A's own entry IS visible — its own loop finished and its own gate resolved.
        const snapshotA = yield* Effect.promise(() => readSnapshot(dirA))
        expect(findEntry(snapshotA, "oq3c-plugin-a", "status")).toMatchObject({ data: { dir: "a" } })
        // NOT a cross-directory READ-isolation check — RFC 050 revision 5's D20 carve-out
        // deliberately widens `GET /plugin-ui/snapshot` to aggregate every directory's store, so
        // read-side isolation is no longer a property this suite can assert in general (see the
        // reconciled assertion below). Plugin B's entry is absent here purely because directory
        // B's own WRITE-side `pluginsLoaded` gate (D15, unchanged by D20) has not yet flushed its
        // queued publish into ANY store — B's `server()` is still blocked on `release`, so nothing
        // has been written for it anywhere yet, regardless of which directory a reader queries.
        expect(findEntry(snapshotA, "oq3c-plugin-b", "status")).toBeUndefined()

        // The core OQ3c assertion: directory A finishing its loop must NOT have flushed directory
        // B's still-queued publish. A module-level `pluginsLoaded` deferred would resolve globally
        // on whichever directory finishes first (A here) and stay resolved — silently delivering
        // B's queued publish the moment A's loop completes, even though B's OWN loop is still
        // in-flight. A correctly per-directory-scoped gate (D15) leaves B's entry absent here — a
        // WRITE-side/init-ordering proof, independent of D20's read-side aggregation (queried via
        // dirA's snapshot precisely so this assertion cannot be satisfied by directory B's own
        // reader having simply not asked yet — the write itself has not happened anywhere).
        const snapshotBBeforeReleaseViaA = yield* Effect.promise(() => readSnapshot(dirA))
        expect(findEntry(snapshotBBeforeReleaseViaA, "oq3c-plugin-b", "status")).toBeUndefined()

        yield* Effect.promise(() => Bun.write(release, "go"))
        const exitB = yield* Fiber.await(fiberB)
        expect(Exit.isSuccess(exitB)).toBe(true)

        // Post-release: B's gate has now resolved and flushed. Two independent things are true
        // simultaneously, and this reconciled assertion proves both rather than the pre-D20
        // "never visible cross-directory" claim that D20 (RFC 050 revision 5) deliberately makes
        // false:
        //   1. WRITE-side attribution is unchanged (D15/D13) — B's entry is attributed to dirB,
        //      not merged or misattributed into dirA's bucket.
        //   2. READ-side visibility is now correctly cross-directory (D20) — a snapshot queried
        //      from EITHER directory returns BOTH entries, each correctly labelled with its own
        //      origin `directory`, because `GET /plugin-ui/snapshot` aggregates every directory
        //      `InstanceState.entries()` currently holds (D20/D21), not only the caller's own.
        const snapshotBAfter = yield* Effect.promise(() => readSnapshot(dirB))
        expect(findEntry(snapshotBAfter, "oq3c-plugin-b", "status")).toMatchObject({ data: { dir: "b" }, directory: dirB })
        expect(findEntry(snapshotBAfter, "oq3c-plugin-a", "status")).toMatchObject({ data: { dir: "a" }, directory: dirA })

        const snapshotAAfter = yield* Effect.promise(() => readSnapshot(dirA))
        expect(findEntry(snapshotAAfter, "oq3c-plugin-b", "status")).toMatchObject({ data: { dir: "b" }, directory: dirB })
        expect(findEntry(snapshotAAfter, "oq3c-plugin-a", "status")).toMatchObject({ data: { dir: "a" }, directory: dirA })
      }).pipe(Effect.provide(testInstanceStoreLayer)),
    15_000,
  )

  it.instance(
    "bounds the pending queue at 16 entries per plugin per directory, oldest-dropped, with a warn log on drop",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const release = path.join(test.directory, "release.marker")
        const publishedAll = path.join(test.directory, "published-all.marker")

        // 20 distinct event names for the SAME pluginID, all issued before the loop can finish
        // (the plugin blocks on `release` afterward) — exceeds the 16-entry cap by 4, so
        // event-0..event-3 (oldest) must be dropped, event-4..event-19 must survive.
        const publishCalls = Array.from({ length: 20 }, (_, index) => `    await input.ui.publish("event-${index}", { index: ${index} })`).join("\n")

        yield* withProject(
          pluginSource(
            "queue-bound-plugin",
            [
              publishCalls,
              `    await Bun.write(${JSON.stringify(publishedAll)}, "done")`,
              `    while (!(await Bun.file(${JSON.stringify(release)}).exists())) {`,
              `      await new Promise((resolve) => setTimeout(resolve, 20))`,
              `    }`,
            ].join("\n"),
          ),
          Effect.gen(function* () {
            const plugin = yield* Plugin.Service
            const fiber = yield* Effect.forkChild(plugin.init())

            yield* waitForMarker(publishedAll)
            // 4 drops expected (20 issued - 16 cap). Loose on exact message shape (unspecified by
            // the RFC beyond "logged at warn"), strict on count.
            expect(warnSpy.mock.calls.length).toBeGreaterThanOrEqual(4)

            yield* Effect.promise(() => Bun.write(release, "go"))
            const exit = yield* Fiber.await(fiber)
            expect(Exit.isSuccess(exit)).toBe(true)

            const snapshot = yield* Effect.promise(() => readSnapshot(test.directory))
            const kept = snapshot.entries.filter((entry) => entry.pluginID === "queue-bound-plugin")
            expect(kept).toHaveLength(16)
            const keptEvents = new Set(kept.map((entry) => entry.event))
            for (let index = 0; index < 4; index++) expect(keptEvents.has(`event-${index}`)).toBe(false)
            for (let index = 4; index < 20; index++) expect(keptEvents.has(`event-${index}`)).toBe(true)
          }),
        )
      }),
    { git: true },
    10_000,
  )
})
