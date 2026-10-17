/**
 * @spec-handoff
 * @interface Bus.publish/publishAll/replay(ArchiveChanged): durable archive event handling
 * @interface V1Migration.run(): preserves session.time_archived into SessionTable
 * @behavior
 *   - ArchiveChanged payloads are retained under the default server Bus profile, while ordinary events are not.
 *   - Replay is duplicate-safe, contiguous, and reproduces archive state from a full retained log.
 *   - The archive projector is state-idempotent and writes SQL NULL when restoring.
 * @edge-cases
 *   - Epoch zero is archived; a missing projected session is never created.
 *   - V1 null, zero, and nonzero archive values retain their distinct meanings.
 */
import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode/core/database/drizzle"
import { Database } from "@opencode/core/database/database"
import { DatabaseMigration } from "@opencode/core/database/migration"
import { V1Migration } from "@opencode/core/database/v1-migration"
import { Bus } from "@opencode/core/bus"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { EventTable } from "@opencode/core/event/sql"
import { Instance } from "@opencode/core/instance/service"
import { LocationServiceMap } from "@opencode/core/location-services"
import { ProjectTable } from "@opencode/core/project/sql"
import { Project as CoreProject } from "@opencode/core/project"
import { fromRow } from "@opencode/core/session/info"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { SessionEnvironment } from "@opencode/core/session/environment"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { Event } from "@opencode/schema/event"
import { Project } from "@opencode/schema/project"
import { AbsolutePath } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Exit, Layer } from "effect"
import { eq, sql } from "drizzle-orm"
import path from "path"
import { globalProjectNode } from "./lib/project"
import { offlineModels } from "./fixture/models"
import { tmpdir } from "./fixture/tmpdir"

const sessionID = SessionID.make("ses_archive_retention")
const archiveDefinition = () => (SessionEvent as Record<string, unknown>).ArchiveChanged as typeof SessionEvent.Renamed | undefined

const archiveEvent = (id: string, seq: number, archived: number | null) => {
  const definition = archiveDefinition()
  if (!definition) throw new Error("SessionEvent.ArchiveChanged is missing")
  return {
    id: Event.ID.make(id),
    aggregateID: sessionID,
    seq,
    created: seq + 10,
    type: Bus.versionedType(definition.type, 1),
    data: { sessionID, archived },
  }
}

const runtime = (databasePath: string, persist = false) =>
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
      Database.node.replace(Database.configured({ path: databasePath })),
      Bus.node.replace(Bus.configured({ persist })),
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
  )

const run = <A, E, R>(databasePath: string, persist: boolean, effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(runtime(databasePath, persist) as never)) as Effect.Effect<A, E, never>)

const seed = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run()
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      directory: "/project",
      slug: "archive-retention",
      version: "test",
      time_created: 1,
      time_updated: 1,
    })
    .run()
  return db
})

