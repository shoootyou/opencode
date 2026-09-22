/**
 * @spec-handoff
 * @interface PluginUiEvent.Custom = Event.define({ type: "plugin.custom", schema: {
 *   pluginID: Plugin.ID, event: Schema.String, data: Schema.Record(Schema.String, Schema.Json) } })
 * @behavior
 *   - `plugin.custom` MUST be present in the public `EventManifest.Latest` map (client-facing).
 *   - `plugin.custom` MUST be present in `SchemaEventManifest.ServerDefinitions` — the closed
 *     union `packages/protocol/src/groups/event.ts` decodes the v2 wire path against. Presence
 *     only in `Definitions` is NOT sufficient: `ServerDefinitions` is a narrower list and the v2
 *     decode path uses it exclusively (see `packages/schema/src/event-manifest.ts:57-61` vs
 *     `:63-82`). Omitting it here reproduces the `server.heartbeat` silent-drop class of bug
 *     (`adaptServerEvent`'s catch-all -> `properties: undefined`).
 * @edge-cases
 *   - `event` (the sub-type discriminator) lives in the STRING FIELD, not the schema `type` —
 *     unlike `TuiEvent`'s 4-member literal union. One `Event.define` covers all plugin custom
 *     event names.
 * @see .yui-soul/rfcs/approved/050-opencode-plugin-ui-event-channel/README.md (D1/D2/D12)
 * @see packages/schema/src/tui-event.ts (self-reexport + Event.define convention to follow)
 */
import { describe, expect, test } from "bun:test"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { EventManifest as SchemaEventManifest } from "@opencode-ai/schema/event-manifest"
import { Todo } from "@/session/todo"
import { EventManifest } from "@/event-manifest"

describe("public event manifest", () => {
  test("contains every latest public wire type once", () => {
    expect(EventManifest.Definitions).toBe(SchemaEventManifest.Definitions)
    expect(EventManifest.Latest).toBe(SchemaEventManifest.Latest)
    expect(EventManifest.Durable).toBe(SchemaEventManifest.Durable)
    expect(EventManifest.Latest.size).toBe(89)
    expect(EventManifest.Latest.get("session.next.step.ended")).toBe(SessionEvent.Step.Ended)
    expect(EventManifest.Latest.get("todo.updated")).toBe(Todo.Event.Updated)
    expect(EventManifest.Latest.has("ide.installed")).toBe(false)
    expect(EventManifest.Latest.has("server.connected")).toBe(true)
    expect(EventManifest.Latest.has("global.disposed")).toBe(true)
  })

  test("registers plugin.custom in both the public and server-decode manifests", () => {
    expect(EventManifest.Latest.has("plugin.custom")).toBe(true)
    expect(SchemaEventManifest.ServerDefinitions.some((d) => d.type === "plugin.custom")).toBe(true)
  })

  test("contains only the current step settlement versions", () => {
    expect(EventManifest.Durable.has("session.next.step.ended.1")).toBe(false)
    expect(EventManifest.Durable.get("session.next.step.ended.2")).toBe(SessionEvent.Step.Ended)
  })
})
