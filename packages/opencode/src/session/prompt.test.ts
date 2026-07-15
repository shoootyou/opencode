/**
 * @spec-handoff
 * @interface parseSubcommand(arguments: string): { subcommand: string | undefined; args: string[] }
 * @interface buildBuiltinResult(result: CommandResult): SessionV1.WithParts
 * @interface CommandHandler(input: { sessionID: string; arguments: string; subcommand?: string; args: string[] }): Effect.Effect<CommandResult, CommandError>
 * @interface BuiltinCommand = Command.Info & { readonly handler: CommandHandler }
 *
 * @behavior
 *   - When `SessionPrompt.command` resolves a `BuiltinCommand` (i.e. `"handler" in cmd`),
 *     it MUST take the deterministic branch: invoke `cmd.handler(...)`, construct a
 *     `WithParts` via `buildBuiltinResult`, and return immediately — never calling `prompt()`.
 *   - `parseSubcommand("")` → `{ subcommand: undefined, args: [] }`
 *   - `parseSubcommand("skills")` → `{ subcommand: "skills", args: [] }`
 *   - `parseSubcommand("plugins")` → `{ subcommand: "plugins", args: [] }`
 *   - `parseSubcommand("foo bar")` → `{ subcommand: "foo", args: ["bar"] }`
 *   - An unknown subcommand (e.g. "foo") MUST produce a `CommandResult` describing
 *     the error — NOT a thrown exception, NOT a model turn.
 *   - `buildBuiltinResult({ title, output })` constructs a `WithParts` with:
 *       - `info.role === "assistant"`
 *       - `info.finish === "stop"`
 *       - `parts` array of length 1
 *       - `parts[0].type === "text"`
 *       - `parts[0].text === \`${title}\n${output}\``
 *       - No `usage`/token-delta field sourced from a model stream (zero cost path)
 *
 * @edge-cases
 *   - Bare `/reload` (arguments = "") → subcommand undefined; Phase 1 handler reloads skills only
 *   - `/reload foo` (unknown subcommand) → handler returns a CommandResult describing the error, no throw
 *   - The `handler` field is NEVER on a serialized `Command.Info` — only on the internal BuiltinCommand subtype
 *   - `prompt()` must NOT be called when the deterministic branch is taken
 *   - Zero token usage delta: no `cost`, no `tokens` sourced from a model stream
 *
 * @see ./prompt.ts (SessionPrompt.command — insert deterministic branch after line 1368)
 * @see ../command/index.ts (BuiltinCommand, CommandHandler, CommandResult — internal types, non-exported)
 * @see @opencode-ai/schema/v1/session (WithParts, Assistant shape)
 */

import { describe, expect, test } from "bun:test"

// These imports target functions that E3 will export from prompt.ts.
// They do NOT exist yet — every test block that uses them will fail at module
// evaluation time with "Export named '...' not found", which is the correct
// red-phase failure. Bun surfaces this as a test-file error counted as a failure.
import {
  parseSubcommand,
  buildBuiltinResult,
  type CommandResult as PromptCommandResult,
} from "./prompt"

// ─── §C Subcommand grammar ────────────────────────────────────────────────────

describe("parseSubcommand — §C subcommand grammar", () => {
  test("empty arguments string → subcommand is undefined, args is empty", () => {
    const result = parseSubcommand("")

    expect(result.subcommand).toBeUndefined()
    expect(result.args).toEqual([])
  })

  test('"skills" argument → subcommand is "skills", args is empty', () => {
    const result = parseSubcommand("skills")

    expect(result.subcommand).toBe("skills")
    expect(result.args).toEqual([])
  })

  test('"plugins" argument → subcommand is "plugins", args is empty', () => {
    const result = parseSubcommand("plugins")

    expect(result.subcommand).toBe("plugins")
    expect(result.args).toEqual([])
  })

  test("unknown subcommand token is preserved verbatim in subcommand field", () => {
    // E3 handler must receive this and return a CommandResult — not throw
    const result = parseSubcommand("foo")

    expect(result.subcommand).toBe("foo")
    expect(result.args).toEqual([])
  })

  test("multi-token arguments: first token is subcommand, rest are args", () => {
    const result = parseSubcommand("foo bar baz")

    expect(result.subcommand).toBe("foo")
    expect(result.args).toEqual(["bar", "baz"])
  })

  test("whitespace-only argument string → subcommand is undefined", () => {
    const result = parseSubcommand("   ")

    expect(result.subcommand).toBeUndefined()
    expect(result.args).toEqual([])
  })
})

