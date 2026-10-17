export * as ConfigSkillPlugin from "./skill.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { Entry } from "@opencode/schema/config"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import path from "path"
import { Cause, Context, Effect, Exit, FiberMap, PubSub, Scope, Stream } from "effect"
import { Config } from "../../config.js"
import { ConfigSkillReload } from "../skill-reload.js"
import { Watcher } from "../../filesystem/watcher.js"
import { Location } from "../../location.js"
import { AbsolutePath } from "../../schema.js"
import { Skill } from "../../skill.js"
import { SkillDiscovery } from "../../skill/discovery.js"
import { SkillFile } from "./skill-file.js"

type Source = Skill.DirectorySource | Skill.UrlSource
type BackgroundResources = {
  readonly configSignals: PubSub.PubSub<void>
  readonly configConsumers: FiberMap.FiberMap<string>
  readonly watcherSignals: PubSub.PubSub<string>
  readonly watcherConsumers: FiberMap.FiberMap<string>
}
type StartupHook = (input: { readonly publishInternalConfigUpdate: () => Effect.Effect<void> }) => Effect.Effect<void>

// This deep-module hook is test-only; production callers only receive the plugin definition.
const backgroundResources = new Set<BackgroundResources>()
export const Test = {
  // The hook is deliberately kept in this deep module so production plugin consumers do not gain a seam.
  startupHooks: Context.Reference("@opencode/ConfigSkillPlugin/Test/startup-hooks", {
    defaultValue: (): StartupHook => () => Effect.void,
  }),
  backgroundStatus: () =>
    Effect.sync(() => Array.from(backgroundResources)).pipe(
      Effect.flatMap((resources) =>
        Effect.forEach(resources, (resource) =>
          Effect.all({
            pendingConfigSignals: PubSub.size(resource.configSignals),
            configAdmissionFibers: FiberMap.size(resource.configConsumers),
            pendingWatcherSignals: PubSub.size(resource.watcherSignals),
            watcherAdmissionFibers: FiberMap.size(resource.watcherConsumers),
          }),
        ),
      ),
    ),
}

