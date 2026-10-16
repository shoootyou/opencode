/**
 * @spec-handoff
 * @interface reload_skills({}): { count: number }
 * @behavior
 *   - Registers exactly one direct, non-CodeMode reload_skills tool through the location-scoped Tool registry.
 *   - Invokes the captured ConfigSkillReload service once and returns only its nonnegative count.
 *   - Renders a count-only singular/plural-safe confirmation without leaking skill metadata or reload causes.
 * @edge-cases
 *   - ReloadUnavailable, ReloadFailed, and ReloadTeardown become their distinct safe ToolFailure messages.
 *   - Unexpected defects and caller interruption remain unaltered rather than normal tool failures.
 * @mutation-targets typed teardown catch; catchCause interruption conversion; defect conversion
 */
import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Permission } from "@opencode/core/permission"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { Skill } from "@opencode/core/skill"
import { Config } from "@opencode/core/config"
import { ConfigSkillReload } from "@opencode/core/config/skill-reload"
import { Location } from "@opencode/core/location"
import { ManagedPolicy } from "@opencode/core/managed-policy"
import { SkillTool } from "@opencode/core/tool/plugin/skill"
import { Tool } from "@opencode/core/tool"
import { tmpdir } from "./fixture/tmpdir"
import { Image } from "@opencode/core/image"
import { it } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { permissionLayer } from "./lib/permission"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { codeModeListings, toolIdentity, executeTool, registerToolPlugin, toolDefinitions } from "./lib/tool"
import { registerIntegrationPolicy } from "./fixture/policy"
import { location } from "./fixture/location"

const skillToolNode = makeLocationNode({
  name: "test/skill-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(SkillTool.Plugin)),
  deps: [Tool.node, FSUtil.node, Skill.node, Permission.node, ConfigSkillReload.node],
})

const sessionID = Session.ID.make("ses_skill_tool_test")

const skillToolTestLayer = () =>
  AppNodeBuilder.build(
    LayerNode.group([Tool.node, skillToolNode, Skill.node, Config.node, Permission.node, ConfigSkillReload.node]),
    [
    Config.node.replace(Config.testLayer()),
    Location.node.replace(
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/tmp/tool-skill") }))),
    ),
    Image.node.replace(imagePassthrough),
    ],
  )

