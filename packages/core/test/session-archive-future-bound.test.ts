/**
 * @spec-handoff
 * @interface Session.archive(sessionID) / Session.unarchive(sessionID): Effect<void>
 * @behavior
 *   - Bounded near-future archive history consumes rate budget; farther future history does not.
 *   - Retention counts every retained archive-family row and replay preserves historical envelopes.
 * @edge-cases
 *   - Boundary timestamps, stale publication retries, duplicate replay, no-ops, and reopened SQLite handles preserve atomic state.
 */
import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { EventSequenceTable, EventTable } from "@opencode/core/event/sql"
import { Instance } from "@opencode/core/instance/service"
import { LocationServiceMap } from "@opencode/core/location-services"
import { Project as CoreProject } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionEnvironment } from "@opencode/core/session/environment"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionProjector } from "@opencode/core/session/projector"
import { make } from "@opencode/core/session/session"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { Event } from "@opencode/schema/event"
import { Project } from "@opencode/schema/project"
import { AbsolutePath } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { FSUtil } from "@opencode/util/fs-util"
import { LayerNode } from "@opencode/util/effect/layer-node"
import path from "path"
import { offlineModels } from "./fixture/models"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"

const T = 3_000_000
const future = T + 31_536_000_000
const sessionID = SessionID.make("ses_archive_future_bound")
const types = ["session.archive.changed.1", "session.archived.1", "session.unarchived.1"] as const

const node = (databasePath?: string) =>
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
      Database.node.replace(Database.configured(databasePath ? { path: databasePath } : undefined)),
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
  )

const it = testEffect(node())

const seed = (archived = false, id = sessionID) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        directory: "/project",
        slug: String(sessionID),
        version: "test",
        time_archived: archived ? 1 : null,
        time_created: 1,
        time_updated: 1,
      })
      .run()
    return db
  })

const event = (
  id: string,
  seq: number,
  created: number,
  type: (typeof types)[number],
  archived?: number | null,
  aggregateID = sessionID,
) => ({
  id: Event.ID.make(id),
  aggregateID,
  seq,
  created,
  type,
  data:
    type === "session.archive.changed.1"
      ? { sessionID: aggregateID, archived: archived ?? 0 }
      : { sessionID: aggregateID },
})

const expectLimit = (exit: Exit.Exit<unknown, unknown>, kind: "rate" | "retention", retryAfterMillis?: number) => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) return
  expect(exit.cause.reasons.some(Cause.isDieReason)).toBe(false)
  expect(exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)).toMatchObject([
    { _tag: "Session.ArchiveLimitError", kind, ...(retryAfterMillis === undefined ? {} : { retryAfterMillis }) },
  ])
}

const snapshot = (db: ReturnType<typeof Database.Service.of>["db"]) =>
  Effect.all({
    session: db
      .select({ archived: SessionTable.time_archived, updated: SessionTable.time_updated })
      .from(SessionTable)
      .get(),
    sequence: db.select().from(EventSequenceTable).all(),
    rows: db.select().from(EventTable).orderBy(EventTable.seq).all(),
  })

const nativeWithGate = (gate: (real: Bus.Interface) => Effect.Effect<void>) =>
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
        definition.type === SessionEvent.Archived.type || definition.type === SessionEvent.Unarchived.type
          ? gate(real).pipe(Effect.andThen(real.publish(definition, data, options)))
          : real.publish(definition, data, options),
    }
    return yield* make().pipe(
      Effect.provideService(Bus.Service, bus),
      Effect.provideService(Database.Service, database),
      Effect.provideService(SessionStore.Service, store),
      Effect.provideService(Instance.Service, instances),
      Effect.provideService(SessionInbox.Service, inbox),
      Effect.provideService(FSUtil.Service, fs),
      Effect.provide(SessionExecution.noopLayer),
    )
  })

