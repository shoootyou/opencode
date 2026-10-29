/**
 * @spec-handoff
 * @interface Session.archive(sessionID) / Session.unarchive(sessionID): Effect<void>
 * @behavior
 *   - Same-direction concurrent native archive calls commit one transition with one retained event.
 *   - A stale archive retries after an intervening archive and restore, preserving the final archive transition.
 *   - Native admission rejects mixed archive-family rate and retention overages atomically at the Bus commit boundary.
 * @edge-cases
 *   - A rejected native transaction changes neither projection, sequence, retained rows, nor notifications.
 *   - The fixture gates the real Bus publisher before its transaction; it does not replace locking or admission.
 */
import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
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

  it.effect("serializes a gated archive followed by restore into two native transitions", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let gates = 0
      const sessions = yield* nativeSessionWithPublishGate(() => {
        gates++
        return gates === 1
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void
      })
      const archive = yield* sessions.forSession(sessionID).archive().pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(archive)
      yield* sessions.forSession(sessionID).unarchive()
      expect(yield* db.select({ archived: SessionTable.time_archived }).from(SessionTable).get()).toEqual({
        archived: null,
      })
      expect(
        (yield* db.select({ type: EventTable.type }).from(EventTable).orderBy(EventTable.seq).all()).map(
          (row) => row.type,
        ),
      ).toEqual(["session.archived.1", "session.unarchived.1"])
    }),
  )

  it.effect("preserves the last committed archive/restore transition without losing either caller", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const observedAt = 1_000
      let first = true
      let competingTransitionFinished = false
      let suspendedAttempts = 0
      yield* TestClock.setTime(observedAt)
      const sessions = yield* nativeSessionWithPublishGate((archived) => {
        if (first) {
          first = false
          suspendedAttempts++
          return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
        }
        if (competingTransitionFinished && archived) suspendedAttempts++
        return Effect.void
      })

      const suspended = yield* sessions.forSession(sessionID).archive().pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      yield* sessions.forSession(sessionID).archive()
      yield* sessions.forSession(sessionID).unarchive()
      competingTransitionFinished = true
      yield* TestClock.adjust("1 second")
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(suspended)

      expect(suspendedAttempts).toBe(2)
      expect(yield* db.select({ archived: SessionTable.time_archived }).from(SessionTable).get()).toEqual({
        archived: observedAt + 1_000,
      })
      expect(
        yield* db
          .select({ seq: EventTable.seq, type: EventTable.type, created: EventTable.created })
          .from(EventTable)
          .orderBy(EventTable.seq)
          .all(),
      ).toEqual([
        { seq: 0, type: "session.archived.1", created: observedAt },
        { seq: 1, type: "session.unarchived.1", created: observedAt },
        { seq: 2, type: "session.archived.1", created: observedAt + 1_000 },
      ])
      expect(yield* db.select().from(EventSequenceTable).all()).toEqual([
        { aggregate_id: sessionID, seq: 2, owner_id: null },
      ])
    }),
  )

  it.effect("makes concurrent native restores one transition followed by a no-op", () =>
    Effect.gen(function* () {
      const db = yield* seed(1)
      const firstEntered = yield* Deferred.make<void>()
      const secondEntered = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const releaseSecond = yield* Deferred.make<void>()
      let calls = 0
      const sessions = yield* nativeSessionWithPublishGate(() => {
        calls++
        return calls === 1
          ? Deferred.succeed(firstEntered, undefined).pipe(Effect.andThen(Deferred.await(releaseFirst)))
          : Deferred.succeed(secondEntered, undefined).pipe(Effect.andThen(Deferred.await(releaseSecond)))
      })
      const first = yield* sessions.forSession(sessionID).unarchive().pipe(Effect.forkScoped)
      yield* Deferred.await(firstEntered)
      const second = yield* sessions.forSession(sessionID).unarchive().pipe(Effect.forkScoped)
      yield* Deferred.await(secondEntered)
      yield* Deferred.succeed(releaseFirst, undefined)
      yield* Fiber.join(first)
      yield* Deferred.succeed(releaseSecond, undefined)
      yield* Fiber.join(second)
      expect(yield* db.select({ archived: SessionTable.time_archived }).from(SessionTable).get()).toEqual({
        archived: null,
      })
      expect(yield* db.select().from(EventTable).all()).toHaveLength(1)
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

  it.effect("fails after direct row deletion between observation and commit without recreating durable state", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      let deleted = false
      const sessions = yield* nativeSessionWithPublishGate(() => {
        if (deleted) return Effect.void
        deleted = true
        return db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie, Effect.asVoid)
      })
      const result = yield* sessions.forSession(sessionID).archive().pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(String(result)).toContain("Session.NotFoundError")
      expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()).toBeUndefined()
      expect(yield* db.select().from(EventSequenceTable).all()).toEqual([])
      expect(yield* db.select().from(EventTable).all()).toEqual([])
    }),
  )

  it.effect("retries once after an unrelated write and then commits the native archive", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      let attempts = 0
      const sessions = yield* nativeSessionWithPublishGate((_archived, real) =>
        Effect.sync(() => ++attempts).pipe(
          Effect.flatMap((attempt) =>
            attempt === 1
              ? real.publish(SessionEvent.Renamed, { sessionID, title: "between-attempts" }).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      )
      yield* sessions.forSession(sessionID).archive()
      expect(attempts).toBe(2)
      expect(yield* db.select({ archived: SessionTable.time_archived }).from(SessionTable).get()).toEqual({
        archived: expect.any(Number),
      })
      expect(yield* db.select().from(EventSequenceTable).all()).toEqual([
        { aggregate_id: sessionID, seq: 1, owner_id: null },
      ])
    }),
  )

  it.effect("propagates an arbitrary publish defect without retrying or translating it to archive contention", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      const defect = { marker: "native-archive-defect" }
      let attempts = 0
      const sessions = yield* nativeSessionWithPublishGate(() =>
        Effect.sync(() => ++attempts).pipe(Effect.andThen(Effect.die(defect))),
      )
      const result = yield* sessions.forSession(sessionID).archive().pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        expect(result.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect)).toContainEqual(defect)
        expect(String(result)).not.toContain("ArchiveConflictError")
      }
      expect(attempts).toBe(1)
      expect(yield* db.select().from(EventTable).all()).toEqual([])
      expect(yield* db.select().from(EventSequenceTable).all()).toEqual([])
    }),
  )

  it.effect("retries native archive exactly eight times after its initial stale commit attempt", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      let attempts = 0
      let notifications = 0
      yield* (yield* Bus.Service).listen(() => Effect.sync(() => ++notifications))
      const sessions = yield* nativeSessionWithPublishGate((_archived, real) =>
        Effect.sync(() => ++attempts).pipe(
          Effect.andThen(real.publish(SessionEvent.Renamed, { sessionID, title: `stale-${attempts}` })),
          Effect.asVoid,
        ),
      )

      const result = yield* sessions.forSession(sessionID).archive().pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(attempts).toBe(9)
      if (Exit.isFailure(result))
        expect(result.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)).toMatchObject([
          { _tag: "Session.ArchiveConflictError", sessionID },
        ])
      expect(yield* db.select({ archived: SessionTable.time_archived, title: SessionTable.title }).from(SessionTable).get()).toEqual({
        archived: null,
        title: "stale-8",
      })
      expect(yield* db.select().from(EventTable).all()).toEqual([])
      expect(yield* db.select().from(EventSequenceTable).all()).toEqual([
        { aggregate_id: sessionID, seq: 8, owner_id: null },
      ])
      expect(notifications).toBe(9)
    }),
  )

  it.effect("counts future-dated native archive history against the rolling admission budget", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      const now = 3_000_000
      yield* TestClock.setTime(now)
      let notifications = 0
      yield* (yield* Bus.Service).listen(() => Effect.sync(() => ++notifications))
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
      if (Exit.isFailure(result)) {
        expect(result.cause.reasons.some(Cause.isDieReason)).toBe(false)
        expect(result.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)).toMatchObject([
          { _tag: "Session.ArchiveLimitError", kind: "rate", retryAfterMillis: 60_001 },
        ])
      }
      expect(yield* db.select().from(EventTable).all()).toHaveLength(6)
      expect(yield* db.select().from(EventSequenceTable).all()).toEqual([
        { aggregate_id: sessionID, seq: 5, owner_id: null },
      ])
      expect(yield* db.select({ archived: SessionTable.time_archived }).from(SessionTable).get()).toEqual({
        archived: null,
      })
      expect(notifications).toBe(0)
    }),
  )

  it.effect(
    "admits six alternating transitions, returns the typed seventh rate refusal, and admits at exact expiry",
    () =>
      Effect.gen(function* () {
        const db = yield* seed()
        const now = 4_000_000
        yield* TestClock.setTime(now)
        const session = yield* Session.Service
        const transitions = [
          session.archive,
          session.unarchive,
          session.archive,
          session.unarchive,
          session.archive,
          session.unarchive,
        ]
        for (const transition of transitions) yield* transition(sessionID)
        expect(yield* db.select().from(EventTable).all()).toHaveLength(6)
        const denied = yield* session.archive(sessionID).pipe(Effect.exit)
        expect(Exit.isFailure(denied)).toBe(true)
        if (Exit.isFailure(denied))
          expect(denied.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)).toMatchObject([
            { _tag: "Session.ArchiveLimitError", kind: "rate", retryAfterMillis: 60_000 },
          ])
        yield* TestClock.adjust("60 seconds")
        yield* session.archive(sessionID)
        expect(yield* db.select().from(EventTable).all()).toHaveLength(7)
      }),
  )

  it.effect("does not let six far-future replayed native rows lock a real archive transition", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      const bus = yield* Bus.Service
      const now = 3_000_000
      const future = now + 31_536_000_000
      yield* TestClock.setTime(now)
      for (const seq of Array.from({ length: 6 }, (_, index) => index))
        yield* bus.replay({
          id: Event.ID.make(`evt_archive_future_replay_${seq}`),
          aggregateID: sessionID,
          seq,
          created: future,
          type: `session.${seq % 2 === 0 ? "archived" : "unarchived"}.1`,
          data: { sessionID },
        })
      yield* (yield* Session.Service).archive(sessionID)
      const rows = yield* db.select().from(EventTable).orderBy(EventTable.seq).all()
      expect(rows).toHaveLength(7)
      expect(rows.slice(0, 6).map((row) => [row.seq, row.created])).toEqual(
        Array.from({ length: 6 }, (_, seq) => [seq, future]),
      )
      expect(rows.at(-1)).toMatchObject({ seq: 6, type: "session.archived.1" })
    }),
  )

  it.effect("excludes rows beyond the exact future admission boundary", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      const now = 3_000_000
      yield* TestClock.setTime(now)
      yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 5 }).run()
      yield* db
        .insert(EventTable)
        .values(
          Array.from({ length: 6 }, (_, seq) => ({
            id: Event.ID.make(`evt_archive_future_boundary_${seq}`),
            aggregate_id: sessionID,
            seq,
            created: now + 60_001,
            type: `session.${seq % 2 === 0 ? "archived" : "unarchived"}.1`,
            data: { sessionID },
          })),
        )
        .run()
      yield* (yield* Session.Service).archive(sessionID)
      expect(yield* db.select().from(EventTable).all()).toHaveLength(7)
    }),
  )
})
