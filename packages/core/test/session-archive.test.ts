import { describe, expect } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { EventTable } from "@opencode/core/event/sql"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { Event } from "@opencode/schema/event"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { DateTime, Effect, Exit } from "effect"
import { eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Project.node.replace(globalProjectNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

const legacyArchiveEvent = (id: string, sessionID: Session.ID, seq: number, created: number, archived: number | null) => ({
  id: Event.ID.make(id),
  aggregateID: sessionID,
  seq,
  created,
  type: "session.archive.changed.1",
  data: { sessionID, archived },
})

describe("Session.archive", () => {
  it.effect("archives and unarchives through one durable event each", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      expect(created.time.archived).toBeUndefined()

      yield* session.archive(created.id)
      const firstArchived = yield* session.get(created.id)
      yield* session.archive(created.id)
      const repeatedArchive = yield* session.get(created.id)
      expect(repeatedArchive.time.archived).toBeDefined()
      expect(repeatedArchive.time.updated).toEqual(firstArchived.time.updated)

      yield* session.unarchive(created.id)
      const restored = yield* session.get(created.id)
      yield* session.unarchive(created.id)
      const repeatedRestore = yield* session.get(created.id)
      expect(repeatedRestore.time.archived).toBeUndefined()
      expect(repeatedRestore.time.updated).toEqual(restored.time.updated)

      const types = (yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, created.id))
        .all()).map((event) => event.type)
      expect(types.filter((type) => type === Bus.versionedType(SessionEvent.Archived.type, 1))).toHaveLength(1)
      expect(types.filter((type) => type === Bus.versionedType(SessionEvent.Unarchived.type, 1))).toHaveLength(1)
    }),
  )

  it.effect("filters listed sessions by archive state", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const active = yield* session.create({ location })
      const archived = yield* session.create({ location })
      yield* session.archive(archived.id)

      const ids = (input?: Session.ListInput) =>
        session.list(input).pipe(Effect.map((page) => page.data.map((item) => item.id).toSorted()))
      expect(yield* ids()).toEqual([active.id, archived.id].toSorted())
      expect(yield* ids({ archived: false })).toEqual([active.id])
      expect(yield* ids({ archived: true })).toEqual([archived.id])
    }),
  )

  it.effect("rejects an unknown session", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const sessionID = Session.ID.make("ses_missing_archive")
      expect(yield* Effect.flip(session.archive(sessionID))).toEqual(new Session.NotFoundError({ sessionID }))
      expect(yield* Effect.flip(session.unarchive(sessionID))).toEqual(new Session.NotFoundError({ sessionID }))
    }),
  )

  it.effect("preserves legacy archive payload time, event identity, and transition timestamps on replay", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      const archive = legacyArchiveEvent("evt_archive_0", created.id, 1, 1234, 0)

      yield* bus.replay(archive)
      const firstArchived = yield* session.get(created.id)
      expect(DateTime.toEpochMillis(firstArchived.time.archived!)).toBe(0)
      expect(DateTime.toEpochMillis(firstArchived.time.updated)).toBe(1234)
      expect(
        yield* db
          .select({ id: EventTable.id, aggregateID: EventTable.aggregate_id, seq: EventTable.seq, created: EventTable.created, type: EventTable.type, data: EventTable.data })
          .from(EventTable)
          .where(eq(EventTable.id, archive.id))
          .get(),
      ).toEqual({ id: archive.id, aggregateID: created.id, seq: 1, created: 1234, type: archive.type, data: archive.data })

      yield* bus.replay(legacyArchiveEvent("evt_archive_repeat", created.id, 2, 2345, 9))
      const repeatedArchive = yield* session.get(created.id)
      expect(DateTime.toEpochMillis(repeatedArchive.time.archived!)).toBe(0)
      expect(DateTime.toEpochMillis(repeatedArchive.time.updated)).toBe(1234)
      yield* bus.replay(legacyArchiveEvent("evt_archive_restore", created.id, 3, 3456, null))
      const restored = yield* session.get(created.id)
      expect(restored.time.archived).toBeUndefined()
      expect(DateTime.toEpochMillis(restored.time.updated)).toBe(3456)
    }),
  )

  it.effect("rejects mismatched, divergent, and gapped legacy replay without changing archive state", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const created = yield* session.create({ location })
      const other = yield* session.create({ location })
      const event = legacyArchiveEvent("evt_archive_replay", created.id, 1, 1234, 0)

      expect(Exit.isFailure(yield* bus.replay({ ...event, data: { sessionID: other.id, archived: 0 } }).pipe(Effect.exit))).toBe(true)
      expect((yield* session.get(other.id)).time.archived).toBeUndefined()
      yield* bus.replay(event)
      yield* bus.replay(event)
      expect(Exit.isFailure(yield* bus.replay({ ...event, data: { sessionID: created.id, archived: 9 } }).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* bus.replay({ ...event, id: Event.ID.make("evt_archive_gap"), seq: 3 }).pipe(Effect.exit))).toBe(true)
    }),
  )
})
