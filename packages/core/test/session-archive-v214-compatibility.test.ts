/**
 * @spec-handoff
 * @interface Session.archive(sessionID): Effect<void>
 * @interface Session.unarchive(sessionID): Effect<void>
 * @behavior
 *   - Native writes retain session.archived.1/session.unarchived.1; legacy session.archive.changed.1 remains replayable unchanged.
 *   - List archived:false returns active, true returns archived, and omission returns both.
 *   - Admission counts native and legacy retained archive transitions together.
 * @edge-cases
 *   - Legacy payload archive time 0 is distinct from envelope creation time, and null restores.
 *   - A legacy payload sessionID must equal its durable aggregateID.
 */
import { describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { eq } from "drizzle-orm"
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
import { SessionEnvironment } from "@opencode/core/session/environment"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { Event } from "@opencode/schema/event"
import { Project } from "@opencode/schema/project"
import { AbsolutePath } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"

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

const sessionID = SessionID.make("ses_v214_compat")
const otherID = SessionID.make("ses_v214_compat_other")

const seed = (
  rows: ReadonlyArray<{ id: SessionID; archived?: number | null; updated?: number }> = [{ id: sessionID }],
) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
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

const nativeType = (archived: boolean) => `session.${archived ? "archived" : "unarchived"}.1`

describe("v2.1.4 archive compatibility contract", () => {
  it.effect("characterizes legacy replay as preserving its journal identity and payload archive time", () =>
    Effect.gen(function* () {
      const db = yield* seed([{ id: sessionID, updated: 5 }])
      const event = {
        id: Event.ID.make("evt_v214_legacy_zero"),
        aggregateID: sessionID,
        seq: 0,
        created: 1234,
        type: "session.archive.changed.1",
        data: { sessionID, archived: 0 },
      }
      yield* (yield* Bus.Service).replay(event)

      expect(yield* db.select().from(EventTable).get()).toMatchObject({
        id: event.id,
        aggregate_id: sessionID,
        seq: 0,
        created: 1234,
        type: "session.archive.changed.1",
        data: { sessionID, archived: 0 },
      })
      expect(
        yield* db
          .select({ archived: SessionTable.time_archived, updated: SessionTable.time_updated })
          .from(SessionTable)
          .get(),
      ).toEqual({
        archived: 0,
        updated: 1234,
      })
    }),
  )

  it.effect(
    "characterizes legacy replay as rejecting aggregate and payload session mismatches without projection",
    () =>
      Effect.gen(function* () {
        const db = yield* seed([{ id: sessionID }, { id: otherID, updated: 9 }])
        const result = yield* (yield* Bus.Service)
          .replay({
            id: Event.ID.make("evt_v214_legacy_mismatch"),
            aggregateID: sessionID,
            seq: 0,
            created: 1234,
            type: "session.archive.changed.1",
            data: { sessionID: otherID, archived: 0 },
          })
          .pipe(Effect.exit)

        expect(Exit.isFailure(result)).toBe(true)
        expect(yield* db.select().from(EventTable).all()).toEqual([])
        expect(
          yield* db
            .select({ archived: SessionTable.time_archived, updated: SessionTable.time_updated })
            .from(SessionTable)
            .where(eq(SessionTable.id, otherID))
            .get(),
        ).toEqual({
          archived: null,
          updated: 9,
        })
      }),
  )

  it.effect(
    "requires an archive transition to publish the native archived event instead of the legacy write event",
    () =>
      Effect.gen(function* () {
        const db = yield* seed()
        yield* (yield* Session.Service).archive(sessionID)

        expect(yield* db.select({ type: EventTable.type, data: EventTable.data }).from(EventTable).all()).toEqual([
          { type: nativeType(true), data: { sessionID } },
        ])
      }),
  )

  it.effect("requires native list flags to distinguish active, archived, and both sessions", () =>
    Effect.gen(function* () {
      yield* seed([
        { id: SessionID.make("ses_v214_active"), updated: 3 },
        { id: SessionID.make("ses_v214_archived"), archived: 0, updated: 2 },
      ])
      const store = yield* SessionStore.Service
      const ids = (input?: Parameters<typeof store.list>[0]) =>
        store.list(input).pipe(Effect.map((sessions) => sessions.map((session) => String(session.id))))

      expect(yield* ids({ archived: false })).toEqual(["ses_v214_active"])
      expect(yield* ids({ archived: true })).toEqual(["ses_v214_archived"])
      expect(yield* ids()).toEqual(["ses_v214_active", "ses_v214_archived"])
    }),
  )

  it.effect(
    "requires admission to count six recent native archive rows before publishing a legacy-compatible transition",
    () =>
      Effect.gen(function* () {
        const db = yield* seed()
        yield* TestClock.setTime(1_000)
        const now = 1_000
        yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 5 }).run()
        yield* db
          .insert(EventTable)
          .values(
            Array.from({ length: 6 }, (_, seq) => ({
              id: Event.ID.make(`evt_v214_recent_native_${seq}`),
              aggregate_id: sessionID,
              seq,
              created: now,
              type: nativeType(seq % 2 === 0),
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

  it.effect(
    "requires retention to reserve the 1,024th retained archive row for restore across native and legacy history",
    () =>
      Effect.gen(function* () {
        const db = yield* seed([{ id: sessionID, archived: 0 }])
        yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 1022 }).run()
        yield* db
          .insert(EventTable)
          .values(
            Array.from({ length: 1023 }, (_, seq) => ({
              id: Event.ID.make(`evt_v214_retained_${seq}`),
              aggregate_id: sessionID,
              seq,
              created: -120_000 + seq,
              type: seq % 3 === 0 ? "session.archive.changed.1" : nativeType(seq % 2 === 0),
              data: seq % 3 === 0 ? { sessionID, archived: seq % 2 === 0 ? 0 : null } : { sessionID },
            })),
          )
          .run()

        const handle = yield* Session.Service
        yield* handle.unarchive(sessionID)
        expect(yield* db.select().from(EventTable).all()).toHaveLength(1024)

        const archive = yield* handle.archive(sessionID).pipe(Effect.exit)
        expect(Exit.isFailure(archive)).toBe(true)
        expect(yield* db.select().from(EventTable).all()).toHaveLength(1024)
        expect(
          yield* db
            .select({ archived: SessionTable.time_archived })
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID))
            .get(),
        ).toEqual({ archived: null })
      }),
  )
})