export const Plugin = define({
  id: "opencode.config.skill",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const skillReload = yield* ConfigSkillReload.Service
    const discovery = yield* SkillDiscovery.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const watcher = yield* Watcher.Service
    const loaded: { entries: Entry[]; skills: Skill.Info[] } = {
      entries: yield* config.entries(),
      skills: [],
    }
    const changes = yield* PubSub.sliding<string>(1)
    const configUpdates = yield* PubSub.sliding<void>(1)
    const configConsumers = yield* FiberMap.make<string>()
    const watcherConsumers = yield* FiberMap.make<string>()
    const resources = { configSignals: configUpdates, configConsumers, watcherSignals: changes, watcherConsumers }
    yield* Effect.sync(() => backgroundResources.add(resources))
    yield* Effect.addFinalizer(() => Effect.sync(() => backgroundResources.delete(resources)))

    const watch = Effect.fn("ConfigSkillPlugin.watch")(function* (
      watches: FiberMap.FiberMap<string>,
      directory: string,
      type: "file" | "directory",
    ) {
      const target = path.resolve(directory)
      const updates = yield* watcher.subscribe({ path: target, type })
      yield* FiberMap.run(
        watches,
        `${type}:${target}`,
        updates.pipe(Stream.runForEach((update) => PubSub.publish(changes, update.path).pipe(Effect.asVoid))),
        { onlyIfMissing: true, startImmediately: true },
      )
    })

    function firstMissing(target: string): Effect.Effect<string | undefined> {
      const parent = path.dirname(target)
      if (parent === target) return Effect.undefined
      return fs.isDir(parent).pipe(Effect.flatMap((exists) => (exists ? Effect.succeed(target) : firstMissing(parent))))
    }

    const watchDirectory = Effect.fn(
      "ConfigSkillPlugin.watchDirectory",
    )(function* (watches: FiberMap.FiberMap<string>, directory: string): Effect.fn.Return<string[]> {
      const target = path.resolve(directory)
      const resolved = yield* fs.realPath(directory).pipe(Effect.orElseSucceed(() => undefined))
      if (resolved) {
        yield* watch(watches, resolved, "directory")
        if (resolved !== target) yield* watch(watches, target, "file")
        return resolved === target ? [target] : [target, resolved]
      }
      const missing = yield* firstMissing(target)
      if (missing) yield* watch(watches, missing, "file")
      if (
        yield* fs.realPath(directory).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        )
      ) {
        if (missing) yield* FiberMap.remove(watches, `file:${path.resolve(missing)}`)
        return yield* watchDirectory(watches, directory)
      }
      return [target]
    })

    const sources = (entries: Entry[]) => {
      const result: Source[] = []
      const add = (source: Source) => {
        if (result.some((item) => Skill.Source.equals(item, source))) return
        result.push(source)
      }
      const directories = entries.flatMap((entry) => (entry.type === "directory" ? [entry.path] : []))
      const items = entries.flatMap((entry) => (entry.type === "document" ? (entry.info.skills ?? []) : []))
      for (const directory of directories) {
        add(Skill.DirectorySource.make({ type: "directory", path: AbsolutePath.make(path.join(directory, "skill")) }))
        add(Skill.DirectorySource.make({ type: "directory", path: AbsolutePath.make(path.join(directory, "skills")) }))
      }
      for (const item of items) {
        if (URL.canParse(item) && /^(https?:)$/.test(new URL(item).protocol)) {
          add(Skill.UrlSource.make({ type: "url", url: item }))
          continue
        }
        const expanded = item.startsWith("~/") ? path.join(global.home, item.slice(2)) : item
        add(
          Skill.DirectorySource.make({
            type: "directory",
            path: AbsolutePath.make(path.isAbsolute(expanded) ? expanded : path.join(location.directory, expanded)),
          }),
        )
      }
      return result
    }
    const sameSources = (left: Entry[], right: Entry[]) => {
      const previous = sources(left)
      const current = sources(right)
      return previous.length === current.length && previous.every((source) => current.some((item) => Skill.Source.equals(item, source)))
    }

    const load = Effect.fn("ConfigSkillPlugin.load")(function* (watches: FiberMap.FiberMap<string>, source: Source) {
      const directories =
          source.type === "directory"
            ? [source.path]
          : yield* discovery.pull(source.url).pipe(Effect.catch(Effect.die))
      const roots = (yield* Effect.forEach(directories, (directory) => watchDirectory(watches, directory))).flat()
      const skills: Skill.Info[] = []
      for (const directory of directories) {
        const files = yield* fs
          .scan("{*.md,**/SKILL.md}", { cwd: directory, absolute: true, include: "file", symlink: true, dot: true })
          .pipe(Effect.orElseSucceed(() => [] as string[]))
        for (const filepath of files.toSorted()) {
          const resolved = yield* fs.realPath(filepath).pipe(Effect.orElseSucceed(() => filepath))
          if (typeof resolved !== "string") continue
          if (!roots.some((root) => FSUtil.contains(root, resolved)))
            yield* watch(watches, path.dirname(resolved), "directory")
          const content = yield* fs.readFileStringSafe(filepath).pipe(Effect.orElseSucceed(() => undefined))
          if (!content) continue
          const parsed = SkillFile.parse(directory, filepath, content)
          if (parsed._tag === "Skipped") {
            yield* Effect.logDebug("skill file skipped", {
              filepath,
              reason: parsed.reason,
              ...(parsed.reason === "frontmatter" ? { issue: parsed.issue } : {}),
            })
            continue
          }
          skills.push(parsed.skill)
        }
      }
      yield* Effect.logDebug("skill source loaded", {
        source: Skill.Source.key(source),
        type: source.type,
        directories,
        skills: skills.map((skill) => skill.id),
      })
      return skills
    })

    let watchScope = yield* Scope.make()
    yield* FiberMap.make<string>().pipe(Scope.provide(watchScope))
    yield* ctx.skill.transform((editor) => {
      for (const skill of loaded.skills) editor.add(skill)
    })
    const refresh = Effect.fn("ConfigSkillPlugin.refresh")(function* (mode: "initial" | "reload") {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          let transferred = false
          const candidateScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
            transferred ? Effect.void : Scope.close(scope, Exit.void),
          )
          const candidateWatches = yield* FiberMap.make<string>().pipe(Scope.provide(candidateScope))
          const entries = yield* config.entries()
          const skills = new Map<Skill.ID, Skill.Info>()
          const current = sources(entries)
          const scan = Effect.forEach(current, (source) =>
            load(candidateWatches, source).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.failCause(cause)
                  : Effect.logWarning("failed to load skill source", { source: Skill.Source.key(source), cause }).pipe(
                      // A source boundary may report a defect-shaped failure. It is still an
                      // expected discovery failure before commit; notification failures are not.
                      Effect.andThen(mode === "initial" ? Effect.succeed([]) : Effect.fail(new ConfigSkillReload.ReloadFailed({ cause }))),
                    ),
              ),
            ).pipe(Effect.tap((items) => Effect.sync(() => items.forEach((skill) => skills.set(skill.id, skill))))),
          )
          yield* scan
          const previousScope = yield* Effect.uninterruptible(
            Effect.sync(() => {
              const previous = watchScope
              watchScope = candidateScope
              loaded.entries = entries
              loaded.skills = Array.from(skills.values())
              transferred = true
              return previous
            }),
          )
          yield* ctx.skill.reload().pipe(Effect.ensuring(Scope.close(previousScope, Exit.void)))
          return { count: loaded.skills.length }
        }),
      )
    })
    let reconcile = () => Effect.void
    const installationScope = yield* Scope.make()
    const registration = yield* skillReload.install(
      (mode) => refresh(mode).pipe(Effect.tap(() => reconcile())),
      { initial: true, release: () => Scope.close(watchScope, Exit.void) },
    ).pipe(Scope.provide(installationScope))
    yield* Effect.addFinalizer(() => Scope.close(installationScope, Exit.void))
    reconcile = () =>
      Effect.gen(function* () {
        const entries = yield* config.entries()
        if (sameSources(loaded.entries, entries)) return
        yield* registration.invalidate()
      })

    // Editor saves arrive as bursts of watcher events; settle before one non-waiting admission.
    const updates = yield* PubSub.subscribe(changes)
    yield* FiberMap.run(
      watcherConsumers,
      "watcher-signals",
      Stream.fromSubscription(updates).pipe(Stream.debounce("100 millis"), Stream.runForEach(() => registration.invalidate())),
      { onlyIfMissing: true, startImmediately: true },
    )
    const configSignals = yield* PubSub.subscribe(configUpdates)
    const startupHook = yield* Test.startupHooks
    yield* startupHook({ publishInternalConfigUpdate: () => PubSub.publish(configUpdates, undefined).pipe(Effect.asVoid) })
    yield* FiberMap.run(
      configConsumers,
      "config-signals",
      Stream.fromSubscription(configSignals).pipe(Stream.runForEach(() => registration.invalidate())),
      { onlyIfMissing: true, startImmediately: true },
    )
    yield* ctx.event.subscribe().pipe(
      Stream.filter((event) => event.type === "config.updated"),
      Stream.runForEach(() => PubSub.publish(configUpdates, undefined).pipe(Effect.asVoid)),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* registration.initial.pipe(
      Effect.catch((error) => Effect.logWarning("failed to activate skill source", { error })),
      Effect.asVoid,
    )
  }),
})
