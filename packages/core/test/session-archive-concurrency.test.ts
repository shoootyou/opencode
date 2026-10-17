/**
 * @spec-handoff
 * @interface Session.forSession(sessionID).setArchive({ archived: number | null }): Effect<void, NotFoundError | ArchiveConflictError>
 * @behavior
 *   - Concurrent archive/restore callers commit at most one represented-state transition.
 *   - A stale observation retries from current state; it never admits a stale transition.
 *   - Commit-hook rejection rolls back the projector, retained event, sequence, and notification.
 * @edge-cases
 *   - Deletion during admission never recreates a session.
 *   - Contention stops after the initial attempt plus eight retries.
 */
import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
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
