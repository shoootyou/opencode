import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import type { InstanceContext } from "@/project/instance-context"
import { Effect, Layer, Context, Schema } from "effect"
import { Config } from "@/config/config"
import { MCP } from "../mcp"
import { Skill } from "../skill"
import { EventV2 } from "@opencode-ai/core/event"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"
import { LegacyEvent } from "@opencode-ai/schema/legacy-event"

// Internal-only — never serialized, never produced by deserialization.
// The handler lives here, NOT on the public Command.Info schema, to prevent any
// config/MCP/markdown deserialization path from ever producing an arbitrary handler
// (ACE-prevention control — see RFC 001 §A / Ei F1).
type CommandResult = { title: string; output: string }
type CommandError = { _tag: "CommandError"; message: string }
type CommandHandler = (input: {
  sessionID: string
  arguments: string
  subcommand?: string
  args: string[]
}) => Effect.Effect<CommandResult, CommandError>
type BuiltinCommand = Info & { readonly handler: CommandHandler }

type State = {
  commands: Record<string, BuiltinCommand | Info>
}

export const Event = {
  Executed: LegacyEvent.CommandExecuted,
  CatalogUpdated: EventV2.define({
    type: "command.catalog.updated" as const,
    schema: {},
  }),
}

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literals(["command", "mcp", "skill"])),
  // Some command templates are lazy promises from MCP prompt resolution.
  template: Schema.Unknown,
  subtask: Schema.optional(Schema.Boolean),
  hints: Schema.Array(Schema.String),
}).annotate({ identifier: "Command" })

export type Info = Omit<Schema.Schema.Type<typeof Info>, "template"> & { template: Promise<string> | string }

export function hints(template: string) {
  const result: string[] = []
  const numbered = template.match(/\$\d+/g)
  if (numbered) {
    for (const match of [...new Set(numbered)].sort()) result.push(match)
  }
  if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
  return result
}

export const Default = {
  INIT: "init",
  REVIEW: "review",
} as const

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Command") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const skill = yield* Skill.Service

    const init = Effect.fn("Command.state")(function* (ctx: InstanceContext) {
      const cfg = yield* config.get()
      const bridge = yield* EffectBridge.make()
      const commands: Record<string, Info> = Object.create(null) as Record<string, Info>

      commands[Default.INIT] = {
        name: Default.INIT,
        description: "guided AGENTS.md setup",
        source: "command",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", ctx.worktree)
        },
        hints: hints(PROMPT_INITIALIZE),
      }
      commands[Default.REVIEW] = {
        name: Default.REVIEW,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        source: "command",
        get template() {
          return PROMPT_REVIEW.replace("${path}", ctx.worktree)
        },
        subtask: true,
        hints: hints(PROMPT_REVIEW),
      }
      commands["reload"] = {
        name: "reload",
        description: "Reload available skills (and in future, plugins) without restarting",
        source: "command",
        template: "",
        hints: [],
        handler: ((input: Parameters<CommandHandler>[0]) =>
          Effect.gen(function* () {
            const { subcommand } = input
            if (subcommand === "plugins")
              return { title: "/reload plugins", output: "plugins: not available until Phase 2" } as CommandResult
            if (subcommand !== undefined && subcommand !== "skills")
              return {
                title: "/reload",
                output: `unknown subcommand '${subcommand}'. Valid: skills, plugins`,
              } as CommandResult
            // subcommand === "skills" or undefined (bare /reload) → reload skills
            return yield* skill.refresh().pipe(
              Effect.map(
                (list): CommandResult => ({
                  title: "/reload skills",
                  output: `skills: reloaded (${list.length} skills)`,
                }),
              ),
              Effect.catchDefect(
                (err): Effect.Effect<CommandResult> =>
                  Effect.succeed({
                    title: "/reload skills",
                    output: `skills: FAILED (${err instanceof Error ? err.message : String(err)})`,
                  }),
              ),
            )
          })) as CommandHandler,
      } as unknown as BuiltinCommand

      for (const [name, command] of Object.entries(cfg.command ?? {})) {
        commands[name] = {
          name,
          agent: command.agent,
          model: command.model,
          description: command.description,
          source: "command",
          get template() {
            return command.template
          },
          subtask: command.subtask,
          hints: hints(command.template),
        }
      }

      for (const [name, prompt] of Object.entries(yield* mcp.prompts())) {
        commands[name] = {
          name,
          source: "mcp",
          description: prompt.description,
          get template() {
            return bridge.promise(
              mcp
                .getPrompt(
                  prompt.client,
                  prompt.name,
                  prompt.arguments
                    ? Object.fromEntries(prompt.arguments.map((argument, i) => [argument.name, `$${i + 1}`]))
                    : {},
                )
                .pipe(
                  Effect.map(
                    (template) =>
                      template?.messages
                        .map((message) => (message.content.type === "text" ? message.content.text : ""))
                        .join("\n") || "",
                  ),
                ),
            )
          },
          hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
        }
      }

      return {
        commands,
      }
    })

    const state = yield* InstanceState.make<State>((ctx) => init(ctx))

    const get = Effect.fn("Command.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      if (Object.hasOwn(s.commands, name)) return s.commands[name]
      const item = yield* skill.get(name)
      if (!item) return undefined
      const dir = item.location === "<built-in>" ? undefined : path.dirname(item.location)
      return {
        name: item.name,
        description: item.description ?? "",
        source: "skill" as const,
        get template() {
          if (!dir) return item.content
          return [
            item.content,
            "",
            `Base directory for this skill: ${dir}`,
            "Relative paths in this skill (e.g., scripts/, references/) are relative to this base directory.",
          ].join("\n")
        },
        hints: [] as string[],
      }
    })

    const list = Effect.fn("Command.list")(function* () {
      const s = yield* InstanceState.get(state)
      const skills = yield* skill.all()
      const skillCmds = skills
        .filter((item) => !Object.hasOwn(s.commands, item.name) && item.description)
        .map((item) => {
          const dir = item.location === "<built-in>" ? undefined : path.dirname(item.location)
          return {
            name: item.name,
            description: item.description ?? "",
            source: "skill" as const,
            get template() {
              if (!dir) return item.content
              return [
                item.content,
                "",
                `Base directory for this skill: ${dir}`,
                "Relative paths in this skill (e.g., scripts/, references/) are relative to this base directory.",
              ].join("\n")
            },
            hints: [] as string[],
          }
        })
      return [...Object.values(s.commands), ...skillCmds]
    })

    return Service.of({ get, list })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [Config.node, MCP.node, Skill.node] })

export * as Command from "."
