/**
 * @spec-handoff
 * @interface ConfigSkillReload.Service.reload(): Effect<{ count: number }, ReloadUnavailable | ReloadFailed>
 * @behavior
 *   - The location-scoped public reload trigger atomically rescans configured local and URL skill sources.
 *   - Watcher, explicit, and config reload requests share one refresh lifecycle and publish only complete snapshots.
 *   - Initial activation keeps successfully scanned local skills when a URL source fails.
 *   - A failed later reload retains the previous complete snapshot and emits no update event.
 *   - Public reload reports the committed replacement generation's count, not the prior generation's count.
 *   - Rapid public reload calls coalesce to at most one active refresh plus one queued refresh.
 * @edge-cases
 *   - Captured prior snapshots remain immutable while a replacement source scan is blocked.
 *   - Only one reload owner is active; closing it permits reinstall without a stale close removing the newer owner.
 */
import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Logger, Schema, Scope, Stream } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import { Config } from "@opencode/core/config"
import { Directory, Document, type Entry, Event, Info } from "@opencode/schema/config"
import { ConfigSkillPlugin } from "@opencode/core/config/plugin/skill"
import { ConfigSkillReload } from "@opencode/core/config/skill-reload"
import { ConfigCompatibilityPlugin } from "@opencode/core/config/plugin/compatibility"
import { SkillFile } from "@opencode/core/config/plugin/skill-file"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Bus } from "@opencode/core/bus"
import { Credential } from "@opencode/core/credential"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Skill } from "@opencode/core/skill"
import { SkillDiscovery } from "@opencode/core/skill/discovery"
import { WellKnown } from "@opencode/core/wellknown"
import { emptyCredentialNode, emptyWellknownNode } from "../fixture/config-nodes"
import { tmpdir } from "../fixture/tmpdir"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const emptyDiscovery = SkillDiscovery.Service.of({ pull: () => Effect.succeed([]) })
const watcherLayer = Watcher.testLayer
const reloadLocation = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/tmp/config-skill-reload") })),
)
const it = testEffect(
  Layer.merge(
    AppNodeBuilder.build(LayerNode.group([Skill.node, Bus.node, FSUtil.node, ConfigSkillReload.node, SkillDiscovery.node]), [
      Location.node.replace(reloadLocation),
    ]),
    watcherLayer,
  ),
)
const decode = Schema.decodeUnknownSync(Info)

function write(directory: string, name: string, description: string) {
  return fs.writeFile(
    path.join(directory, name, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---
# ${name}`,
  )
}

const startEntries = Effect.fnUntraced(function* (
  entries: Entry[],
  directory: string,
  home = directory,
  discovery = emptyDiscovery,
  compatibility: { readonly claude: readonly AbsolutePath[]; readonly agents: readonly AbsolutePath[] } = {
    claude: [],
    agents: [],
  },
  events: Plugin.Context["event"] = { subscribe: () => Stream.empty },
) {
  const service = yield* Skill.Service
  const pluginHost = host({
    event: events,
    skill: {
      list: () => Effect.die("unused skill.list"),
      transform: service.transform,
      reload: service.reload,
    },
  })
  yield* ConfigCompatibilityPlugin.Plugin.effect(pluginHost)
  yield* ConfigSkillPlugin.Plugin.effect(pluginHost).pipe(
    Effect.provideService(SkillDiscovery.Service, discovery),
    Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), home })),
    Effect.provideService(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
  )
  return service
})

const startConfiguredEntries = (
  entries: Entry[],
  directory: string,
  home = directory,
  discovery = emptyDiscovery,
  compatibility: { readonly claude: readonly AbsolutePath[]; readonly agents: readonly AbsolutePath[] } = {
    claude: [],
    agents: [],
  },
  events: Plugin.Context["event"] = { subscribe: () => Stream.empty },
) =>
  startEntries(entries, directory, home, discovery, compatibility, events).pipe(
    Effect.provide(Config.testLayer(entries, compatibility)),
  )

const start = (skills: string[], directory: string, discovery = emptyDiscovery) =>
  startConfiguredEntries(
    [
      new Document({
        type: "document",
        info: decode({ skills }),
      }),
    ],
    directory,
    directory,
    discovery,
  )

