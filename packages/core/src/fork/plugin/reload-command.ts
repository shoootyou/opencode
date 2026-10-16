export * as ReloadCommand from "./reload-command.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { ForkCapabilities } from "../capabilities/service.js"

export const Plugin = define({
  id: "opencode.fork.reload-command",
  effect: Effect.fn(function* (ctx) {
    const capabilities = yield* ForkCapabilities.Service
    yield* ctx.command.transform((editor) => {
      editor.add({
        name: "reload",
        description: "Reload available skills from disk without restarting",
        execute: (input) =>
          capabilities.reload().pipe(
            Effect.flatMap((output) =>
              ctx.session.synthetic({
                sessionID: input.sessionID,
                text: `Reloaded ${output.count} skill${output.count === 1 ? "" : "s"}.`,
                resume: false,
              }),
            ),
            Effect.asVoid,
            Effect.catchTags({
              "ConfigSkillReload.ReloadUnavailable": () =>
                Effect.fail(new Error("Skill reload is unavailable for this location.")),
              "ConfigSkillReload.ReloadFailed": () => Effect.fail(new Error("Unable to reload skills for this location.")),
              "ConfigSkillReload.ReloadTeardown": () =>
                Effect.fail(new Error("Skill reload was interrupted because this location closed.")),
            }),
          ),
      })
    })
  }),
})
