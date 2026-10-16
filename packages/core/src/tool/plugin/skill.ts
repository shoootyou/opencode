export * as SkillTool from "./skill.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { ToolFailure } from "@opencode/ai"
import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import { Skill } from "../../skill.js"
import { Permission } from "../../permission.js"
import { ConfigSkillReload } from "../../config/skill-reload.js"

export const name = "skill"

export const Input = Schema.Struct({
  id: Skill.ID.annotate({ description: "The ID of an available skill or a skill explicitly referenced by the user" }),
})

export const Output = Schema.Struct({
  name: Skill.Name,
  directory: Schema.String,
  output: Schema.String,
})

const ReloadInput = Schema.Struct({})
const ReloadOutput = Schema.Struct({
  count: Schema.Number,
})
export const description = [
  "Load a specialized skill's instructions and resources into the current conversation when the task at hand matches its description.",
  "",
  "The skill ID must match an available skill or a skill explicitly referenced by the user.",
].join("\n")

export const toModelOutput = Skill.toModelOutput

const unableToLoad = (name: string, error?: unknown) =>
  new ToolFailure({ message: `Unable to load skill ${name}`, error })

export const Plugin = {
  id: "opencode.tool.skill",
  effect: Effect.fn("SkillTool.Plugin")(function* (ctx: Context) {
    const fs = yield* FSUtil.Service
    const skills = yield* Skill.Service
    const permission = yield* Permission.Service
    const reload = yield* ConfigSkillReload.Service
    yield* ctx.tool
      .transform((editor) =>
        {
          editor.add({
            name: "reload_skills",
            options: { codemode: false },
            description: "Reload the skills available in this location.",
            input: ReloadInput,
            output: ReloadOutput,
            execute: () =>
              reload.reload().pipe(
                Effect.map((output) => ({
                  output,
                  content: `Reloaded ${output.count} skill${output.count === 1 ? "" : "s"}.`,
                  metadata: {},
                })),
                Effect.catchTags({
                  "ConfigSkillReload.ReloadUnavailable": () =>
                    Effect.fail(
                      new ToolFailure({ message: "Skill reload is unavailable for this location.", error: undefined }),
                    ),
                  "ConfigSkillReload.ReloadFailed": () =>
                    Effect.fail(
                      new ToolFailure({ message: "Unable to reload skills for this location.", error: undefined }),
                    ),
                }),
              ),
          })
          editor.add({
            name,
            options: { codemode: false },
            description,
            input: Input,
            output: Output,
            execute: (input, context) =>
              Effect.gen(function* () {
                const skill = yield* skills.get(input.id)
                if (!skill) return yield* unableToLoad(input.id)
                return yield* Effect.gen(function* () {
                  yield* permission.assert({
                    action: name,
                    resources: [skill.id],
                    save: [skill.id],
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: { type: "tool", messageID: context.messageID, id: context.id },
                  })
                  return { name: skill.name, ...(yield* Skill.prepare(fs, skill)) }
                }).pipe(Effect.mapError((error) => unableToLoad(input.id, error)))
              }).pipe(
                Effect.map((output) => ({
                  output,
                  content: output.output,
                  metadata: { name: output.name, directory: output.directory },
                })),
              ),
          })
        },
      )
      .pipe(Effect.orDie)
  }),
}