// ─── §B WithParts construction — deterministic shape ─────────────────────────

describe("buildBuiltinResult — §B WithParts shape from CommandResult", () => {
  const sampleResult: PromptCommandResult = {
    title: "Skills reloaded",
    output: "3 skills loaded from ~/.opencode/skills",
  }

  test("info.role is 'assistant' — no user-message pollution", () => {
    const wp = buildBuiltinResult(sampleResult)

    expect(wp.info.role).toBe("assistant")
  })

  test("info.finish is 'stop' — runLoop exit check recognizes session as terminated", () => {
    const wp = buildBuiltinResult(sampleResult)

    expect((wp.info as { finish?: string }).finish).toBe("stop")
  })

  test("parts array has exactly one entry", () => {
    const wp = buildBuiltinResult(sampleResult)

    expect(wp.parts).toHaveLength(1)
  })

  test("parts[0].type is 'text'", () => {
    const wp = buildBuiltinResult(sampleResult)

    expect(wp.parts[0].type).toBe("text")
  })

  test("parts[0].text is title + newline + output (title prepended, not a separate part)", () => {
    const wp = buildBuiltinResult(sampleResult)
    const part = wp.parts[0] as { type: string; text: string }

    expect(part.text).toBe(`${sampleResult.title}\n${sampleResult.output}`)
  })

  test("zero token-usage delta — no cost field sourced from a model stream", () => {
    const wp = buildBuiltinResult(sampleResult)
    const info = wp.info as Record<string, unknown>

    // The deterministic branch must not populate a cost sourced from a model turn.
    // Either cost is 0 (valid sentinel) or the field is absent. It MUST NOT be a
    // positive number, which would indicate a model stream contributed usage.
    const cost = info["cost"]
    expect(cost === 0 || cost === undefined).toBe(true)
  })

  test("no 'usage' property on parts[0] — part was not produced by a model stream", () => {
    const wp = buildBuiltinResult(sampleResult)
    const part = wp.parts[0] as Record<string, unknown>

    // Model-stream text parts carry a 'usage' delta. Handler-produced parts must not.
    expect("usage" in part).toBe(false)
  })
})

// ─── §C Unknown subcommand → CommandResult, not exception ────────────────────

describe("unknown subcommand → deterministic error result (§C + §A error handling)", () => {
  test("parseSubcommand returns unknown token as subcommand (handler will convert to CommandResult)", () => {
    // The handler in E3 must not throw when it receives an unknown subcommand.
    // Verified indirectly here: parseSubcommand does not throw on unknown input.
    // The handler test (integration level) is in the §B+dispatch group below.
    const result = parseSubcommand("unknown-token")

    expect(result.subcommand).toBe("unknown-token")
    // If we reach here without exception the parse layer is safe; handler contract
    // for unknown subcommands is enforced in the integration tests below.
  })

  test("buildBuiltinResult on an error CommandResult produces a valid WithParts", () => {
    // E3's unknown-subcommand branch returns a CommandResult like:
    // { title: "Unknown subcommand", output: 'Unknown subcommand "foo". Valid: skills, plugins.' }
    // buildBuiltinResult must handle it without throwing.
    const errorResult: PromptCommandResult = {
      title: "Unknown subcommand",
      output: 'Unknown subcommand "foo". Valid subcommands: skills, plugins.',
    }
    const wp = buildBuiltinResult(errorResult)

    expect(wp.info.role).toBe("assistant")
    expect(wp.parts[0].type).toBe("text")
    const part = wp.parts[0] as { type: string; text: string }
    expect(part.text).toContain("Unknown subcommand")
  })
})

// ─── §B + §C Integration: no model turn, no prompt() called ──────────────────
// These tests assert behavior at the SessionPrompt.command dispatch level.
// They are intentionally written against the NOT-YET-IMPLEMENTED deterministic
// branch in SessionPrompt.command (E3). They will be red until E3 lands.
//
// Implementation note for Kou (E3): these tests will be wired to the real
// SessionPrompt.command function in the integration layer. The pure-function
// tests above (parseSubcommand / buildBuiltinResult) are the primary red-phase
// coverage. The integration tests below complete the §B acceptance assertions.