describe("session archive retention and replay", () => {
  test("retains archive payloads after reopening the default file-backed Bus while ordinary events remain absent", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "archive.sqlite")

    await run(
      filename,
      false,
      Effect.gen(function* () {
        yield* seed
        const definition = archiveDefinition()
        expect(definition, "SessionEvent.ArchiveChanged must exist").toBeDefined()
        const bus = yield* Bus.Service
        yield* bus.publish(definition! as never, { sessionID, archived: 0 } as never)
        yield* bus.publish(SessionEvent.Renamed, { sessionID, title: "ordinary" })
      }),
    )

    await run(
      filename,
      false,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        expect(
          yield* db.select({ type: EventTable.type, data: EventTable.data }).from(EventTable).orderBy(EventTable.seq).all(),
        ).toEqual([{ type: "session.archive.changed.1", data: { sessionID, archived: 0 } }])
      }),
    )
  })

  test("keeps full-persist Bus profiles retaining archive and unrelated events", async () => {
    await using tmp = await tmpdir()
    await run(
      path.join(tmp.path, "full.sqlite"),
      true,
      Effect.gen(function* () {
        yield* seed
        const definition = archiveDefinition()
        expect(definition, "SessionEvent.ArchiveChanged must exist").toBeDefined()
        const bus = yield* Bus.Service
        yield* bus.publish(definition! as never, { sessionID, archived: 0 } as never)
        yield* bus.publish(SessionEvent.Renamed, { sessionID, title: "ordinary" })
        expect((yield* (yield* Database.Service).db.select().from(EventTable).all()).map((row) => row.type)).toEqual([
          "session.archive.changed.1",
          "session.renamed.1",
        ])
      }),
    )
  })

  test("retains only required archive rows from a mixed default-profile publishAll batch", async () => {
    await using tmp = await tmpdir()
    await run(
      path.join(tmp.path, "batch.sqlite"),
      false,
      Effect.gen(function* () {
        yield* seed
        const definition = archiveDefinition()
        expect(definition, "SessionEvent.ArchiveChanged must exist").toBeDefined()
        const bus = yield* Bus.Service
        yield* bus.publishAll([
          [definition! as never, { sessionID, archived: 0 } as never],
          [SessionEvent.Renamed, { sessionID, title: "ordinary" }],
        ])
        expect((yield* (yield* Database.Service).db.select().from(EventTable).all()).map((row) => [row.seq, row.type])).toEqual([
          [0, "session.archive.changed.1"],
        ])
      }),
    )
  })

  test("makes archive replay duplicate-safe and rejects divergent or gapped inputs", async () => {
    await using tmp = await tmpdir()
    await run(
      path.join(tmp.path, "replay.sqlite"),
      false,
      Effect.gen(function* () {
        yield* seed
        const bus = yield* Bus.Service
        const event = archiveEvent("evt_archive_exact", 0, 0)
        yield* bus.replay(event)
        yield* bus.replay(event)
        expect(Exit.isFailure(yield* bus.replay({ ...event, data: { sessionID, archived: 2 } }).pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* bus.replay(archiveEvent("evt_archive_gap", 2, null)).pipe(Effect.exit))).toBe(true)
      }),
    )
  })

  test("replays a fresh full log into the same archive state", async () => {
    await using tmp = await tmpdir()
    const source = path.join(tmp.path, "source.sqlite")
    const target = path.join(tmp.path, "target.sqlite")
    let events: (typeof EventTable.$inferSelect)[] = []

    await run(
      source,
      true,
      Effect.gen(function* () {
        yield* seed
        const definition = archiveDefinition()
        expect(definition, "SessionEvent.ArchiveChanged must exist").toBeDefined()
        const bus = yield* Bus.Service
        yield* bus.publish(definition! as never, { sessionID, archived: 0 } as never)
        yield* bus.publish(definition! as never, { sessionID, archived: null } as never)
        events = yield* (yield* Database.Service).db.select().from(EventTable).orderBy(EventTable.seq).all()
      }),
    )
    await run(
      target,
      true,
      Effect.gen(function* () {
        yield* seed
        const bus = yield* Bus.Service
        yield* Effect.forEach(events, (event) =>
          bus.replay({
            id: event.id,
            aggregateID: event.aggregate_id,
            seq: event.seq,
            created: event.created,
            type: event.type,
            data: event.data,
          }),
        )
        expect((yield* (yield* Database.Service).db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get())?.time_archived).toBeNull()
      }),
    )
  })

  test("projects epoch-zero archive then restore idempotently, writes NULL, and never recreates a missing session", async () => {
    await using tmp = await tmpdir()
    await run(
      path.join(tmp.path, "projector.sqlite"),
      false,
      Effect.gen(function* () {
        const db = yield* seed
        const bus = yield* Bus.Service
        yield* bus.replay(archiveEvent("evt_archive_zero", 0, 0))
        const archived = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()
        expect(archived).toMatchObject({ time_archived: 0, time_updated: 10 })
        yield* bus.replay(archiveEvent("evt_archive_repeat", 1, 99))
        expect(yield* db.select({ archived: SessionTable.time_archived, updated: SessionTable.time_updated }).from(SessionTable).get()).toEqual({
          archived: 0,
          updated: 10,
        })
        yield* bus.replay(archiveEvent("evt_archive_restore", 2, null))
        expect(yield* db.select({ archived: SessionTable.time_archived, updated: SessionTable.time_updated }).from(SessionTable).get()).toEqual({
          archived: null,
          updated: 12,
        })
        yield* bus.replay(archiveEvent("evt_archive_restore_repeat", 3, null))
        expect(yield* db.select({ archived: SessionTable.time_archived, updated: SessionTable.time_updated }).from(SessionTable).get()).toEqual({
          archived: null,
          updated: 12,
        })

        const missing = SessionID.make("ses_archive_missing_projector")
        yield* bus.replay({ ...archiveEvent("evt_archive_missing", 0, 0), aggregateID: missing, data: { sessionID: missing, archived: 0 } })
        expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, missing)).get()).toBeUndefined()
      }),
    )
  })
})

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const migrationRun = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provideService(Global.Service, Global.make({ data: path.join(process.cwd(), ".test-data") })),
        Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })),
      ) as never,
    ),
  )

test("V1 migration preserves null, zero, and nonzero archive times and info decodes zero as archived", async () => {
  await migrationRun(
    Effect.gen(function* () {
      const db = yield* makeDb
      yield* DatabaseMigration.apply(db)
      yield* db.run(sql`CREATE TABLE session (
        id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text, slug text NOT NULL,
        directory text NOT NULL, path text, title text, version text NOT NULL, share_url text,
        summary_additions integer, summary_deletions integer, summary_files integer, summary_diffs text, metadata text,
        cost real NOT NULL DEFAULT 0, tokens_input integer NOT NULL DEFAULT 0, tokens_output integer NOT NULL DEFAULT 0,
        tokens_reasoning integer NOT NULL DEFAULT 0, tokens_cache_read integer NOT NULL DEFAULT 0,
        tokens_cache_write integer NOT NULL DEFAULT 0, revert text, permission text, agent text, model text,
        time_created integer NOT NULL, time_updated integer NOT NULL, time_compacting integer, time_archived integer
      )`)
      yield* db.run(sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`)
      yield* db.run(sql`CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`)
      yield* db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, time_archived) VALUES
        ('ses_archive_null', 'global', 'null', '/project', 'Null', '1', 1, 2, NULL),
        ('ses_archive_zero', 'global', 'zero', '/project', 'Zero', '1', 1, 2, 0),
        ('ses_archive_nonzero', 'global', 'nonzero', '/project', 'Nonzero', '1', 1, 2, 42)`)
      yield* V1Migration.run().pipe(Effect.provideService(Database.Service, { db }))
      const rows = yield* db.select().from(SessionTable).orderBy(SessionTable.id).all()
      expect(rows.map((row) => [row.id, row.time_archived])).toEqual([
        [SessionID.make("ses_archive_nonzero"), 42],
        [SessionID.make("ses_archive_null"), null],
        [SessionID.make("ses_archive_zero"), 0],
      ])
      const zero = rows.find((row) => row.id === "ses_archive_zero")
      expect(fromRow(zero!).time.archived).toBeDefined()
    }),
  )
})
