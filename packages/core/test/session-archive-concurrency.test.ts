/**
 * @spec-handoff
 * @interface Session.forSession(sessionID).setArchive({ archived: number | null }): Effect<void, NotFoundError | ArchiveConflictError>
 * @behavior
 *   - Concurrent archive/restore callers commit at most one represented-state transition.
 *   - A stale observation retries from current state; it never admits a stale transition.
 *   - Commit-hook rejection rolls back the projector, retained event, sequence, and notification.
 *   - Only the private stale-admission signal retries; rate and retention budgets remain persistent.
 * @edge-cases
 *   - Deletion during admission never recreates a session.
 *   - Contention stops after the initial attempt plus eight retries.
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
import { Project } from "@opencode/schema/project"
import { Event } from "@opencode/schema/event"
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
      SessionModelTransport.node.replace(Layer.mock(SessionModelTransport.Service)({
        bind: () => ({ execute: () => Effect.die("unexpected execution") }),
        close: () => Effect.void,
        closeAll: Effect.void,
      })),
      offlineModels,
    ],
  ),
)

const sessionID = SessionID.make("ses_archive_concurrency")
const otherID = SessionID.make("ses_archive_unaffected")
const seed = (rows: ReadonlyArray<{ id: SessionID; archived?: number | null; updated?: number }> = [{ id: sessionID }]) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run()
    yield* db
      .insert(SessionTable)
      .values(
        rows.map((row) => ({
          id: row.id,
          project_id: Project.ID.global,
          directory: "/project",
          slug: String(row.id),
          version: "test",
          time_archived: row.archived ?? null,
          time_created: 1,
          time_updated: row.updated ?? 1,
        })),
      )
      .run()
    return db
  })

/** A fixture-only seam: pause after admission has read state, immediately before delegating to the real Bus transaction. */
const sessionWithArchivePublishHook = (
  hook: (data: { sessionID: SessionID; archived: number | null }, real: Bus.Interface) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const real = yield* Bus.Service
    const database = yield* Database.Service
    const store = yield* SessionStore.Service
    const instances = yield* Instance.Service
    const inbox = yield* SessionInbox.Service
    const fs = yield* FSUtil.Service
    const bus: Bus.Interface = {
      ...real,
      publish: (definition, data, options) =>
        definition.type === "session.archive.changed"
          ? hook(data as { sessionID: SessionID; archived: number | null }, real).pipe(
              Effect.andThen(real.publish(definition, data, options)),
            )
          : real.publish(definition, data, options),
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

const setArchive = (sessions: Effect.Success<ReturnType<typeof make>>, id: SessionID, archived: number | null) => {
  const handle = sessions.forSession(id) as unknown as { setArchive?: (input: { archived: number | null }) => Effect.Effect<void> }
  if (!handle.setArchive) return Effect.die(new Error("Session.Handle.setArchive({ archived }) is missing"))
  return handle.setArchive({ archived })
}

describe("session archive concurrency contract", () => {
  it.effect("serializes two archives and two restores so the first archive timestamp wins", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      const firstEntered = yield* Deferred.make<void>()
      const secondEntered = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const releaseSecond = yield* Deferred.make<void>()
      const sessions = yield* sessionWithArchivePublishHook((input) =>
        input.archived === 10
          ? Deferred.succeed(firstEntered, undefined).pipe(Effect.andThen(Deferred.await(releaseFirst)))
          : input.archived === 20
            ? Deferred.succeed(secondEntered, undefined).pipe(Effect.andThen(Deferred.await(releaseSecond)))
            : Effect.void,
      )
      const first = yield* setArchive(sessions, sessionID, 10).pipe(Effect.forkScoped)
      yield* Deferred.await(firstEntered)
      const second = yield* setArchive(sessions, sessionID, 20).pipe(Effect.forkScoped)
      yield* Deferred.await(secondEntered)
      yield* Deferred.succeed(releaseFirst, undefined)
      yield* Fiber.join(first)
      yield* Deferred.succeed(releaseSecond, undefined)
      yield* Fiber.join(second)

      expect(yield* db.select({ archived: SessionTable.time_archived }).from(SessionTable).where(eq(SessionTable.id, sessionID)).get()).toEqual({ archived: 10 })
      expect(yield* db.select().from(EventTable).all()).toHaveLength(1)

      yield* Effect.all([setArchive(sessions, sessionID, null), setArchive(sessions, sessionID, null)], { concurrency: "unbounded" })
      expect(yield* db.select().from(EventTable).all()).toHaveLength(2)
    }),
  )

  it.effect("preserves the last committed archive/restore transition without losing either caller", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      const archiveEntered = yield* Deferred.make<void>()
      const releaseArchive = yield* Deferred.make<void>()
      const sessions = yield* sessionWithArchivePublishHook((input) =>
        input.archived === 10
          ? Deferred.succeed(archiveEntered, undefined).pipe(Effect.andThen(Deferred.await(releaseArchive)))
          : Effect.void,
      )
      const archive = yield* setArchive(sessions, sessionID, 10).pipe(Effect.forkScoped)
      yield* Deferred.await(archiveEntered)
      yield* (yield* Bus.Service).publish(SessionEvent.ArchiveChanged, { sessionID, archived: 5 })
      yield* setArchive(sessions, sessionID, null)
      yield* Deferred.succeed(releaseArchive, undefined)
      yield* Fiber.join(archive)

      expect(yield* db.select({ archived: SessionTable.time_archived }).from(SessionTable).where(eq(SessionTable.id, sessionID)).get()).toEqual({ archived: 10 })
      expect(yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sessionID)).get()).toMatchObject({ seq: 2 })
    }),
  )

  it.effect("re-observes after an unrelated committed event instead of admitting stale archive state", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      let archiveAttempts = 0
      const sessions = yield* sessionWithArchivePublishHook((input, real) =>
        Effect.sync(() => ++archiveAttempts).pipe(
          Effect.flatMap((attempt) =>
            attempt === 1
              ? real.publish(SessionEvent.Renamed, { sessionID: input.sessionID, title: "between-read-and-publish" }).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      )
      yield* setArchive(sessions, sessionID, 0)
      expect(archiveAttempts).toBe(2)
      expect(yield* db.select({ archived: SessionTable.time_archived }).from(SessionTable).where(eq(SessionTable.id, sessionID)).get()).toEqual({ archived: 0 })
      expect(yield* db.select().from(EventSequenceTable).all()).toHaveLength(1)
    }),
  )

  it.effect("does not recreate a session deleted after archive admission observes it", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      let deleted = false
      const sessions = yield* sessionWithArchivePublishHook((input, real) => {
        if (deleted) return Effect.void
        deleted = true
        return real.publish(SessionEvent.Deleted, { sessionID: input.sessionID }).pipe(Effect.asVoid)
      })
      const result = yield* setArchive(sessions, sessionID, 0).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(String(result)).toContain("Session.NotFoundError")
      expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()).toBeUndefined()
      expect(yield* db.select().from(EventTable).all()).toHaveLength(0)
    }),
  )

  it.effect("propagates an arbitrary archive publish defect without retrying or translating it to contention", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      const defect = { reason: "injected archive publish defect" }
      let attempts = 0
      const sessions = yield* sessionWithArchivePublishHook(() =>
        Effect.sync(() => ++attempts).pipe(Effect.andThen(Effect.die(defect))),
      )
      const result = yield* setArchive(sessions, sessionID, 0).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(String(result)).toContain("injected archive publish defect")
      expect(String(result)).not.toContain("ArchiveConflictError")
      expect(attempts).toBe(1)
      expect(yield* db.select().from(EventTable).all()).toEqual([])
      expect(yield* db.select().from(EventSequenceTable).all()).toEqual([])
      expect(yield* db.select({ archived: SessionTable.time_archived }).from(SessionTable).get()).toEqual({ archived: null })
    }),
  )

  it.effect("rejects direct deletion between observation and commit without advancing the archive sequence", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      let deleted = false
      const sessions = yield* sessionWithArchivePublishHook((input) => {
        if (deleted) return Effect.void
        deleted = true
        return db.delete(SessionTable).where(eq(SessionTable.id, input.sessionID)).run().pipe(Effect.orDie, Effect.asVoid)
      })
      const result = yield* setArchive(sessions, sessionID, 0).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(String(result)).toContain("Session.NotFoundError")
      expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()).toBeUndefined()
      expect(yield* db.select().from(EventSequenceTable).all()).toEqual([])
      expect(yield* db.select().from(EventTable).all()).toEqual([])
    }),
  )

  it.effect("limits alternating archive transitions to six per persistent 60-second window", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      yield* TestClock.setTime(1_000)
      const sessions = yield* sessionWithArchivePublishHook(() => Effect.void)
      const results = yield* Effect.forEach([0, null, 1, null, 2, null, 3] as const, (archived) =>
        setArchive(sessions, sessionID, archived).pipe(Effect.exit),
      )
      expect(results.slice(0, 6).every(Exit.isSuccess)).toBe(true)
      expect(Exit.isFailure(results[6]!)).toBe(true)
      expect(String(results[6]!)).toContain("ArchiveLimitError")
      expect(yield* db.select().from(EventTable).all()).toHaveLength(6)
      expect(yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sessionID)).get()).toMatchObject({ seq: 5 })
      yield* TestClock.adjust("60 seconds")
      yield* setArchive(sessions, sessionID, 3)
    }),
  )

  it.effect("reserves the final archive-event slot for restore and rejects another archive at quota", () =>
    Effect.gen(function* () {
      const db = yield* seed([{ id: sessionID, archived: 0 }])
      yield* TestClock.setTime(2_000_000)
      yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 1022 }).run()
      yield* db
        .insert(EventTable)
        .values(
          Array.from({ length: 1023 }, (_, seq) => ({
            id: Event.ID.make(`evt_archive_quota_${seq}`),
            aggregate_id: sessionID,
            seq,
            // Persisted history is old but realistic; it fills quota without tripping the rolling rate window.
            created: 1_000_000 + seq,
            type: Bus.versionedType(SessionEvent.ArchiveChanged.type, 1),
            data: { sessionID, archived: seq % 2 === 0 ? 0 : null },
          })),
        )
        .run()
      const sessions = yield* sessionWithArchivePublishHook(() => Effect.void)
      yield* setArchive(sessions, sessionID, null)
      expect(yield* db.select().from(EventTable).all()).toHaveLength(1024)
      const denied = yield* setArchive(sessions, sessionID, 7).pipe(Effect.exit)
      expect(Exit.isFailure(denied)).toBe(true)
      expect(String(denied)).toContain("ArchiveLimitError")
      expect(yield* db.select().from(EventTable).all()).toHaveLength(1024)
    }),
  )

  it.effect("counts future-dated retained archive events conservatively for both rate and quota admission", () =>
    Effect.gen(function* () {
      const now = 3_000_000
      const db = yield* seed()
      yield* TestClock.setTime(now)
      yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 5 }).run()
      yield* db
        .insert(EventTable)
        .values(
          Array.from({ length: 6 }, (_, seq) => ({
            id: Event.ID.make(`evt_archive_future_rate_${seq}`),
            aggregate_id: sessionID,
            seq,
            created: now + 1,
            type: Bus.versionedType(SessionEvent.ArchiveChanged.type, 1),
            data: { sessionID, archived: seq % 2 === 0 ? 0 : null },
          })),
        )
        .run()
      const sessions = yield* sessionWithArchivePublishHook(() => Effect.void)
      const rateDenied = yield* setArchive(sessions, sessionID, 0).pipe(Effect.exit)
      expect(Exit.isFailure(rateDenied)).toBe(true)
      expect(String(rateDenied)).toContain("ArchiveLimitError")
      expect(yield* db.select().from(EventTable).all()).toHaveLength(6)

      const quotaID = SessionID.make("ses_archive_future_quota")
      yield* db.insert(SessionTable).values({
        id: quotaID,
        project_id: Project.ID.global,
        directory: "/project",
        slug: String(quotaID),
        version: "test",
        time_archived: null,
        time_created: 1,
        time_updated: 1,
      }).run().pipe(Effect.orDie)
      yield* db.insert(EventSequenceTable).values({ aggregate_id: quotaID, seq: 1022 }).run()
      yield* db
        .insert(EventTable)
        .values(
          Array.from({ length: 1023 }, (_, seq) => ({
            id: Event.ID.make(`evt_archive_future_quota_${seq}`),
            aggregate_id: quotaID,
            seq,
            created: seq === 1022 ? now + 1 : now - 120_000 - seq,
            type: Bus.versionedType(SessionEvent.ArchiveChanged.type, 1),
            data: { sessionID: quotaID, archived: seq % 2 === 0 ? 0 : null },
          })),
        )
        .run()
      const quotaDenied = yield* setArchive(sessions, quotaID, 0).pipe(Effect.exit)
      expect(Exit.isFailure(quotaDenied)).toBe(true)
      expect(String(quotaDenied)).toContain("ArchiveLimitError")
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, quotaID)).all()).toHaveLength(1023)
    }),
  )

  it.effect("exhausts exactly the initial attempt plus eight stale retries without affecting another session", () =>
    Effect.gen(function* () {
      const db = yield* seed([{ id: sessionID }, { id: otherID, archived: 77, updated: 77 }])
      let attempts = 0
      const sessions = yield* sessionWithArchivePublishHook((input, real) => {
        if (input.sessionID !== sessionID) return Effect.void
        return Effect.sync(() => attempts++).pipe(
          Effect.andThen(real.publish(SessionEvent.Renamed, { sessionID, title: `contention-${attempts}` })),
          Effect.asVoid,
        )
      })
      const result = yield* setArchive(sessions, sessionID, 0).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(String(result)).toContain("Session.ArchiveConflictError")
      expect(attempts).toBe(9)
      expect(yield* db.select({ archived: SessionTable.time_archived, updated: SessionTable.time_updated }).from(SessionTable).where(eq(SessionTable.id, otherID)).get()).toEqual({ archived: 77, updated: 77 })
    }),
  )

  it.effect("rolls back archive mutation and emits nothing when the real Bus commit hook rejects", () =>
    Effect.gen(function* () {
      const db = yield* seed([{ id: sessionID, updated: 44 }])
      const bus = yield* Bus.Service
      let emitted = 0
      yield* bus.listen(() => Effect.sync(() => emitted++))
      const result = yield* bus.publish(SessionEvent.ArchiveChanged, { sessionID, archived: 0 }, { commit: () => Effect.die("reject") }).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* db.select({ archived: SessionTable.time_archived, updated: SessionTable.time_updated }).from(SessionTable).where(eq(SessionTable.id, sessionID)).get()).toEqual({ archived: null, updated: 44 })
      expect(yield* db.select().from(EventTable).all()).toEqual([])
      expect(yield* db.select().from(EventSequenceTable).all()).toEqual([])
      expect(emitted).toBe(0)
    }),
  )
})
