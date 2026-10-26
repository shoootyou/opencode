/**
 * @spec-handoff
 * @interface Session.archive(sessionID) / Session.unarchive(sessionID): Effect<void>
 * @behavior
 *   - Same-direction concurrent native archive calls commit one transition with one retained event.
 *   - Native admission rejects mixed archive-family rate and retention overages atomically at the Bus commit boundary.
 * @edge-cases
 *   - A rejected native transaction changes neither projection, sequence, retained rows, nor notifications.
 *   - The fixture gates the real Bus publisher before its transaction; it does not replace locking or admission.
 */
import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { eq } from "drizzle-orm"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Instance } from "@opencode/core/instance/service"
import { LocationServiceMap } from "@opencode/core/location-services"
import { Project as CoreProject } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { Session } from "@opencode/core/session"
import { SessionEnvironment } from "@opencode/core/session/environment"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionProjector } from "@opencode/core/session/projector"
import { make } from "@opencode/core/session/session"
import { SessionStore } from "@opencode/core/session/store"
import { FSUtil } from "@opencode/util/fs-util"
import { EventSequenceTable, EventTable } from "@opencode/core/event/sql"
import { SessionTable } from "@opencode/core/session/sql"
import { Event } from "@opencode/schema/event"
import { Project } from "@opencode/schema/project"
import { AbsolutePath } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { globalProjectNode } from "./lib/project"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      SessionEnvironment.node,
      SessionInbox.node,
      Session.node,
      Instance.node,
      LocationServiceMap.node,
      FSUtil.node,
    ]),
    [
      Bus.node.replace(Bus.configured()),
      CoreProject.node.replace(globalProjectNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
      SessionModelTransport.node.replace(
        Layer.mock(SessionModelTransport.Service)({
          bind: () => ({ execute: () => Effect.die("unexpected execution") }),
          close: () => Effect.void,
          closeAll: Effect.void,
        }),
      ),
      offlineModels,
    ],
  ),
)

const sessionID = SessionID.make("ses_archive_concurrency")

const seed = (archived: number | null = null) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        directory: "/project",
        slug: String(sessionID),
        version: "test",
        time_archived: archived,
        time_created: 1,
        time_updated: 1,
      })
      .run()
    return db
  })

const nativeSessionWithPublishGate = (gate: (archived: boolean, real: Bus.Interface) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const real = yield* Bus.Service
    const database = yield* Database.Service
    const store = yield* SessionStore.Service
    const instances = yield* Instance.Service
    const inbox = yield* SessionInbox.Service
    const fs = yield* FSUtil.Service
    const bus: Bus.Interface = {
      ...real,
      publish: (definition, data, options) => {
        const archived = definition.type === SessionEvent.Archived.type
        const unarchived = definition.type === SessionEvent.Unarchived.type
        if (!archived && !unarchived) return real.publish(definition, data, options)
        return gate(archived, real).pipe(Effect.andThen(real.publish(definition, data, options)))
      },
    }
    return yield* make().pipe(
      Effect.provideService(Bus.Service, bus),
      Effect.provideService(Database.Service, database),
      Effect.provideService(SessionStore.Service, store),
      Effect.provideService(Instance.Service, instances),
      Effect.provide(SessionExecution.noopLayer),
      Effect.provideService(SessionInbox.Service, inbox),
      Effect.provideService(FSUtil.Service, fs),
    )
  })

