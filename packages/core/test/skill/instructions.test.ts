/**
 * @spec-handoff
 * @interface SkillInstructions.load(permissions: Permission.Ruleset): Effect<Instructions.List>
 * @behavior
 *   - Renders initial and added skill metadata from raw values, escaping each XML structural character exactly once per final sink.
 *   - Excludes skills denied by the effective permission ruleset from the guidance.
 *   - Preserves raw IDs and names for machine-facing deltas while leaving source skill objects unchanged.
 * @edge-cases
 *   - Raw entity-looking text such as &lt; and &amp; is escaped to &amp;lt; and &amp;amp; rather than treated as pre-escaped XML.
 */
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@opencode/core/agent"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { AbsolutePath } from "@opencode/core/schema"
import { Skill } from "@opencode/core/skill"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { it } from "../lib/effect"
import { readInitial, readUpdate } from "../lib/instructions"

const build = Agent.ID.make("build")
const effect = Skill.Info.make({
  id: Skill.ID.make("effect"),
  name: Skill.Name.make("Effect"),
  description: "Build applications with Effect",
  path: AbsolutePath.make(path.resolve("/skills/effect/SKILL.md")),
  content: "Effect guidance",
})
const hidden = Skill.Info.make({
  id: Skill.ID.make("hidden"),
  name: Skill.Name.make("Hidden"),
  path: AbsolutePath.make(path.resolve("/skills/hidden/SKILL.md")),
  content: "Undescribed guidance",
})
const denied = Skill.Info.make({
  id: Skill.ID.make("denied"),
  name: Skill.Name.make("Denied"),
  description: "Must not be advertised",
  path: AbsolutePath.make(path.resolve("/skills/denied/SKILL.md")),
  content: "Denied guidance",
})
const manual = Skill.Info.make({
  id: Skill.ID.make("manual"),
  name: Skill.Name.make("Manual"),
  description: "Load only when explicitly selected",
  autoinvoke: false,
  path: AbsolutePath.make(path.resolve("/skills/manual/SKILL.md")),
  content: "Manual guidance",
})

const layer = (list: () => Skill.Info[]) =>
  AppNodeBuilder.build(SkillInstructions.node, [
    Skill.node.replace(Layer.mock(Skill.Service, { list: () => Effect.succeed(list()) })),
  ])