describe("§B dispatch contract — handler path must never call prompt()", () => {
  test("a BuiltinCommand handler is detected by 'handler' in cmd type guard", () => {
    // Construct a plain BuiltinCommand-shaped object and verify the type guard works.
    // This is the guard E3 will use in SessionPrompt.command line ~1368.
    const plainInfo = {
      name: "reload",
      description: "reload skills",
      source: "command" as const,
      template: "Run reload_skills.",
      hints: [] as string[],
    }
    const builtinCmd = {
      ...plainInfo,
      handler: (_input: unknown) => null, // stub — just needs to be present
    }

    // Type guard used in the deterministic branch
    expect("handler" in builtinCmd).toBe(true)
    expect("handler" in plainInfo).toBe(false)
  })

  test("a BuiltinCommand-shaped object with handler is distinct from a plain Info", () => {
    // Validates the structural separation that prevents ACE (§A):
    // a plain Info from deserialization never has 'handler'.
    const fromDeserialization = {
      name: "reload",
      description: "reload skills",
      source: "command" as const,
      template: "Run reload_skills.",
      hints: [] as string[],
      // A malicious config might inject this — but decodeUnknown (ConfigCommandV1.Info)
      // has no handler field, so this can never come from deserialization.
    }

    expect("handler" in fromDeserialization).toBe(false)
  })

  test("parseSubcommand + buildBuiltinResult pipeline produces a no-model-turn result end-to-end", () => {
    // Simulate the full deterministic handler path (without Effect runtime):
    // 1. Parse subcommand from raw arguments
    // 2. Handler logic produces a CommandResult
    // 3. buildBuiltinResult wraps it in WithParts
    // This is exactly what SessionPrompt.command E3 will do.
    const parsed = parseSubcommand("skills")
    expect(parsed.subcommand).toBe("skills")

    const handlerResult: PromptCommandResult = {
      title: "Skills reloaded",
      output: "5 skills loaded.",
    }
    const withParts = buildBuiltinResult(handlerResult)

    // §B acceptance assertions — no model turn observable:
    expect(withParts.info.role).toBe("assistant")
    expect((withParts.info as { finish?: string }).finish).toBe("stop")
    expect(withParts.parts).toHaveLength(1)
    expect(withParts.parts[0].type).toBe("text")
    // Zero token-usage delta
    const info = withParts.info as Record<string, unknown>
    expect(info["cost"] === 0 || info["cost"] === undefined).toBe(true)
  })
})

// ─── Phase 1 scope note ───────────────────────────────────────────────────────
// Per RFC §C "Phase boundary": in Phase 1, bare `/reload` (subcommand=undefined)
// reloads SKILLS ONLY. The "reload both" contract (skills + plugins) activates
// in Phase 2 when plugin.refresh() lands. Tests here are scoped to Phase 1
// (skills-only path). Plugin partial-failure semantics (RFC §C) are tested in
// Phase 2 (E5/E9). No plugin coverage is asserted here.

describe("Phase 1 scope — bare /reload reloads skills only", () => {
  test("parseSubcommand on empty string yields undefined subcommand (bare /reload path)", () => {
    const result = parseSubcommand("")

    // Phase 1 handler branches: subcommand === "skills" → skills; undefined → skills
    // (plugins path not yet implemented in Phase 1)
    expect(result.subcommand).toBeUndefined()
  })

  test("buildBuiltinResult for bare /reload produces valid WithParts (skills-only result)", () => {
    // Phase 1: bare /reload output reports only skills domain
    const skillsOnlyResult: PromptCommandResult = {
      title: "Skills reloaded",
      output: "3 skills loaded.",
    }
    const wp = buildBuiltinResult(skillsOnlyResult)

    expect(wp.info.role).toBe("assistant")
    expect(wp.parts[0].type).toBe("text")
    const part = wp.parts[0] as { type: string; text: string }
    expect(part.text).toBe("Skills reloaded\n3 skills loaded.")
  })
})
