/**
 * @spec-handoff
 * @interface SessionEvent.ArchiveChanged: DurableDefinition<"session.archive.changed", { sessionID: Session.ID; archived: number | null }>
 * @behavior
 *   - Publishes a version-1, session-aggregate durable event in the public and durable manifests.
 *   - Requires durable metadata retain: true without encoding that metadata into the event payload.
 *   - Round-trips archive timestamps including epoch zero and restore null.
 * @edge-cases
 *   - Finite numeric timestamps are accepted; NaN and infinities are rejected.
 */
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { DurableEventManifest } from "../src/durable-event-manifest.js"
import { EventManifest } from "../src/event-manifest.js"
import { SessionEvent } from "../src/session-event.js"
import { SessionID } from "../src/session-id.js"

describe("SessionEvent.ArchiveChanged", () => {
  const sessionID = SessionID.make("ses_archive_event")
  const definition = SessionEvent.ArchiveChanged

  test("is the public, version-1 retained durable archive transition", () => {
    expect(definition.type).toBe("session.archive.changed")
    expect(definition.durable).toMatchObject({ aggregate: "sessionID", version: 1, retain: true })
    expect(EventManifest.Server.get("session.archive.changed")).toBe(definition)
    expect(EventManifest.Latest.get("session.archive.changed")).toBe(definition)
    expect(DurableEventManifest.Durable.get("session.archive.changed.1")).toBe(definition)
  })

  test.each([0, 1_735_689_600_123, null] as const)("round-trips archived=%p", (archived) => {
    const data = Schema.decodeUnknownSync(definition.data)({ sessionID, archived })
    expect(Schema.encodeSync(definition.data)(data)).toEqual({ sessionID, archived })
  })

  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite archive timestamp %p",
    (archived) => {
      expect(() => Schema.decodeUnknownSync(definition.data)({ sessionID, archived })).toThrow()
    },
  )
})
