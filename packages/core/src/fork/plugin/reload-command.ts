export * as ReloadCommand from "./reload-command.js"

import { define } from "@opencode/plugin/effect/plugin"
import { DISPLAY_ONLY_MARKER } from "@opencode/schema/fork-command-feedback"
import { Effect } from "effect"
import { Bus } from "../../bus.js"
import { ForkCapabilities } from "../capabilities/service.js"
import { SessionEvent } from "../../session/event.js"

export const Plugin = define({
  id: "opencode.fork.reload-command",
  effect: Effect.fn(function* (ctx) {
    const bus = yield* Bus.Service
    const capabilities = yield* ForkCapabilities.Service
    yield* ctx.command.transform((editor) => {
      editor.add({
        name: "reload",
        description: "Reload available skills from disk without restarting",
        execute: (input) => {
          const publish = (text: string, outcome: "success" | "error") =>
            bus.publish(SessionEvent.Synthetic, {
              sessionID: input.sessionID,
              text,
              description: text,
              metadata: { [DISPLAY_ONLY_MARKER]: true, source: "command", command: "reload", outcome },
            })
          const fail = (text: string) => publish(text, "error").pipe(Effect.andThen(Effect.fail(new Error(text))))

          return capabilities.reload().pipe(
            Effect.flatMap((output) =>
              publish(`Reloaded ${output.count} skill${output.count === 1 ? "" : "s"}.`, "success"),
            ),
            Effect.catchTags({
              "ConfigSkillReload.ReloadUnavailable": () => fail("Skill reload is unavailable for this location."),
              "ConfigSkillReload.ReloadFailed": () => fail("Unable to reload skills for this location."),
              "ConfigSkillReload.ReloadTeardown": () =>
                fail("Skill reload was interrupted because this location closed."),
            }),
            Effect.asVoid,
          )
        },
      })
    })
  }),
})
