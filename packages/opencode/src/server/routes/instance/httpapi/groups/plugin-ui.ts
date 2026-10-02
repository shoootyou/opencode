import { Plugin } from "@opencode-ai/schema/plugin"
import { PluginUiEvent } from "@opencode-ai/schema/plugin-ui-event"
import { DateTimeUtcFromMillis } from "@opencode-ai/core/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { InvalidRequestError } from "../errors"
import { described } from "./metadata"

const root = "/plugin-ui"

// Reuses the canonical `plugin.custom` event data schema rather than
// re-declaring an identical struct (schema/AGENTS.md: "Preserve a single
// canonical event definition").
export const PublishPayload = PluginUiEvent.Custom.data

export const SnapshotEntry = Schema.Struct({
  directory: Schema.String,
  pluginID: Plugin.ID,
  event: Schema.String,
  data: Schema.Record(Schema.String, Schema.Json),
  publishedAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "PluginUiSnapshotEntry" })

export const SnapshotResponse = Schema.Struct({
  serverTime: DateTimeUtcFromMillis,
  entries: Schema.Array(SnapshotEntry),
}).annotate({ identifier: "PluginUiSnapshotResponse" })

export const PluginUiPaths = {
  publish: `${root}/publish`,
  snapshot: `${root}/snapshot`,
} as const

export const PluginUiApi = HttpApi.make("plugin-ui")
  .add(
    HttpApiGroup.make("plugin-ui")
      .add(
        HttpApiEndpoint.post("publish", PluginUiPaths.publish, {
          query: WorkspaceRoutingQuery,
          payload: PublishPayload,
          success: described(Schema.Boolean, "Event published successfully"),
          error: [HttpApiError.BadRequest, InvalidRequestError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "plugin-ui.publish",
            summary: "Publish a plugin UI event",
            description: "Validate, retain, then relay one plugin-authored `plugin.custom` event.",
          }),
        ),
        HttpApiEndpoint.get("snapshot", PluginUiPaths.snapshot, {
          query: WorkspaceRoutingQuery,
          success: described(SnapshotResponse, "Retained plugin UI entries across every open directory"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "plugin-ui.snapshot",
            summary: "Read retained plugin UI entries",
            description:
              "Last retained value per (directory, pluginID, eventName), aggregated across every directory the server currently holds plugin UI state for.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({ title: "plugin-ui", description: "Plugin UI event channel relay + retained snapshot." }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