const discover = (directory: string, global: string) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    return { entries: yield* config.entries(), compatibility: yield* config.compatibility!() }
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node]), [
        Location.node.replace(
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
        ),
        Global.node.replace(Global.layerWith({ config: global, home: path.join(global, "home") })),
        Credential.node.replace(emptyCredentialNode),
        WellKnown.node.replace(emptyWellknownNode),
        Watcher.node.replace(Watcher.testLayer),
      ]),
    ),
  )

function emitAndWait(update: Watcher.Update) {
  return Effect.gen(function* () {
    const watcher = yield* Watcher.Test
    const bus = yield* Bus.Service
    const deferred = yield* Deferred.make<void>()
    const fiber = yield* bus.subscribe(Skill.Event.Updated).pipe(
      Stream.runForEach(() => Deferred.succeed(deferred, undefined).pipe(Effect.asVoid)),
      Effect.forkScoped,
    )
    yield* Effect.yieldNow
    yield* watcher.emit(update)
    yield* Deferred.await(deferred).pipe(Effect.timeout("2 seconds"))
    yield* Fiber.interrupt(fiber)
  })
}

const waitForSkills = Effect.fnUntraced(function* (service: Skill.Interface, descriptions: string[]) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = yield* service.list()
    if (
      current.length === descriptions.length &&
      current.every((skill) => skill.description !== undefined && descriptions.includes(skill.description))
    )
      return
    yield* Effect.sleep("10 millis")
  }
  return yield* Effect.die("Timed out waiting for the complete replacement skill catalog")
})

describe("SkillFile.parse", () => {
  test("reads disable-model-invocation as autoinvoke", () => {
    const parse = (frontmatter: string) =>
      SkillFile.parse("/repo/skills", "/repo/skills/deploy/SKILL.md", `---\n${frontmatter}\n---\n# deploy`)
    expect(parse("disable-model-invocation: true")).toMatchObject({ skill: { autoinvoke: false } })
    expect(parse("disable-model-invocation: yes")).toMatchObject({ skill: { autoinvoke: false } })
    expect(parse("disable-model-invocation: false")).not.toMatchObject({ skill: { autoinvoke: expect.anything() } })
    expect(parse("disable-model-invocation: maybe")).not.toMatchObject({ skill: { autoinvoke: expect.anything() } })
    expect(parse("disable-model-invocation: true\nmetadata:\n  opencode/autoinvoke: true")).toMatchObject({
      skill: { autoinvoke: true },
    })
  })

  test("parses root and nested skill ids and metadata flags", () => {
    const directory = "/repo/skills"
    expect(
      SkillFile.parse(
        directory,
        "/repo/skills/manual/SKILL.md",
        `---
name: Manual
description: Manual only
metadata:
  opencode/autoinvoke: false
---
# manual`,
      ),
    ).toEqual({
      _tag: "Parsed",
      skill: {
        id: Skill.ID.make("manual"),
        name: Skill.Name.make("Manual"),
        description: "Manual only",
        autoinvoke: false,
        path: AbsolutePath.make("/repo/skills/manual/SKILL.md"),
        content: "# manual",
      },
    })
    expect(SkillFile.parse(directory, "/repo/skills/foo.md", "# foo")).toMatchObject({
      _tag: "Parsed",
      skill: { id: Skill.ID.make("foo") },
    })
    expect(SkillFile.parse("/repo/skills/manual", "/repo/skills/manual/SKILL.md", "# manual")).toMatchObject({
      _tag: "Parsed",
      skill: { id: Skill.ID.make("manual"), name: Skill.Name.make("manual") },
    })
    expect(
      SkillFile.parse(directory, "/repo/skills/broken.md", "---\ndescription: foo: bar\nmetadata: [\n---\n# broken"),
    ).toEqual({ _tag: "Skipped", reason: "markdown" })
  })
})