describe("bounded future archive admission", () => {
  it.effect("replays all legacy, native, and mixed far-future histories without locking either real transition", () =>
    Effect.gen(function* () {
      const variants = [
        [
          "session.archive.changed.1",
          "session.archive.changed.1",
          "session.archive.changed.1",
          "session.archive.changed.1",
          "session.archive.changed.1",
          "session.archive.changed.1",
        ],
        [
          "session.archived.1",
          "session.unarchived.1",
          "session.archived.1",
          "session.unarchived.1",
          "session.archived.1",
          "session.unarchived.1",
        ],
        [
          "session.archive.changed.1",
          "session.archived.1",
          "session.unarchived.1",
          "session.archive.changed.1",
          "session.archived.1",
          "session.unarchived.1",
        ],
      ] as const
      for (const [index, [variant, endsArchived]] of variants
        .flatMap((variant) => [[variant, false] as const, [variant, true] as const])
        .entries()) {
        const id = SessionID.make(`ses_archive_future_variant_${index}`)
        const db = yield* seed(endsArchived, id)
        yield* TestClock.setTime(T)
        const bus = yield* Bus.Service
        const direction = (type: (typeof types)[number]) =>
          endsArchived && type !== "session.archive.changed.1"
            ? type === "session.archived.1"
              ? "session.unarchived.1"
              : "session.archived.1"
            : type
        const retained =
          variants.indexOf(variant) === 0
            ? variant.map((type, seq) =>
                event(
                  `evt_future_legacy_${index}_${seq}`,
                  seq,
                  future,
                  direction(type),
                  endsArchived ? (seq % 2 === 0 ? null : future) : seq % 2 === 0 ? future : null,
                  id,
                ),
              )
            : variant.map((type, seq) =>
                event(`evt_future_${index}_${seq}`, seq, future, direction(type), undefined, id),
              )
        for (const row of retained) yield* bus.replay(row)
        yield* db
          .update(SessionTable)
          .set({ time_archived: endsArchived ? future : null, time_updated: future })
          .where(eq(SessionTable.id, id))
          .run()
        const before = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, id))
          .orderBy(EventTable.seq)
          .all()
        if (endsArchived) yield* (yield* Session.Service).unarchive(id)
        else yield* (yield* Session.Service).archive(id)
        const rows = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, id))
          .orderBy(EventTable.seq)
          .all()
        expect(rows.slice(0, 6)).toEqual(before)
        expect(rows).toHaveLength(7)
        expect(rows.at(-1)).toMatchObject({
          seq: 6,
          type: endsArchived ? "session.unarchived.1" : "session.archived.1",
        })
        expect(
          yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, id)).all(),
        ).toEqual([{ aggregate_id: id, seq: 6, owner_id: null }])
      }
    }),
  )

  it.effect("keeps real rate limiting after excluded future history and filters before applying the six-row cap", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      yield* TestClock.setTime(T)
      const bus = yield* Bus.Service
      for (const seq of Array.from({ length: 6 }, (_, index) => index))
        yield* bus.replay(event(`evt_far_${seq}`, seq, future, types[seq % 3], seq % 2 === 0 ? future : null))
      const session = yield* Session.Service
      for (const transition of [
        session.archive,
        session.unarchive,
        session.archive,
        session.unarchive,
        session.archive,
        session.unarchive,
      ])
        yield* transition(sessionID)
      let notifications = 0
      yield* bus.listen(() => Effect.sync(() => ++notifications))
      const before = yield* snapshot(db)
      expectLimit(yield* session.archive(sessionID).pipe(Effect.exit), "rate", 60_000)
      expect(yield* snapshot(db)).toEqual(before)
      expect(notifications).toBe(0)
      yield* TestClock.adjust("60 seconds")
      yield* session.archive(sessionID)

      yield* db.delete(EventTable).run()
      yield* db.delete(EventSequenceTable).run()
      yield* db.update(SessionTable).set({ time_archived: null, time_updated: T }).run()
      const filtered = db
      yield* TestClock.setTime(T)
      yield* filtered.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 10 }).run()
      yield* filtered
        .insert(EventTable)
        .values(
          Array.from({ length: 11 }, (_, seq) => ({
            id: Event.ID.make(`evt_filter_${seq}`),
            aggregate_id: sessionID,
            seq,
            created: seq < 6 ? future + seq : T,
            type: types[seq % 3],
            data:
              types[seq % 3] === "session.archive.changed.1" ? { sessionID, archived: seq % 2 === 0 } : { sessionID },
          })),
        )
        .run()
      yield* session.archive(sessionID)
      expectLimit(yield* session.unarchive(sessionID).pipe(Effect.exit), "rate", 60_000)
    }),
  )

  for (const [name, created, admitted, retry] of [
    ["includes the upper future boundary", T + 60_000, false, 120_000],
    ["excludes the strict lower boundary", T - 60_000, true, undefined],
    ["includes one millisecond above the lower boundary", T - 59_999, false, 1],
  ] as const)
    it.effect(name, () =>
      Effect.gen(function* () {
        const db = yield* seed()
        yield* TestClock.setTime(T)
        yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 5 }).run()
        yield* db
          .insert(EventTable)
          .values(
            Array.from({ length: 6 }, (_, seq) => ({
              id: Event.ID.make(`evt_boundary_${created}_${seq}`),
              aggregate_id: sessionID,
              seq,
              created,
              type: types[seq % 3],
              data:
                types[seq % 3] === "session.archive.changed.1" ? { sessionID, archived: seq % 2 === 0 } : { sessionID },
            })),
          )
          .run()
        const before = yield* snapshot(db)
        const result = yield* (yield* Session.Service).archive(sessionID).pipe(Effect.exit)
        if (admitted) {
          expect(Exit.isSuccess(result)).toBe(true)
          expect((yield* snapshot(db)).rows).toHaveLength(7)
          return
        }
        expectLimit(result, "rate", retry)
        expect(yield* snapshot(db)).toEqual(before)
      }),
    )

  it.effect(
    "retries a stale near-future race then returns the typed rate refusal without publishing a seventh event",
    () =>
      Effect.gen(function* () {
        const db = yield* seed()
        yield* TestClock.setTime(T)
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let notifications = 0
        const bus = yield* Bus.Service
        yield* bus.listen(() => Effect.sync(() => ++notifications))
        let gated = false
        const sessions = yield* nativeWithGate((real) => {
          if (gated) return Effect.void
          gated = true
          return Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                for (const seq of Array.from({ length: 6 }, (_, index) => index))
                  yield* real
                    .replay(event(`evt_race_${seq}`, seq, T + 1, types[seq % 3], seq % 2 === 0 ? T + 1 : null))
                    .pipe(Effect.orDie)
                return yield* Deferred.await(release)
              }),
            ),
          )
        })
        const attempt = yield* sessions.forSession(sessionID).archive().pipe(Effect.exit, Effect.forkScoped)
        yield* Deferred.await(entered)
        yield* Deferred.succeed(release, undefined)
        expectLimit(yield* Fiber.join(attempt), "rate", 60_001)
        expect(yield* db.select().from(EventTable).all()).toHaveLength(6)
        expect(yield* db.select().from(EventSequenceTable).all()).toEqual([
          { aggregate_id: sessionID, seq: 5, owner_id: null },
        ])
        expect(notifications).toBe(0)
      }),
  )
})

