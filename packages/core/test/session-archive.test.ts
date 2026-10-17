/**
 * @spec-handoff
 * @interface handle.setArchive({ archived: number | null }): Effect<void, NotFoundError | ArchiveConflictError>
 * @interface Session.setArchive({ sessionID, archived: number | null }): Effect<void, NotFoundError | ArchiveConflictError>
 * @behavior
 *   - Archives/restores one session through SessionEvent.ArchiveChanged atomically and idempotently.
 *   - Retains archive events by definition metadata while ordinary events retain their existing default.
 *   - SessionStore.ListInput.archived hides archived sessions unless true, without changing keyset ordering.
 * @edge-cases
 *   - Epoch zero is archived; null restores; contention fails after the initial attempt plus eight retries.
 *   - Recursive removal and replay include archived children and preserve replay safety guarantees.
 */
import { describe, expect } from "bun:test"
import { DateTime, Effect, Exit, Stream } from "effect"
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
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionEvent } from "@opencode/core/session/event"
import { fromRow } from "@opencode/core/session/info"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { EventSequenceTable, EventTable } from "@opencode/core/event/sql"
import { SessionTable } from "@opencode/core/session/sql"
import { Event } from "@opencode/schema/event"
import { Project } from "@opencode/schema/project"
import { AbsolutePath } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Layer } from "effect"
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
      Session.node,
      Instance.node,
      LocationServiceMap.node,
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
const sessionID = SessionID.make("ses_archive")
const archive = (archived: number | null) =>
  Effect.gen(function* () {
    const facade = yield* Session.Service
    const setArchive = (facade as unknown as { setArchive?: (input: { sessionID: SessionID; archived: number | null }) => Effect.Effect<void> })
      .setArchive
    if (!setArchive) return yield* Effect.die(new Error("Session.setArchive({ sessionID, archived }) is missing"))
    yield* setArchive({ sessionID, archived })
  })

const seed = (rows: ReadonlyArray<{ id: SessionID; archived?: number | null; updated?: number; parentID?: SessionID }> = []) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run()
    if (rows.length > 0)
      yield* db
        .insert(SessionTable)
        .values(
          rows.map((row) => ({
          id: row.id,
          project_id: Project.ID.global,
          directory: "/project",
          slug: String(row.id),
          version: "test",
          parent_id: row.parentID,
          time_archived: row.archived ?? null,
          time_created: 1,
          time_updated: row.updated ?? 1,
          })),
        )
        .run()
    return db
  })

