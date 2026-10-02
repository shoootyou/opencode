/**
 * @spec-handoff
 * @interface `packages/schema/src/plugin-ui-event.ts` (new file):
 *   export const Custom = Event.define({ type: "plugin.custom", schema: { pluginID: Plugin.ID,
 *   event: Schema.String, data: Schema.Record(Schema.String, Schema.Json) } })
 *   export const Definitions = Event.inventory(Custom)
 *   Follows `tui-event.ts`'s self-reexport convention: `export * as PluginUiEvent from
 *   "./plugin-ui-event"` at the top of the file.
 * @behavior
 *   - `event-manifest.ts` MUST spread `...PluginUiEvent.Definitions` into BOTH
 *     `ServerDefinitions` (:57-61) AND `Definitions` (:63-82) — appended AFTER the existing
 *     spreads in each, so the positional `Definitions.slice(40, 43)` assertion below stays
 *     index-neutral.
 *   - `data` MUST be `Schema.Record(Schema.String, Schema.Json)` — `Schema.Unknown`/`Schema.Any`
 *     is forbidden by this package's own AGENTS.md for current public contracts.
 * @edge-cases
 *   - Not CI-gated (`packages/schema` has no `test` script, per RFC C13) — this file's counts
 *     are correctness-of-record, not a merge fence. `packages/opencode/test/event-manifest.test.ts`
 *     is the CI-gated fence for the ServerDefinitions requirement.
 * @see .yui-soul/rfcs/approved/050-opencode-plugin-ui-event-channel/README.md (D1/D2/D12/D18)
 */
import { describe, expect, test } from "bun:test"
import { FileSystem, Integration, Permission, Project, Reference, Session, Workspace } from "../src"
import { EventManifest } from "../src/event-manifest"
import { IdeEvent } from "../src/ide-event"
import { SessionEvent } from "../src/session-event"
import { SessionTodo } from "../src/session-todo"
import { SessionV1 } from "../src/session-v1"
import { WorkspaceEvent } from "../src/workspace-event"

describe("public event manifest", () => {
  test("owns the complete public event surface", () => {
    expect(EventManifest.ServerDefinitions.length).toBe(59)
    expect(EventManifest.Definitions.length).toBe(89)
    expect(SessionV1.Event.Definitions).toEqual([
      SessionV1.Event.Created,
      SessionV1.Event.Updated,
      SessionV1.Event.Deleted,
      SessionV1.Event.MessageUpdated,
      SessionV1.Event.MessageRemoved,
      SessionV1.Event.PartUpdated,
      SessionV1.Event.PartRemoved,
      SessionV1.Event.PartDelta,
      SessionV1.Event.Diff,
      SessionV1.Event.Error,
    ])
    expect(EventManifest.Latest.size).toBe(89)
    expect(EventManifest.Durable.size).toBe(35)
  })

  test("registers plugin.custom in both the server-decode and full manifests", () => {
    expect(EventManifest.ServerDefinitions.some((d) => d.type === "plugin.custom")).toBe(true)
    expect(EventManifest.Definitions.some((d) => d.type === "plugin.custom")).toBe(true)
    expect(EventManifest.Latest.has("plugin.custom")).toBe(true)
  })

  test("uses canonical definitions for current public events", () => {
    expect(Session.Event).toBe(SessionEvent)
    expect(Session.Event.Definitions).toBe(SessionEvent.Definitions)
    expect(Workspace.Event).toBe(WorkspaceEvent)
    expect(Workspace.Event.Definitions).toBe(WorkspaceEvent.Definitions)
    expect(EventManifest.Latest.get("session.next.step.ended")).toBe(SessionEvent.Step.Ended)
    expect(EventManifest.Latest.get("todo.updated")).toBe(SessionTodo.Event.Updated)
    expect(EventManifest.Latest.get("project.updated")).toBe(Project.Event.Updated)
    expect(Project.Event.Definitions).toEqual([Project.Event.Updated])
    expect(FileSystem.Event.Definitions).toEqual([FileSystem.Event.Edited])
    expect(Integration.Event.Definitions).toEqual([Integration.Event.Updated, Integration.Event.ConnectionUpdated])
    expect(Permission.Event.Definitions).toEqual([Permission.Event.Asked, Permission.Event.Replied])
    expect(Reference.Event.Definitions).toEqual([Reference.Event.Updated])
    expect(EventManifest.Latest.has("ide.installed")).toBe(false)
    expect(IdeEvent.Definitions).toEqual([IdeEvent.Installed])
    expect(EventManifest.Definitions.slice(40, 43)).toEqual([
      SessionV1.Event.PartDelta,
      SessionV1.Event.Diff,
      SessionV1.Event.Error,
    ])
    expect(EventManifest.Durable.has("session.next.step.ended.1")).toBe(false)
    expect(EventManifest.Durable.get("session.next.step.ended.2")).toBe(SessionEvent.Step.Ended)
  })
})