describe("SkillTool", () => {
  it.live("registers a single direct reload_skills tool that reports only the refreshed count", () =>
    Effect.gen(function* () {
      const reload = yield* ConfigSkillReload.Service
      let calls = 0
      yield* reload.install(() => Effect.sync(() => ({ count: ++calls })))
      const registry = yield* Tool.Service
      const snapshot = yield* registry.snapshot()
      const definitions = yield* toolDefinitions(registry)

      expect(definitions.filter((definition) => definition.name === "reload_skills")).toHaveLength(1)
      expect(codeModeListings(snapshot.codeModeCatalog!)).not.toContainEqual(
        expect.objectContaining({ name: "reload_skills" }),
      )
      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-reload-skills", name: "reload_skills", input: {} },
        }),
      ).toEqual({
        status: "completed",
        output: { count: 1 },
        content: [{ type: "text", text: "Reloaded 1 skill." }],
        metadata: {},
      })
      expect(calls).toBe(1)
    }).pipe(
      Effect.provide(
        skillToolTestLayer(),
      ),
    ),
  )

  it.live("renders plural count-only reload confirmation without exposing skill sentinels", () =>
    Effect.gen(function* () {
      const reload = yield* ConfigSkillReload.Service
      yield* reload.install(() => Effect.succeed({ count: 2 }))
      const result = yield* executeTool(yield* Tool.Service, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-reload-skills-plural", name: "reload_skills", input: {} },
      })

      expect(result).toEqual({
        status: "completed",
        output: { count: 2 },
        content: [{ type: "text", text: "Reloaded 2 skills." }],
        metadata: {},
      })
      expect(JSON.stringify(result)).not.toContain("sentinel-private-skill")
      expect(JSON.stringify(result)).not.toContain("/sentinel/private/SKILL.md")
      expect(JSON.stringify(result)).not.toContain("sentinel-source")
    }).pipe(Effect.provide(skillToolTestLayer())),
  )

  it.live("maps unavailable and failed reloads to distinct safe tool failures without leaking causes", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      const unavailable = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-reload-skills-unavailable", name: "reload_skills", input: {} },
      })
      expect(unavailable).toEqual({
        status: "error",
        error: { type: "tool.execution", message: "Skill reload is unavailable for this location." },
      })

      const reload = yield* ConfigSkillReload.Service
      yield* reload.install(() => Effect.fail(new Error("sentinel reload cause")))
      const failed = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-reload-skills-failed", name: "reload_skills", input: {} },
      })
      expect(failed).toEqual({
        status: "error",
        error: { type: "tool.execution", message: "Unable to reload skills for this location." },
      })
      expect(JSON.stringify(failed)).not.toContain("sentinel reload cause")
    }).pipe(Effect.provide(skillToolTestLayer())),
  )

  it.live("maps typed teardown to the exact safe tool failure without a synthetic success", () =>
    Effect.gen(function* () {
      const reload = yield* ConfigSkillReload.Service
      yield* reload.install(() => Effect.fail(new ConfigSkillReload.ReloadTeardown()))
      const result = yield* executeTool(yield* Tool.Service, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-reload-skills-teardown", name: "reload_skills", input: {} },
      })
      expect(result).toEqual({
        status: "error",
        error: {
          type: "tool.execution",
          message: "Skill reload was interrupted because this location closed.",
        },
      })
    }).pipe(Effect.provide(skillToolTestLayer())),
  )

  it.live("preserves an unexpected reload defect instead of translating it to a normal tool failure", () =>
    Effect.gen(function* () {
      const reload = yield* ConfigSkillReload.Service
      yield* reload.install(() => Effect.die("sentinel unexpected reload defect"))
      const result = yield* (yield* Tool.Service)
        .snapshot()
        .pipe(
          Effect.flatMap((registry) =>
            registry.execute({
              sessionID,
              ...toolIdentity,
              call: { type: "tool-call", id: "call-reload-skills-defect", name: "reload_skills", input: {} },
            }),
          ),
          Effect.exit,
        )

      expect(Exit.isFailure(result)).toBe(true)
      expect(JSON.stringify(result)).toContain("sentinel unexpected reload defect")
    }).pipe(Effect.provide(skillToolTestLayer())),
  )

  test("escapes raw structural metadata once while preserving the trusted trimmed body", () => {
    const unsafe = Skill.Info.make({
      id: Skill.ID.make("unsafe"),
      name: Skill.Name.make("Name&lt;&amp;<&>'\""),
      path: AbsolutePath.make("/skills/base&lt;&amp;<&>'\"/SKILL.md"),
      content: "  <trusted>&body'\"</trusted>  \n",
    })

    const files = ["/skills/base&lt;&amp;<&>'\"/file<&>'\".md"]
    const first = Skill.toModelOutput(unsafe, files)
    expect(first).toBe(
      [
        '<skill_content name="Name&amp;lt;&amp;amp;&lt;&amp;&gt;&apos;&quot;">',
        "# Skill: Name&amp;lt;&amp;amp;&lt;&amp;&gt;&apos;&quot;",
        "",
        "<trusted>&body'\"</trusted>",
        "",
        "Base directory for this skill: /skills/base&amp;lt;&amp;amp;&lt;&amp;&gt;&apos;&quot;",
        "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
        "Note: file list is sampled.",
        "",
        "<skill_files>",
        "<file>/skills/base&amp;lt;&amp;amp;&lt;&amp;&gt;&apos;&quot;/file&lt;&amp;&gt;&apos;&quot;.md</file>",
        "</skill_files>",
        "</skill_content>",
      ].join("\n"),
    )
    expect(Skill.toModelOutput(unsafe, files)).toBe(first)
    expect(unsafe).toMatchObject({
      name: "Name&lt;&amp;<&>'\"",
      path: "/skills/base&lt;&amp;<&>'\"/SKILL.md",
      content: "  <trusted>&body'\"</trusted>  \n",
    })
    expect(files).toEqual(["/skills/base&lt;&amp;<&>'\"/file<&>'\".md"])
  })

  it.effect("refuses a policy-blocked skill before authorization or content preparation", () =>
    Effect.gen(function* () {
      const skills = yield* Skill.Service
      const managed = yield* ManagedPolicy.Service
      const tools = yield* Tool.Service
      // This path does not exist; an attempted content scan would fail the test.
      yield* skills.transform((editor) =>
        editor.add(
          Skill.Info.make({
            id: Skill.ID.make("private"),
            name: Skill.Name.make("Private"),
            path: AbsolutePath.make("/unavailable/private/SKILL.md"),
            content: "Private instructions",
          }),
        ),
      )
      yield* managed.set({ statements: [{ action: "integration.use", resource: "skill:private", effect: "deny" }] })
      yield* registerIntegrationPolicy({ skill: skills })
      expect(
        yield* executeTool(tools, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-policy-denied-skill", name: "skill", input: { id: "private" } },
        }),
      ).toEqual({ status: "error", error: { type: "tool.execution", message: "Unable to load skill private" } })
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([Tool.node, skillToolNode, Skill.node, Config.node, ManagedPolicy.node]), [
          Config.node.replace(Config.testLayer()),
          Permission.node.replace(permissionLayer({ assert: () => Effect.die("Blocked skill reached authorization") })),
          Image.node.replace(imagePassthrough),
        ]),
      ),
    ),
  )

  it.live("lists available skills, authorizes the selected ID, and loads model-facing content", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const directory = path.join(tmp.path, "effect")
          const location = path.join(directory, "SKILL.md")
          const reference = path.join(directory, "reference.md")
          yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
          yield* Effect.promise(() =>
            Promise.all([fs.writeFile(location, "unused"), fs.writeFile(reference, "reference")]),
          )

          const info: Skill.Info = {
            id: Skill.ID.make("effect"),
            name: Skill.Name.make("Effect"),
            description: "Use Effect",
            path: AbsolutePath.make(location),
            content: "# Effect\n\nGuidance",
          }
          let current = [info]
          const assertions: Permission.AssertInput[] = []
          let deny = false
          const permission = permissionLayer({
            assert: (input) =>
              Effect.sync(() => assertions.push(input)).pipe(
                Effect.andThen(
                  deny
                    ? Effect.fail(
                        new Permission.BlockedError({
                          rules: [],
                          permission: input.action,
                          resources: input.resources,
                        }),
                      )
                    : Effect.void,
                ),
              ),
          })
          const skills = Layer.mock(Skill.Service, {
            get: (id) => Effect.succeed(current.find((skill) => skill.id === id)),
            list: () => Effect.succeed(current),
          })
          const skillToolLayer = AppNodeBuilder.build(LayerNode.group([Tool.node, skillToolNode]), [
            Permission.node.replace(permission),
            Skill.node.replace(skills),
            Image.node.replace(imagePassthrough),
          ])

          return yield* Effect.gen(function* () {
            const registry = yield* Tool.Service
            expect((yield* toolDefinitions(registry)).find((definition) => definition.name === "skill")).toMatchObject({
              name: "skill",
              description: SkillTool.description,
            })
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-skill", name: "skill", input: { id: "effect" } },
              }),
            ).toMatchObject({
              status: "completed",
              content: [{ type: "text", text: Skill.toModelOutput(info, [reference]) }],
            })
            expect(Skill.toModelOutput(info, [reference])).toContain(`Base directory for this skill: ${directory}`)
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-skill-overflow", name: "skill", input: { id: "effect" } },
              }),
            ).toEqual({
              status: "completed",
              output: { name: "Effect", directory, output: Skill.toModelOutput(info, [reference]) },
              content: [{ type: "text", text: Skill.toModelOutput(info, [reference]) }],
              metadata: { name: "Effect", directory },
            })
            expect(assertions).toMatchObject([
              { sessionID, action: "skill", resources: ["effect"], save: ["effect"] },
              { sessionID, action: "skill", resources: ["effect"], save: ["effect"] },
            ])
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-missing-skill", name: "skill", input: { id: "missing" } },
              }),
            ).toEqual({
              status: "error",
              error: { type: "tool.execution", message: "Unable to load skill missing" },
            })
            deny = true
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-denied-skill", name: "skill", input: { id: "effect" } },
              }),
            ).toEqual({
              status: "error",
              error: { type: "permission.rejected", message: "Permission denied: skill" },
            })
            deny = false
            const flat = Skill.Info.make({
              id: Skill.ID.make("public"),
              name: Skill.Name.make("Public"),
              description: "Public guidance",
              path: AbsolutePath.make(path.join(tmp.path, "public.md")),
              content: "Public",
            })
            yield* Effect.promise(() =>
              Promise.all([
                fs.writeFile(flat.path, "public"),
                fs.writeFile(path.join(tmp.path, "secret.md"), "secret"),
              ]),
            )
            current = [flat]
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-flat-skill", name: "skill", input: { id: "public" } },
              }),
            ).toMatchObject({
              status: "completed",
              content: [{ type: "text", text: Skill.toModelOutput(flat, []) }],
            })
          }).pipe(Effect.provide(skillToolLayer))
        }),
      ),
    ),
  )
})