describe("session archive core contract", () => {
  it.effect("preserves epoch zero in info rows", () =>
    Effect.gen(function* () {
      const db = yield* seed([{ id: sessionID, archived: 0 }])
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
      expect(row?.time_archived).toBe(0)
      expect(fromRow(row!).time.archived).toBeDefined()
      expect(DateTime.toEpochMillis(fromRow(row!).time.archived!)).toBe(0)
    }),
  )

  it.effect("archives, restores, and makes represented-state requests no-ops", () =>
    Effect.gen(function* () {
      const db = yield* seed([{ id: sessionID, updated: 7 }])
      const bus = yield* Bus.Service

      yield* archive(0)
      const first = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
      expect(first).toMatchObject({ time_archived: 0 })
      const firstEvents = yield* db.select().from(EventTable).all().pipe(Effect.orDie)
      expect(firstEvents).toHaveLength(1)

      yield* archive(9)
      const repeatedArchive = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
      expect(repeatedArchive).toMatchObject({ time_archived: 0, time_updated: first?.time_updated })
      expect(yield* db.select().from(EventTable).all()).toHaveLength(1)

      yield* archive(null)
      const restored = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
      expect(restored?.time_archived).toBeNull()
      expect(yield* db.select().from(EventTable).all()).toHaveLength(2)
      yield* archive(null)
      expect(yield* db.select().from(EventTable).all()).toHaveLength(2)
      expect((yield* bus.log({ aggregateID: sessionID }).pipe(Stream.runCollect)).filter((item) => !Bus.isSynced(item))).toHaveLength(2)
    }),
  )

  it.effect("returns NotFoundError for an unknown session and does not publish", () =>
    Effect.gen(function* () {
      yield* seed()
      const missing = SessionID.make("ses_archive_missing")
      const facade = yield* Session.Service
      const setArchive = (facade as unknown as { setArchive?: (input: { sessionID: SessionID; archived: number | null }) => Effect.Effect<void> })
        .setArchive
      expect(setArchive, "Session.setArchive facade must exist").toBeDefined()
      const result = yield* setArchive!({ sessionID: missing, archived: 0 }).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(String(result)).toContain("Session.NotFoundError")
    }),
  )

  it.effect("filters archived rows before limits and keeps equal-time cursor ordering", () =>
    Effect.gen(function* () {
      yield* seed([
        { id: SessionID.make("ses_z"), archived: 2, updated: 10 },
        { id: SessionID.make("ses_c"), updated: 10 },
        { id: SessionID.make("ses_b"), updated: 10 },
        { id: SessionID.make("ses_a"), updated: 9 },
      ])
      const store = yield* SessionStore.Service
      expect((yield* store.list({ limit: 2 })).map((item) => String(item.id))).toEqual(["ses_c", "ses_b"])
      expect((yield* store.list({ archived: true, limit: 2 } as never)).map((item) => String(item.id))).toEqual(["ses_z", "ses_c"])
      expect(
        (yield* store.list({ archived: true, order: "asc", anchor: { id: SessionID.make("ses_b"), time: 10, direction: "previous" } } as never)).map(
          (item) => String(item.id),
        ),
      ).toEqual(["ses_a"])
    }),
  )

  it.effect("projects archive and restore idempotently without changing recency for repeated represented events", () =>
    Effect.gen(function* () {
      const db = yield* seed([{ id: sessionID, updated: 5 }])
      const bus = yield* Bus.Service
      yield* bus.replay({ id: Event.ID.make("evt_archive_0"), aggregateID: sessionID, seq: 0, created: 10, type: Bus.versionedType(SessionEvent.ArchiveChanged.type, 1), data: { sessionID, archived: 0 } })
      yield* bus.replay({ id: Event.ID.make("evt_archive_repeat"), aggregateID: sessionID, seq: 1, created: 20, type: Bus.versionedType(SessionEvent.ArchiveChanged.type, 1), data: { sessionID, archived: 5 } })
      expect(yield* db.select({ archived: SessionTable.time_archived, updated: SessionTable.time_updated }).from(SessionTable).get()).toEqual({ archived: 0, updated: 10 })
      yield* bus.replay({ id: Event.ID.make("evt_restore"), aggregateID: sessionID, seq: 2, created: 30, type: Bus.versionedType(SessionEvent.ArchiveChanged.type, 1), data: { sessionID, archived: null } })
      expect(yield* db.select({ archived: SessionTable.time_archived, updated: SessionTable.time_updated }).from(SessionTable).get()).toEqual({ archived: null, updated: 30 })
    }),
  )

  it.effect("rolls back the projector, retained event, sequence, and notification when commit admission rejects", () =>
    Effect.gen(function* () {
      const db = yield* seed([{ id: sessionID, updated: 4 }])
      const bus = yield* Bus.Service
      let emitted = 0
      yield* bus.listen(() => Effect.sync(() => emitted++))
      const result = yield* bus.publish(SessionEvent.ArchiveChanged, { sessionID, archived: 0 }, { commit: () => Effect.die("stale") }).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* db.select({ archived: SessionTable.time_archived, updated: SessionTable.time_updated }).from(SessionTable).get()).toEqual({ archived: null, updated: 4 })
      expect(yield* db.select().from(EventTable).all()).toEqual([])
      expect(yield* db.select().from(EventSequenceTable).all()).toEqual([])
      expect(emitted).toBe(0)
    }),
  )

  it.effect("retains archive events by definition under the default profile while leaving unrelated events unretained", () =>
    Effect.gen(function* () {
      yield* seed([{ id: sessionID }])
      const bus = yield* Bus.Service
      yield* bus.publish(SessionEvent.ArchiveChanged, { sessionID, archived: 0 })
      yield* bus.publish(SessionEvent.Renamed, { sessionID, title: "ordinary" })
      const stored = yield* (yield* Database.Service).db.select().from(EventTable).all().pipe(Effect.orDie)
      expect(stored.map((event) => event.type)).toEqual([Bus.versionedType("session.archive.changed", 1)])
    }),
  )

  it.effect("admits simultaneous archive or restore requests as one represented transition", () =>
    Effect.gen(function* () {
      const db = yield* seed([{ id: sessionID }])
      yield* Effect.all([archive(0), archive(1)], { concurrency: "unbounded" })
      expect(yield* db.select().from(EventTable).all()).toHaveLength(1)
      expect((yield* db.select({ archived: SessionTable.time_archived }).from(SessionTable).get())?.archived).toBe(0)
      yield* Effect.all([archive(null), archive(null)], { concurrency: "unbounded" })
      expect(yield* db.select().from(EventTable).all()).toHaveLength(2)
    }),
  )

  it.effect("rejects exact-replay divergence and sequence gaps while accepting an exact duplicate", () =>
    Effect.gen(function* () {
      yield* seed([{ id: sessionID }])
      const bus = yield* Bus.Service
      const event = { id: Event.ID.make("evt_archive_replay"), aggregateID: sessionID, seq: 0, created: 0, type: Bus.versionedType(SessionEvent.ArchiveChanged.type, 1), data: { sessionID, archived: 0 } }
      yield* bus.replay(event)
      yield* bus.replay(event)
      expect(Exit.isFailure(yield* bus.replay({ ...event, data: { sessionID, archived: 2 } }).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* bus.replay({ ...event, id: Event.ID.make("evt_archive_gap"), seq: 2 }).pipe(Effect.exit))).toBe(true)
    }),
  )

  it.effect("deletes archived children recursively rather than applying UI list hiding to internal enumeration", () =>
    Effect.gen(function* () {
      const child = SessionID.make("ses_archive_child")
      const db = yield* seed([{ id: sessionID }, { id: child, parentID: sessionID, archived: 0 }])
      const facade = yield* Session.Service
      expect((yield* facade.list({ parentID: sessionID })).data).toEqual([])
      yield* facade.remove(sessionID)
      expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, child)).all()).toEqual([])
    }),
  )
})
