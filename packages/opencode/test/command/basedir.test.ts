/**
 * @spec-handoff
 * @interface Command.Service.get(name: string): Effect.Effect<Command.Info | undefined>
 * @interface Command.Service.list(): Effect.Effect<Command.Info[]>
 * @behavior
 *   Point 7 reconciliation (spec-reconciliation.md): the lazy skill-as-command
 *   registration path (both `get` and `list`, in command/index.ts) now applies
 *   upstream's base-directory enrichment pattern. For a skill whose `location`
 *   is a real on-disk path (not the `"<built-in>"` sentinel), the returned
 *   command's `template` is the skill's raw content PLUS two extra appended
 *   lines: a blank line, `Base directory for this skill: <dirname(location)>`,
 *   and a note that relative paths in the skill are relative to that directory.
 *   For a skill whose `location === "<built-in>"`, `template` is the raw
 *   content unchanged — no base-directory lines appended.
 * @edge-cases
 *   - Disk skill via `Command.get(name)` → template contains
 *     `Base directory for this skill: <dir>` where `<dir>` is exactly
 *     `path.dirname(location)`.
 *   - Built-in skill via `Command.get(name)` → template does NOT contain
 *     "Base directory for this skill:" anywhere.
 *   - Same contract for `Command.list()`'s skill-derived entries (the
 *     `skillCmds` branch), not just `get()` — both code paths independently
 *     duplicate the `dir`/template-enrichment logic in command/index.ts.
 * @testability
 *   Command.Service is built via `AppNodeBuilder.build(Command.node, [...])`,
 *   replacing `Skill.node`, `MCP.node`, and `Config.node` with lightweight
 *   mocks so this test never touches real disk skill discovery, MCP transport,
 *   or user config — only the enrichment logic in command/index.ts itself.
 * @see ../../src/command/index.ts (Command.Service.get, Command.Service.list)
 * @see ../../src/skill/index.ts (Skill.Info shape, `location` field)
 */

import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { Skill } from "@/skill"
import { Command } from "@/command"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const rand = crypto.randomUUID().slice(0, 8)
const diskSkillName = `shin-basedir-disk-${rand}`
const builtinSkillName = `shin-basedir-builtin-${rand}`
const diskSkillDir = `/fake/skills-root/${diskSkillName}`

const diskSkill: Skill.Info = {
  name: diskSkillName,
  description: "a disk-backed skill",
  location: `${diskSkillDir}/SKILL.md`,
  content: "# disk skill content",
}

const builtinSkill: Skill.Info = {
  name: builtinSkillName,
  description: "a built-in skill",
  location: "<built-in>",
  content: "# builtin skill content",
}

const skillList = [diskSkill, builtinSkill]

const mockSkillLayer = Layer.succeed(
  Skill.Service,
  Skill.Service.of({
    get: (name) => Effect.succeed(skillList.find((s) => s.name === name)),
    require: () => Effect.die("not needed by this test"),
    all: () => Effect.succeed(skillList),
    dirs: () => Effect.succeed([]),
    available: () => Effect.succeed(skillList),
    refresh: () => Effect.succeed(skillList),
  }),
)

// MCP is replaced entirely — this test only cares about the skill-as-command
// enrichment path, never real MCP transport or prompt resolution. Command's
// init() only ever calls `mcp.prompts()`, so only that method is stubbed;
// `Layer.mock` makes any unstubbed call throw an UnimplementedError defect
// instead of silently succeeding with a placeholder.
const mockMcpLayer = Layer.mock(MCP.Service, {
  prompts: () => Effect.succeed({}),
})

const configLayer = Layer.succeed(Config.Service, TestConfig.make())

const it = testEffect(
  AppNodeBuilder.build(Command.node, [
    [Skill.node, mockSkillLayer],
    [MCP.node, mockMcpLayer],
    [Config.node, configLayer],
  ]),
)

const resolveTemplate = (template: Promise<string> | string) =>
  typeof template === "string" ? Effect.succeed(template) : Effect.promise(() => template)

describe("Command — skill-as-command base-directory enrichment (Point 7)", () => {
  it.instance("get(): a disk-backed skill's template includes the base directory line", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const info = yield* command.get(diskSkillName)
      expect(info).toBeDefined()
      const template = yield* resolveTemplate(info!.template)

      expect(template).toContain(`Base directory for this skill: ${diskSkillDir}`)
      expect(template).toContain("Relative paths in this skill")
      expect(template.startsWith("# disk skill content")).toBe(true)
    }),
  )

  it.instance("get(): a <built-in> skill's template does NOT include a base directory line", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const info = yield* command.get(builtinSkillName)
      expect(info).toBeDefined()
      const template = yield* resolveTemplate(info!.template)

      expect(template).toBe("# builtin skill content")
      expect(template).not.toContain("Base directory for this skill:")
    }),
  )

  it.instance("list(): the disk-backed skill entry includes the base directory line", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const all = yield* command.list()
      const diskEntry = all.find((entry) => entry.name === diskSkillName)
      expect(diskEntry).toBeDefined()
      const template = yield* resolveTemplate(diskEntry!.template)

      expect(template).toContain(`Base directory for this skill: ${diskSkillDir}`)
    }),
  )

  it.instance("list(): the <built-in> skill entry does NOT include a base directory line", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const all = yield* command.list()
      const builtinEntry = all.find((entry) => entry.name === builtinSkillName)
      expect(builtinEntry).toBeDefined()
      const template = yield* resolveTemplate(builtinEntry!.template)

      expect(template).toBe("# builtin skill content")
      expect(template).not.toContain("Base directory for this skill:")
    }),
  )
})
