export * as PluginUiEvent from "./plugin-ui-event"

import { Schema } from "effect"
import { Event } from "./event"
import { Plugin } from "./plugin"

export const Custom = Event.define({
  type: "plugin.custom",
  schema: {
    pluginID: Plugin.ID,
    event: Schema.String,
    data: Schema.Record(Schema.String, Schema.Json),
  },
})

export const Definitions = Event.inventory(Custom)