describe("native session archive commit admission", () => {
  it.effect("requires concurrent archive calls gated before the real Bus transaction to commit one transition", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      const firstEntered = yield* Deferred.make<void>()
      const secondEntered = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const releaseSecond = yield* Deferred.make<void>()
      let notifications = 0
      yield* (yield* Bus.Service).listen(() => Effect.sync(() => ++notifications))
      let calls = 0
      const sessions = yield* nativeSessionWithPublishGate(() => {
        calls++
        if (calls === 1)
          return Deferred.succeed(firstEntered, undefined).pipe(Effect.andThen(Deferred.await(releaseFirst)))
        return Deferred.succeed(secondEntered, undefined).pipe(Effect.andThen(Deferred.await(releaseSecond)))
      })

      const first = yield* sessions.forSession(sessionID).archive().pipe(Effect.forkScoped)
      yield* Deferred.await(firstEntered)
      const second = yield* sessions.forSession(sessionID).archive().pipe(Effect.forkScoped)
      yield* Deferred.await(secondEntered)
      yield* Deferred.succeed(releaseFirst, undefined)
      yield* Fiber.join(first)
      yield* Deferred.succeed(releaseSecond, undefined)
      yield* Fiber.join(second)

      expect(yield* db.select().from(EventSequenceTable).all()).toEqual([
        { aggregate_id: sessionID, seq: 0, owner_id: null },
      ])
      expect(notifications).toBe(1)
      expect(yield* db.select({ archived: SessionTable.time_archived }).from(SessionTable).get()).toEqual({
        archived: expect.any(Number),
      })
    }),
  )

  it.effect(
    "requires an archive rollback to leave projection, sequence, retained rows, and notifications untouched",
    () =>
      Effect.gen(function* () {
        const db = yield* seed()
        const bus = yield* Bus.Service
        let notifications = 0
        yield* bus.listen(() => Effect.sync(() => ++notifications))

        const result = yield* bus
          .publish(SessionEvent.Archived, { sessionID }, { commit: () => Effect.die("native-admission-rejected") })
          .pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(
          yield* db
            .select({ archived: SessionTable.time_archived, updated: SessionTable.time_updated })
            .from(SessionTable)
            .get(),
        ).toEqual({
          archived: null,
          updated: 1,
        })
        expect(yield* db.select().from(EventTable).all()).toEqual([])
        expect(yield* db.select().from(EventSequenceTable).all()).toEqual([])
        expect(notifications).toBe(0)
      }),
  )

  it.effect("does not recreate a session deleted between native archive observation and commit", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      const directSession = yield* Session.Service
      let deleted = false
      const sessions = yield* nativeSessionWithPublishGate(() => {
        if (deleted) return Effect.void
        deleted = true
        return directSession.remove(sessionID).pipe(Effect.orDie)
      })

      const result = yield* sessions.forSession(sessionID).archive().pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()).toBeUndefined()
      expect(yield* db.select().from(EventSequenceTable).all()).toEqual([])
      expect(yield* db.select().from(EventTable).all()).toEqual([])
    }),
  )

  it.effect("retries native archive exactly eight times after its initial stale commit attempt", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      let attempts = 0
      const sessions = yield* nativeSessionWithPublishGate((_archived, real) =>
        Effect.sync(() => ++attempts).pipe(
          Effect.andThen(real.publish(SessionEvent.Renamed, { sessionID, title: `stale-${attempts}` })),
          Effect.asVoid,
        ),
      )

      const result = yield* sessions.forSession(sessionID).archive().pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(attempts).toBe(9)
      expect(yield* db.select({ archived: SessionTable.time_archived }).from(SessionTable).get()).toEqual({
        archived: null,
      })
    }),
  )

  it.effect("counts future-dated native archive history against the rolling admission budget", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      const now = 3_000_000
      yield* TestClock.setTime(now)
      yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 5 }).run()
      yield* db
        .insert(EventTable)
        .values(
          Array.from({ length: 6 }, (_, seq) => ({
            id: Event.ID.make(`evt_archive_future_${seq}`),
            aggregate_id: sessionID,
            seq,
            created: now + 1,
            type: `session.${seq % 2 === 0 ? "archived" : "unarchived"}.1`,
            data: { sessionID },
          })),
        )
        .run()

      const result = yield* (yield* Session.Service).archive(sessionID).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* db.select().from(EventTable).all()).toHaveLength(6)
      expect(yield* db.select({ archived: SessionTable.time_archived }).from(SessionTable).get()).toEqual({
        archived: null,
      })
    }),
  )
})