describe("SkillInstructions", () => {
  it.effect("renders described agent skills and updates the complete available list", () => {
    const agent = Agent.Info.make({
      ...Agent.Info.default(build),
      permissions: [{ action: "skill", resource: "denied", effect: "deny" }],
    })
    let skills = [hidden, denied, manual, effect]
    return Effect.gen(function* () {
      const instructions = yield* SkillInstructions.Service
      const initialized = yield* instructions.load(agent.permissions).pipe(Effect.flatMap(readInitial))

      expect(initialized.text).toBe(
        [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          "The user may also invoke a skill directly. When that happens, its instructions appear in the conversation as a <skill_content> block, the same shape the skill tool returns. A skill that is already present this way does not need to be invoked again.",
          "<available_skills>",
          "  <skill>",
          "    <id>effect</id>",
          "    <name>Effect</name>",
          "    <description>Build applications with Effect</description>",
          "  </skill>",
          "</available_skills>",
        ].join("\n"),
      )
      expect(initialized.text).not.toContain("manual")

      skills = []
      expect(
        yield* instructions
          .load(agent.permissions)
          .pipe(Effect.flatMap((context) => readUpdate(context, initialized))),
      ).toMatchObject({ text: "Skill guidance is no longer available. Do not use any previously listed skill." })
    }).pipe(Effect.provide(layer(() => skills)))
  })

  it.effect("announces added and removed skills as deltas without restating the list", () => {
    const agent = Agent.Info.make(Agent.Info.default(build))
    const debugging = Skill.Info.make({
      id: Skill.ID.make("debugging"),
      name: Skill.Name.make("Debugging"),
      description: "Diagnose hard bugs",
      path: AbsolutePath.make(path.resolve("/skills/debugging/SKILL.md")),
      content: "Debugging guidance",
    })
    let skills = [effect]
    return Effect.gen(function* () {
      const instructions = yield* SkillInstructions.Service
      const initialized = yield* instructions.load(agent.permissions).pipe(Effect.flatMap(readInitial))

      skills = [effect, debugging]
      const added = yield* instructions
        .load(agent.permissions)
        .pipe(Effect.flatMap((context) => readUpdate(context, initialized)))
      expect(added.text).toBe(
        [
          "New skills are available in addition to those previously listed:",
          "  <skill>",
          "    <id>debugging</id>",
          "    <name>Debugging</name>",
          "    <description>Diagnose hard bugs</description>",
          "  </skill>",
        ].join("\n"),
      )

      skills = [debugging]
      const removed = yield* instructions
        .load(agent.permissions)
        .pipe(Effect.flatMap((context) => readUpdate(context, added)))
      expect(removed.text).toBe("The following skill IDs are no longer available and must not be used: effect.")
    }).pipe(Effect.provide(layer(() => skills)))
  })

  it.effect("restates the full skill list when a description changes", () => {
    const agent = Agent.Info.make(Agent.Info.default(build))
    let skills = [effect]
    return Effect.gen(function* () {
      const instructions = yield* SkillInstructions.Service
      const initialized = yield* instructions.load(agent.permissions).pipe(Effect.flatMap(readInitial))

      skills = [Skill.Info.make({ ...effect, description: "Build applications with Effect v4" })]
      expect(
        yield* instructions
          .load(agent.permissions)
          .pipe(Effect.flatMap((context) => readUpdate(context, initialized))),
      ).toMatchObject({
        text: expect.stringContaining(
          "The available skills have changed. This list supersedes the previous available skills list.",
        ),
      })
    }).pipe(Effect.provide(layer(() => skills)))
  })

  it.effect("omits instructions when the selected agent denies all skills", () => {
    const agent = Agent.Info.make({
      ...Agent.Info.default(build),
      permissions: [{ action: "skill", resource: "*", effect: "deny" }],
    })
    return Effect.gen(function* () {
      const instructions = yield* SkillInstructions.Service
      expect((yield* instructions.load(agent.permissions).pipe(Effect.flatMap(readInitial))).text).toBe("")
    }).pipe(Effect.provide(layer(() => [effect])))
  })

  it.effect("omits instructions when a resource-specific denial follows the global denial", () => {
    const agent = Agent.Info.make({
      ...Agent.Info.default(build),
      permissions: [
        { action: "skill", resource: "*", effect: "deny" },
        { action: "skill", resource: "hidden", effect: "deny" },
      ],
    })
    return Effect.gen(function* () {
      const instructions = yield* SkillInstructions.Service
      expect((yield* instructions.load(agent.permissions).pipe(Effect.flatMap(readInitial))).text).toBe("")
    }).pipe(Effect.provide(layer(() => [effect])))
  })

  it.effect("retains specifically allowed skills after a global denial", () => {
    const agent = Agent.Info.make({
      ...Agent.Info.default(build),
      permissions: [
        { action: "skill", resource: "*", effect: "deny" },
        { action: "skill", resource: "effect", effect: "allow" },
      ],
    })
    return Effect.gen(function* () {
      const instructions = yield* SkillInstructions.Service
      expect(
        (yield* instructions.load(agent.permissions).pipe(Effect.flatMap(readInitial))).text,
      ).toContain("<name>Effect</name>")
    }).pipe(Effect.provide(layer(() => [effect])))
  })

  it.effect("omits instructions when a specifically allowed skill is denied again", () => {
    const agent = Agent.Info.make({
      ...Agent.Info.default(build),
      permissions: [
        { action: "skill", resource: "*", effect: "deny" },
        { action: "skill", resource: "effect", effect: "allow" },
        { action: "skill", resource: "effect", effect: "deny" },
      ],
    })
    return Effect.gen(function* () {
      const instructions = yield* SkillInstructions.Service
      expect((yield* instructions.load(agent.permissions).pipe(Effect.flatMap(readInitial))).text).toBe("")
    }).pipe(Effect.provide(layer(() => [effect])))
  })

  it.effect("escapes available skill metadata without advertising denied skills", () => {
    const agent = Agent.Info.make({
      ...Agent.Info.default(build),
      permissions: [{ action: "skill", resource: "denied<&>'\"", effect: "deny" }],
    })
    const unsafe = Skill.Info.make({
      id: Skill.ID.make("safe<&>'\""),
      name: Skill.Name.make("Name<&>'\""),
      description: "Description<&>'\"",
      path: AbsolutePath.make(path.resolve("/skills/unsafe/SKILL.md")),
      content: "Guidance",
    })
    const unsafeDenied = Skill.Info.make({
      id: Skill.ID.make("denied<&>'\""),
      name: Skill.Name.make("Denied<&>'\""),
      description: "Must remain absent<&>'\"",
      path: AbsolutePath.make(path.resolve("/skills/denied/SKILL.md")),
      content: "Denied guidance",
    })
    return Effect.gen(function* () {
      const instructions = yield* SkillInstructions.Service
      const initialized = yield* instructions.load(agent.permissions).pipe(Effect.flatMap(readInitial))

      expect(initialized.text).toContain(`<id>safe&lt;&amp;&gt;&apos;&quot;</id>`)
      expect(initialized.text).toContain(`<name>Name&lt;&amp;&gt;&apos;&quot;</name>`)
      expect(initialized.text).toContain(`<description>Description&lt;&amp;&gt;&apos;&quot;</description>`)
      expect(initialized.text).not.toContain("denied<&>'\"")
      expect(initialized.text).not.toContain("<skill><")
    }).pipe(Effect.provide(layer(() => [unsafe, unsafeDenied])))
  })

  it.effect("renders each XML guidance sink from raw unsafe metadata without mutating skills", () => {
    const agent = Agent.Info.make({
      ...Agent.Info.default(build),
      permissions: [{ action: "skill", resource: "denied<&>'\"", effect: "deny" }],
    })
    const unsafe = Skill.Info.make({
      id: Skill.ID.make("initial&lt;&amp;<&>'\""),
      name: Skill.Name.make("Initial&lt;&amp;<&>'\""),
      description: "Initial&lt;&amp;<&>'\"",
      path: AbsolutePath.make(path.resolve("/skills/initial/SKILL.md")),
      content: "Initial guidance",
    })
    const addedUnsafe = Skill.Info.make({
      id: Skill.ID.make("added&lt;&amp;<&>'\""),
      name: Skill.Name.make("Added&lt;&amp;<&>'\""),
      description: "Added&lt;&amp;<&>'\"",
      path: AbsolutePath.make(path.resolve("/skills/added/SKILL.md")),
      content: "Added guidance",
    })
    const deniedUnsafe = Skill.Info.make({
      id: Skill.ID.make("denied<&>'\""),
      name: Skill.Name.make("Denied<&>'\""),
      description: "Denied<&>'\"",
      path: AbsolutePath.make(path.resolve("/skills/denied/SKILL.md")),
      content: "Denied guidance",
    })
    const before = [unsafe, addedUnsafe, deniedUnsafe].map((skill) => ({ ...skill }))
    let skills = [unsafe, deniedUnsafe]
    return Effect.gen(function* () {
      const instructions = yield* SkillInstructions.Service
      const initialized = yield* instructions.load(agent.permissions).pipe(Effect.flatMap(readInitial))
      const initialText = initialized.text

      expect(initialText).toContain("<id>initial&amp;lt;&amp;amp;&lt;&amp;&gt;&apos;&quot;</id>")
      expect(initialText).toContain("<name>Initial&amp;lt;&amp;amp;&lt;&amp;&gt;&apos;&quot;</name>")
      expect(initialText).toContain("<description>Initial&amp;lt;&amp;amp;&lt;&amp;&gt;&apos;&quot;</description>")
      expect(initialText).not.toContain("Denied")

      skills = [unsafe, addedUnsafe, deniedUnsafe]
      const added = yield* instructions
        .load(agent.permissions)
        .pipe(Effect.flatMap((context) => readUpdate(context, initialized)))
      expect(added.text).toContain("<id>added&amp;lt;&amp;amp;&lt;&amp;&gt;&apos;&quot;</id>")
      expect(added.text).toContain("<name>Added&amp;lt;&amp;amp;&lt;&amp;&gt;&apos;&quot;</name>")
      expect(added.text).toContain("<description>Added&amp;lt;&amp;amp;&lt;&amp;&gt;&apos;&quot;</description>")

      skills = [addedUnsafe, deniedUnsafe]
      const removed = yield* instructions
        .load(agent.permissions)
        .pipe(Effect.flatMap((context) => readUpdate(context, added)))
      expect(removed.text).toBe("The following skill IDs are no longer available and must not be used: initial&lt;&amp;<&>'\".")
      expect([unsafe, addedUnsafe, deniedUnsafe].map((skill) => ({ ...skill }))).toEqual(before)
    }).pipe(Effect.provide(layer(() => skills)))
  })
})