test("far-future retention remains SQL-derived after reopening, while no-ops preserve poisoned history", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "archive-future.sqlite")
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromise(
      effect.pipe(Effect.scoped, Effect.provide(node(filename) as never), Effect.provide(TestClock.layer())) as never,
    )
  await run(
    Effect.gen(function* () {
      const db = yield* seed()
      yield* TestClock.setTime(T)
      yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 1021 }).run()
      yield* db
        .insert(EventTable)
        .values(
          Array.from({ length: 1022 }, (_, seq) => ({
            id: Event.ID.make(`evt_retention_${seq}`),
            aggregate_id: sessionID,
            seq,
            created: future + seq,
            type: types[seq % 3],
            data:
              types[seq % 3] === "session.archive.changed.1" ? { sessionID, archived: seq % 2 === 0 } : { sessionID },
          })),
        )
        .run()
      const session = yield* Session.Service
      yield* session.archive(sessionID)
      yield* session.unarchive(sessionID)
      expect(yield* db.select().from(EventTable).all()).toHaveLength(1024)
      expectLimit(yield* session.archive(sessionID).pipe(Effect.exit), "retention")
    }),
  )
  await run(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      expect(yield* db.select().from(EventTable).all()).toHaveLength(1024)
      expectLimit(yield* (yield* Session.Service).archive(sessionID).pipe(Effect.exit), "retention")
    }),
  )
})

it.effect(
  "preserves future envelopes through duplicate replay and log watermark while no-op commands bypass poisoned admission",
  () =>
    Effect.gen(function* () {
      const db = yield* seed(true)
      yield* TestClock.setTime(T)
      const bus = yield* Bus.Service
      const first = event("evt_future_duplicate", 0, future, "session.archived.1")
      yield* bus.replay(first)
      yield* bus.replay(first)
      expect(Exit.isFailure(yield* bus.replay({ ...first, created: future + 1 }).pipe(Effect.exit))).toBe(true)
      const log = Array.from(yield* Stream.runCollect(bus.log({ aggregateID: sessionID })))
      expect(log[0]).toMatchObject({ id: first.id, created: future, durable: { seq: 0 } })
      expect(log.at(-1)).toMatchObject({ type: "log.synced", seq: 0 })
      yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 1023 }).onConflictDoNothing().run()
      const before = yield* snapshot(db)
      yield* (yield* Session.Service).archive(sessionID)
      expect(yield* snapshot(db)).toEqual(before)
    }),
)