describe("ConfigSkillPlugin.Plugin", () => {
  it.live(
    "keeps a captured catalog visible while a public reload is blocked then publishes the complete replacement",
    () =>
      Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
        Effect.flatMap((tmp) =>
          Effect.gen(function* () {
            const local = path.join(tmp.path, "local")
            const remote = path.join(tmp.path, "remote")
            const url = "https://skills.example.test/catalog"
            const started = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            let reload = false
            yield* Effect.promise(async () => {
              await fs.mkdir(path.join(local, "local"), { recursive: true })
              await fs.mkdir(path.join(remote, "remote"), { recursive: true })
              await write(local, "local", "Local before reload")
              await write(remote, "remote", "Remote before reload")
            })

            const bus = yield* Bus.Service
            const discovery = SkillDiscovery.Service.of({
              pull: () =>
                reload
                  ? Deferred.succeed(started, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.as([AbsolutePath.make(remote)]),
                    )
                  : Effect.succeed([AbsolutePath.make(remote)]),
            })
            const service = yield* startConfiguredEntries(
              [new Document({ type: "document", info: decode({ skills: [local, url] }) })],
              tmp.path,
              tmp.path,
              discovery,
              undefined,
              { subscribe: () => bus.subscribe(Event.Updated) },
            )
            const captured = yield* service.list()
            yield* Effect.promise(async () => {
              await write(local, "local", "Local after reload")
              await write(remote, "remote", "Remote after reload")
            })

            reload = true
            yield* bus.publish(Event.Updated, {})
            yield* Deferred.await(started).pipe(Effect.timeout("1 second"))
            expect(yield* service.list()).toEqual(captured)
            expect(captured.map((skill) => skill.description)).toEqual(["Local before reload", "Remote before reload"])

            yield* Deferred.succeed(release, undefined)
            yield* waitForSkills(service, ["Local after reload", "Remote after reload"])
            expect(yield* service.list()).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ description: "Local after reload" }),
                expect.objectContaining({ description: "Remote after reload" }),
              ]),
            )
          }),
        ),
      ),
  )

  it.live(
    "keeps the committed catalog and returns ReloadFailed when the real remote index starts returning HTTP 404",
    () =>
      Effect.acquireRelease(
        Effect.sync(() => {
          let unavailable = false
          const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
              const url = new URL(request.url)
              if (url.pathname === "/catalog/index.json") {
                if (unavailable) return new Response("Not Found", { status: 404 })
                return Response.json({ skills: [{ name: "remote", files: ["SKILL.md"] }] })
              }
              if (url.pathname === "/catalog/remote/SKILL.md")
                return new Response("---\nname: remote\ndescription: Remote catalog\n---\n# Remote")
              return new Response("Not Found", { status: 404 })
            },
          })
          return { server, fail: () => (unavailable = true) }
        }),
        ({ server }) => Effect.promise(() => server.stop(true)),
      ).pipe(
        Effect.flatMap(({ server, fail }) =>
          Effect.gen(function* () {
            const local = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir()))
            const bus = yield* Bus.Service
            const discovery = yield* SkillDiscovery.Service
            const service = yield* startConfiguredEntries(
              [new Document({ type: "document", info: decode({ skills: [server.url.href + "catalog/"] }) })],
              local.path,
              local.path,
              discovery,
              undefined,
              { subscribe: () => bus.subscribe(Event.Updated) },
            )
            const published = yield* Deferred.make<void>()
            const subscription = yield* bus.subscribe(Skill.Event.Updated).pipe(
              Stream.runForEach(() => Deferred.succeed(published, undefined).pipe(Effect.asVoid)),
              Effect.forkScoped,
            )
            expect((yield* service.list()).map((skill) => skill.id)).toEqual([Skill.ID.make("remote")])
            fail()
            const failed = yield* (yield* ConfigSkillReload.Service).reload().pipe(Effect.flip)
            expect(failed._tag).toBe("ConfigSkillReload.ReloadFailed")
            expect((yield* service.list()).map((skill) => skill.id)).toEqual([Skill.ID.make("remote")])
            expect(yield* Deferred.await(published).pipe(Effect.timeout("100 millis"), Effect.exit)).toSatisfy(Exit.isFailure)
            yield* Fiber.interrupt(subscription)
          }),
        ),
      ),
  )

  it.live("returns the newly committed catalog size from public reload", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const first = path.join(tmp.path, "first")
          const second = path.join(tmp.path, "second")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(first, "one"), { recursive: true })
            await fs.mkdir(path.join(second, "one"), { recursive: true })
            await fs.mkdir(path.join(second, "two"), { recursive: true })
            await write(first, "one", "One")
            await write(second, "one", "One")
            await write(second, "two", "Two")
          })
          let next = first
          const service = yield* start(["https://skills.example.test/catalog"], tmp.path, SkillDiscovery.Service.of({
            pull: () => Effect.sync(() => [AbsolutePath.make(next)]),
          }))
          expect((yield* service.list())).toHaveLength(1)
          next = second
          expect(yield* (yield* ConfigSkillReload.Service).reload()).toEqual({ count: 2 })
          expect(yield* service.list()).toHaveLength(2)
        }),
      ),
    ),
  )

  it.live("coalesces a rapid public reload burst into no more than one active and one queued refresh", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const remote = path.join(tmp.path, "remote")
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          let pulls = 0
          let block = false
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(remote, "remote"), { recursive: true })
            await write(remote, "remote", "Remote")
          })
          const service = yield* start(["https://skills.example.test/catalog"], tmp.path, SkillDiscovery.Service.of({
            pull: () =>
              Effect.sync(() => ++pulls).pipe(
                Effect.andThen(block ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void),
                Effect.as([AbsolutePath.make(remote)]),
              ),
          }))
          block = true
          const reload = yield* ConfigSkillReload.Service
          const first = yield* reload.reload().pipe(Effect.forkScoped)
          yield* Deferred.await(entered)
          const second = yield* reload.reload().pipe(Effect.forkScoped)
          const third = yield* reload.reload().pipe(Effect.forkScoped)
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(first)
          yield* Fiber.join(second)
          yield* Fiber.join(third)
          expect(pulls).toBeLessThanOrEqual(3) // initial activation plus one active and one queued reload
          expect(yield* service.list()).toHaveLength(1)
        }),
      ),
    ),
  )

  it.live(
    "retains the complete published catalog and does not publish when an explicit reload cannot fetch a required URL source",
    () =>
      Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
        Effect.flatMap((tmp) =>
          Effect.gen(function* () {
            const local = path.join(tmp.path, "local")
            const remote = path.join(tmp.path, "remote")
            const url = "https://skills.example.test/catalog"
            yield* Effect.promise(async () => {
              await fs.mkdir(path.join(local, "local"), { recursive: true })
              await fs.mkdir(path.join(remote, "remote"), { recursive: true })
              await write(local, "local", "Local before reload")
              await write(remote, "remote", "Remote before reload")
            })

            const bus = yield* Bus.Service
            let unavailable = false
            const discovery = SkillDiscovery.Service.of({
              pull: () =>
                unavailable
                  ? Effect.die(new Error("required skill catalog is unavailable"))
                  : Effect.succeed([AbsolutePath.make(remote)]),
            })
            const service = yield* startConfiguredEntries(
              [new Document({ type: "document", info: decode({ skills: [local, url] }) })],
              tmp.path,
              tmp.path,
              discovery,
              undefined,
              { subscribe: () => bus.subscribe(Event.Updated) },
            )
            const captured = yield* service.list()
            const skillReload = yield* ConfigSkillReload.Service
            expect(captured.map((skill) => skill.description)).toEqual(["Local before reload", "Remote before reload"])

            yield* Effect.promise(() => write(local, "local", "Local candidate must not leak"))
            unavailable = true
            const published = yield* Deferred.make<void>()
            const publication = yield* bus.subscribe(Skill.Event.Updated).pipe(
              Stream.take(1),
              Stream.runForEach(() => Deferred.succeed(published, undefined).pipe(Effect.asVoid)),
              Effect.forkScoped,
            )
            yield* Effect.yieldNow
            const failure = yield* skillReload.reload().pipe(Effect.flip)
            expect(failure._tag).toBe("ConfigSkillReload.ReloadFailed")
            const update = yield* Deferred.await(published).pipe(Effect.timeout("100 millis"), Effect.exit)
            expect(Exit.isFailure(update)).toBe(true)

            expect(yield* service.list()).toEqual(captured)
            expect(captured.map((skill) => skill.description)).toEqual(["Local before reload", "Remote before reload"])
            yield* Fiber.interrupt(publication)
          }),
        ),
      ),
  )

  it.live("propagates an interrupted explicit reload without publishing or replacing the prior catalog", () => {
    const logs: unknown[] = []
    const logger = Logger.make((entry) => logs.push(entry.message))
    return Effect.acquireDisposable(Effect.promise(() => tmpdir()))
      .pipe(
        Effect.flatMap((tmp) =>
          Effect.gen(function* () {
            const local = path.join(tmp.path, "local")
            const remote = path.join(tmp.path, "remote")
            const url = "https://skills.example.test/catalog"
            const started = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            let blocked = false
            yield* Effect.promise(async () => {
              await fs.mkdir(path.join(local, "local"), { recursive: true })
              await fs.mkdir(path.join(remote, "remote"), { recursive: true })
              await write(local, "local", "Local before interruption")
              await write(remote, "remote", "Remote before interruption")
            })

            const bus = yield* Bus.Service
            const discovery = SkillDiscovery.Service.of({
              pull: () =>
                blocked
                  ? Deferred.succeed(started, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.andThen(Effect.interrupt),
                      Effect.as([AbsolutePath.make(remote)]),
                    )
                  : Effect.succeed([AbsolutePath.make(remote)]),
            })
            const service = yield* startConfiguredEntries(
              [new Document({ type: "document", info: decode({ skills: [local, url] }) })],
              tmp.path,
              tmp.path,
              discovery,
              undefined,
              { subscribe: () => bus.subscribe(Event.Updated) },
            )
            const captured = yield* service.list()
            const skillReload = yield* ConfigSkillReload.Service
            const published = yield* Deferred.make<void>()
            const publication = yield* bus.subscribe(Skill.Event.Updated).pipe(
              Stream.take(1),
              Stream.runForEach(() => Deferred.succeed(published, undefined).pipe(Effect.asVoid)),
              Effect.forkScoped,
            )
            yield* Effect.yieldNow

            blocked = true
            const reload = yield* skillReload.reload().pipe(Effect.forkScoped)
            yield* Deferred.await(started).pipe(Effect.timeout("1 second"))
            yield* Deferred.succeed(release, undefined)
            const interrupted = yield* Fiber.await(reload)
            expect(Exit.isFailure(interrupted)).toBe(true)
            if (Exit.isFailure(interrupted)) expect(Cause.hasInterrupts(interrupted.cause)).toBe(true)
            expect(yield* service.list()).toEqual(captured)
            expect(yield* Deferred.await(published).pipe(Effect.timeout("100 millis"), Effect.exit)).toSatisfy(
              Exit.isFailure,
            )
            expect(JSON.stringify(logs)).not.toContain("failed to load skill source")
            expect(JSON.stringify(logs)).not.toContain("failed to reload skills")

            blocked = false
            expect(yield* skillReload.reload()).toEqual({ count: captured.length })
            yield* Deferred.await(published).pipe(Effect.timeout("1 second"))
            expect(yield* service.list()).toEqual(captured)
            yield* Fiber.interrupt(publication)
          }),
        ),
      )
      .pipe(Effect.provide(Logger.layer([logger])))
  })

  it.live("rejects a duplicate active reload installation", () =>
    Effect.gen(function* () {
      const reload = yield* ConfigSkillReload.Service
      yield* reload.install(() => Effect.succeed({ count: 1 }))

      const duplicate = yield* reload.install(() => Effect.succeed({ count: 2 })).pipe(Effect.exit)
      expect(Exit.isFailure(duplicate)).toBe(true)
      expect(yield* reload.reload()).toEqual({ count: 1 })
    }),
  )

  it.live("permits reinstall after the active reload installation closes", () =>
    Effect.gen(function* () {
      const reload = yield* ConfigSkillReload.Service
      const first = yield* Scope.make()
      yield* reload.install(() => Effect.succeed({ count: 1 })).pipe(Scope.provide(first))

      yield* Scope.close(first, Exit.void)
      const second = yield* Scope.make()
      yield* reload.install(() => Effect.succeed({ count: 2 })).pipe(Scope.provide(second))

      expect(yield* reload.reload()).toEqual({ count: 2 })
      yield* Scope.close(second, Exit.void)
    }),
  )

  it.live("does not let a stale activation finalizer clear a newer reload owner", () =>
    Effect.gen(function* () {
      const reload = yield* ConfigSkillReload.Service
      const old = yield* Scope.make()
      yield* reload.install(() => Effect.succeed({ count: 1 })).pipe(Scope.provide(old))
      yield* Scope.close(old, Exit.void)

      const current = yield* Scope.make()
      yield* reload.install(() => Effect.succeed({ count: 2 })).pipe(Scope.provide(current))
      yield* Scope.close(old, Exit.void)

      expect(yield* reload.reload()).toEqual({ count: 2 })
      yield* Scope.close(current, Exit.void)
    }),
  )

  it.live("returns ReloadUnavailable after the final reload installation closes", () =>
    Effect.gen(function* () {
      const reload = yield* ConfigSkillReload.Service
      const scope = yield* Scope.make()
      yield* reload.install(() => Effect.succeed({ count: 1 })).pipe(Scope.provide(scope))
      yield* Scope.close(scope, Exit.void)

      const unavailable = yield* reload.reload().pipe(Effect.flip)
      expect(unavailable._tag).toBe("ConfigSkillReload.ReloadUnavailable")
    }),
  )

  it.live("serializes overlapping public, watcher, and config reload requests through one lifecycle", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        const local = path.join(tmp.path, "local")
        const remote = path.join(tmp.path, "remote")
        const url = "https://skills.example.test/catalog"
        const entries = [new Document({ type: "document", info: decode({ skills: [local, url] }) })]
        return Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          let active = 0
          let maxActive = 0
          let blocked = false
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(local, "local"), { recursive: true })
            await fs.mkdir(path.join(remote, "remote"), { recursive: true })
            await write(local, "local", "Local")
            await write(remote, "remote", "Remote")
          })
          const bus = yield* Bus.Service
          const discovery = SkillDiscovery.Service.of({
            pull: () =>
              Effect.sync(() => {
                active++
                maxActive = Math.max(maxActive, active)
              }).pipe(
                Effect.andThen(
                  blocked
                    ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
                    : Effect.void,
                ),
                Effect.ensuring(Effect.sync(() => active--)),
                Effect.as([AbsolutePath.make(remote)]),
              ),
          })
          const service = yield* startEntries(entries, tmp.path, tmp.path, discovery, undefined, {
            subscribe: () => bus.subscribe(Event.Updated),
          })
          const config = yield* Config.Test
          blocked = true
          const watcher = yield* Watcher.Test
          yield* watcher.emit({ type: "update", path: path.join(local, "local", "SKILL.md") })
          yield* bus.publish(Event.Updated, {})
          yield* config.emitChange({ type: "update", path: path.join(local, "local", "SKILL.md") })
          yield* Deferred.await(started).pipe(Effect.timeout("1 second"))
          expect(maxActive).toBe(1)
          yield* Deferred.succeed(release, undefined)
          yield* Effect.sleep("250 millis")
          expect(maxActive).toBe(1)
          expect((yield* service.list()).map((skill) => skill.id)).toEqual([
            Skill.ID.make("local"),
            Skill.ID.make("remote"),
          ])
        }).pipe(Effect.provide(Config.testLayer(entries)))
      }),
    ),
  )

  it.live("maps config entry types to skill directories", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const claude = path.join(tmp.path, "claude")
          const agents = path.join(tmp.path, "agents")
          const opencode = path.join(tmp.path, "opencode")
          const home = path.join(tmp.path, "home")
          const directory = path.join(tmp.path, "project")
          const expected = [
            path.join(claude, "skills"),
            path.join(agents, "skills"),
            path.join(opencode, "skill"),
            path.join(opencode, "skills"),
            path.join(home, "shared"),
            path.join(directory, "relative"),
          ]
          yield* Effect.promise(() => Promise.all(expected.map((item) => fs.mkdir(item, { recursive: true }))))

          yield* startConfiguredEntries(
            [
              new Directory({ type: "directory", path: AbsolutePath.make(opencode) }),
              new Document({ type: "document", info: decode({ skills: ["~/shared", "./relative"] }) }),
            ],
            directory,
            home,
            emptyDiscovery,
            { claude: [AbsolutePath.make(claude)], agents: [AbsolutePath.make(agents)] },
          )
          const watcher = yield* Watcher.Test
          expect(yield* watcher.subscriptions()).toEqual(expected.map((item) => ({ path: item, type: "directory" })))
        }),
      ),
    ),
  )

  it.live("loads directory and individual downloaded skill roots with later-source precedence", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const first = path.join(tmp.path, "first")
          const second = path.join(tmp.path, "second")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(first, "review"), { recursive: true })
            await fs.mkdir(path.join(second, "deploy"), { recursive: true })
            await fs.mkdir(path.join(second, "review"), { recursive: true })
            await write(first, "review", "First")
            await write(second, "deploy", "Deploy")
            await write(second, "review", "Second")
          })
          const pulls: string[] = []
          const discovery = SkillDiscovery.Service.of({
            pull: (url) => {
              pulls.push(url)
              return Effect.succeed([
                AbsolutePath.make(path.join(second, "deploy")),
                AbsolutePath.make(path.join(second, "review")),
              ])
            },
          })

          const skill = yield* start([first, "https://example.test/skills/"], tmp.path, discovery)
          expect((yield* skill.list()).map((item) => item.id).toSorted()).toEqual([
            Skill.ID.make("deploy"),
            Skill.ID.make("review"),
          ])
          expect((yield* skill.list()).find((item) => item.id === "deploy")?.description).toBe("Deploy")
          expect((yield* skill.list()).find((item) => item.id === "review")?.description).toBe("Second")
          expect(pulls).toEqual(["https://example.test/skills/"])
        }),
      ),
    ),
  )

  it.live("prefers a worktree skill over the parent checkout copy", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const checkout = path.join(tmp.path, "repo")
          const worktree = path.join(checkout, ".worktrees", "feature")
          const parentSkills = path.join(checkout, ".agents", "skills")
          const worktreeSkills = path.join(worktree, ".agents", "skills")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(checkout, ".git"), { recursive: true })
            await fs.mkdir(path.join(parentSkills, "review"), { recursive: true })
            await fs.mkdir(path.join(worktreeSkills, "review"), { recursive: true })
            await fs.writeFile(path.join(worktree, ".git"), "gitdir: ../../../.git/worktrees/feature\n")
            await write(parentSkills, "review", "Parent checkout")
            await write(worktreeSkills, "review", "Worktree")
          })

          const discovered = yield* discover(worktree, path.join(tmp.path, "global"))
          const skill = yield* startConfiguredEntries(
            discovered.entries,
            worktree,
            worktree,
            emptyDiscovery,
            discovered.compatibility,
          )
          const review = (yield* skill.list()).find((item) => item.id === "review")

          expect(review?.description).toBe("Worktree")
          expect(review?.path).toBe(AbsolutePath.make(path.join(worktreeSkills, "review", "SKILL.md")))
        }),
      ),
    ),
  )

  it.live("keeps directory skills when a URL source fails", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "review"), { recursive: true })
            await write(tmp.path, "review", "Available")
          })
          const url = "https://unreachable.example.test/skills/"
          const discovery = SkillDiscovery.Service.of({ pull: () => Effect.die(`failed to pull ${url}`) })

          const skill = yield* start([tmp.path, url], tmp.path, discovery)
          expect((yield* skill.list()).find((item) => item.id === "review")?.description).toBe("Available")
        }),
      ),
    ),
  )

  it.live("rescans directory sources when watched files change", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "deploy"), { recursive: true })
            await write(tmp.path, "deploy", "Initial")
          })
          const skill = yield* start([tmp.path], tmp.path)
          expect((yield* skill.list()).find((item) => item.id === "deploy")?.description).toBe("Initial")

          const deploy = path.join(tmp.path, "deploy", "SKILL.md")
          yield* Effect.promise(() => write(tmp.path, "deploy", "Updated"))
          yield* emitAndWait({ type: "update", path: deploy })
          expect((yield* skill.list()).find((item) => item.id === "deploy")?.description).toBe("Updated")

          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "review"), { recursive: true })
            await write(tmp.path, "review", "Review")
          })
          yield* emitAndWait({ type: "create", path: path.join(tmp.path, "review", "SKILL.md") })
          expect((yield* skill.list()).map((item) => item.id)).toEqual([
            Skill.ID.make("deploy"),
            Skill.ID.make("review"),
          ])

          yield* Effect.promise(() => fs.rm(path.join(tmp.path, "review"), { recursive: true }))
          yield* emitAndWait({ type: "delete", path: path.join(tmp.path, "review", "SKILL.md") })
          expect((yield* skill.list()).map((item) => item.id)).toEqual([Skill.ID.make("deploy")])
        }),
      ),
    ),
  )

  it.live("watches canonical directories behind symlinked skills", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const source = path.join(tmp.path, "source")
          const target = path.join(tmp.path, "target", "bro")
          const file = path.join(target, "SKILL.md")
          yield* Effect.promise(async () => {
            await fs.mkdir(source, { recursive: true })
            await fs.mkdir(target, { recursive: true })
            await fs.writeFile(file, "---\nname: bro\ndescription: Initial\n---\n# bro")
            await fs.symlink(target, path.join(source, "bro"), process.platform === "win32" ? "junction" : undefined)
          })

          const skill = yield* start([source], tmp.path)
          const watcher = yield* Watcher.Test
          expect((yield* skill.list()).find((item) => item.id === "bro")?.description).toBe("Initial")
          expect(yield* watcher.subscriptions()).toContainEqual({ path: target, type: "directory" })

          yield* Effect.promise(() => fs.writeFile(file, "---\nname: bro\ndescription: Updated\n---\n# bro"))
          yield* emitAndWait({ type: "update", path: file })
          expect((yield* skill.list()).find((item) => item.id === "bro")?.description).toBe("Updated")
        }),
      ),
    ),
  )

  it.live("reloads symlinked sources when their target changes", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const source = path.join(tmp.path, "source")
          const first = path.join(tmp.path, "first")
          const second = path.join(tmp.path, "second")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(first, "bro"), { recursive: true })
            await fs.mkdir(path.join(second, "bro"), { recursive: true })
            await write(first, "bro", "First")
            await write(second, "bro", "Second")
            await fs.symlink(first, source, process.platform === "win32" ? "junction" : undefined)
          })

          const skill = yield* start([source], tmp.path)
          const watcher = yield* Watcher.Test
          expect((yield* skill.list()).find((item) => item.id === "bro")?.description).toBe("First")
          expect(yield* watcher.subscriptions()).toContainEqual({ path: first, type: "directory" })
          expect(yield* watcher.subscriptions()).toContainEqual({ path: source, type: "file" })

          yield* Effect.promise(async () => {
            await fs.unlink(source)
            await fs.symlink(second, source, process.platform === "win32" ? "junction" : undefined)
          })
          yield* emitAndWait({ type: "update", path: source })

          expect((yield* skill.list()).find((item) => item.id === "bro")?.description).toBe("Second")
          expect(yield* watcher.subscriptions()).toContainEqual({ path: second, type: "directory" })
          expect(yield* watcher.subscriptions()).toContainEqual({ path: source, type: "file" })
        }),
      ),
    ),
  )

  it.live("follows missing source directories as their parents appear", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const source = path.join(tmp.path, "generated", "skills")
          const skill = yield* start([source], tmp.path)
          const watcher = yield* Watcher.Test
          expect(yield* skill.list()).toEqual([])
          expect(yield* watcher.subscriptions()).toEqual([{ path: path.join(tmp.path, "generated"), type: "file" }])

          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "generated")))
          yield* emitAndWait({ type: "create", path: path.join(tmp.path, "generated") })
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(source, "deploy"), { recursive: true })
            await write(source, "deploy", "Deploy")
          })
          yield* emitAndWait({ type: "create", path: source })
          expect((yield* skill.list()).map((item) => item.id)).toEqual([Skill.ID.make("deploy")])
        }),
      ),
    ),
  )
})
