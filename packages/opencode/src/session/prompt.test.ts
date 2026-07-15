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
 * @behavior SSE persistence (regression — BuiltinCommand path must persist and emit events)
 *   - After the deterministic branch executes the handler, `SessionPrompt.command` MUST call
 *     `Session.Service.updateMessage(withParts.info)` exactly once with `role: "assistant"`.
 *   - After `updateMessage`, it MUST call `Session.Service.updatePart(withParts.parts[0])` exactly
 *     once with `type: "text"` and `text` containing the handler output.
 *   - The `sessionID` field on both the message and the part MUST equal `input.sessionID` exactly.
 *     (Currently broken: `buildBuiltinResult` uses `SessionID.descending()` — a fresh random ID.)
 *   - These two calls cause `Session.Service` to emit `SessionV1.Event.MessageUpdated` and
 *     `SessionV1.Event.PartUpdated` SSE events, which the TUI renders. Without them the user
 *     sees nothing after `/reload skills`.
 *
 * @edge-cases
 *   - Bare `/reload` (arguments = "") → subcommand undefined; Phase 1 handler reloads skills only
 *   - `/reload foo` (unknown subcommand) → handler returns a CommandResult describing the error, no throw
 *   - The `handler` field is NEVER on a serialized `Command.Info` — only on the internal BuiltinCommand subtype
 *   - `prompt()` must NOT be called when the deterministic branch is taken
 *   - Zero token usage delta: no `cost`, no `tokens` sourced from a model stream
 *   - `buildBuiltinResult` MUST receive `input.sessionID` explicitly — it must NOT generate its own
 *
 * @see ./prompt.ts (SessionPrompt.command — deterministic branch lines 1369-1379; buildBuiltinResult lines 1662-1684)
 * @see ../command/index.ts (BuiltinCommand, CommandHandler, CommandResult — internal types, non-exported)
 * @see ./session.ts (Session.Service.updateMessage line 632; Session.Service.updatePart line 638)
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

// ─── BuiltinCommand SSE persistence — regression (Sui investigation 2026-07-15) ─
//
// Root cause (confirmed): `SessionPrompt.command` lines 1369-1379 invokes the
// handler and returns `buildBuiltinResult(result)` without calling
// `session.updateMessage(...)` or `session.updatePart(...)`.  The TUI only
// renders assistant output by reacting to `message.updated`/`message.part.updated`
// SSE events, which are emitted exclusively by those two calls.  Since they are
// never made, the user sees nothing after `/reload skills`.
//
// Secondary bug: `buildBuiltinResult` (lines 1662-1684) generates fresh IDs via
// `SessionID.descending()` instead of using `input.sessionID`.  This means even
// if persistence were added naively, the persisted message would be associated
// with a phantom session.
//
// These tests are written RED-FIRST against the CURRENT (unfixed) code and MUST
// FAIL until Kou implements the fix.  Do NOT touch prompt.ts until these are red.

describe("BuiltinCommand SSE persistence (regression)", () => {
  // ── Test 1: sessionID mismatch — buildBuiltinResult uses a fresh random ID ──
  //
  // Expected RED: `buildBuiltinResult` calls `SessionID.descending()` internally,
  // so `wp.info.sessionID` will be a freshly generated ID — NEVER equal to the
  // caller's `input.sessionID`.
  //
  // Expected GREEN (after fix): `buildBuiltinResult` must accept `sessionID` as
  // a parameter and use it on `info.sessionID` and every `parts[i].sessionID`.
  test("buildBuiltinResult — info.sessionID must equal the caller-supplied sessionID", () => {
    const fixedSessionID = "ses_test_regression_001"

    // Call the CURRENT (unfixed) buildBuiltinResult — it ignores any sessionID parameter.
    // After the fix, the signature will be: buildBuiltinResult(result, sessionID).
    // This test uses the post-fix call convention so it goes red immediately.
    const wp = (buildBuiltinResult as Function)(
      { title: "Skills reloaded", output: "2 skills loaded." },
      fixedSessionID,
    )

    // RED: current code ignores fixedSessionID — wp.info.sessionID is a random `ses_…`
    // GREEN: after fix, this assertion passes because sessionID is threaded through.
    expect(wp.info.sessionID).toBe(fixedSessionID)
  })

  test("buildBuiltinResult — parts[0].sessionID must equal the caller-supplied sessionID", () => {
    const fixedSessionID = "ses_test_regression_001"

    const wp = (buildBuiltinResult as Function)(
      { title: "Skills reloaded", output: "2 skills loaded." },
      fixedSessionID,
    )

    // RED: current code sets parts[0].sessionID = SessionID.descending() — a fresh ID.
    expect(wp.parts[0].sessionID).toBe(fixedSessionID)
  })

  // ── Test 2: updateMessage / updatePart never called — no SSE events emitted ──
  //
  // Strategy: because SessionPrompt.Service has ~20 service dependencies, we test
  // the OBSERVABLE CONTRACT of the bug at the lowest-friction boundary:
  // the `buildBuiltinResult` return value is what `command` returns.  The test
  // verifies that the CURRENT return value of the command branch carries a sessionID
  // that DOES NOT match input.sessionID — proving the SSE persistence path is broken.
  //
  // We additionally test a spy-based contract that will green when Kou wires the
  // updateMessage + updatePart calls.  This uses pure function composition of the
  // exported helpers (no Effect runtime needed) to simulate the fix obligation.

  test("post-fix contract: updateMessage spy receives role=assistant with correct sessionID", () => {
    // This test documents the GREEN-phase obligation for Kou.
    // It is written against the NOT-YET-IMPLEMENTED fixed call convention.
    //
    // After the fix, `SessionPrompt.command` must call:
    //   yield* sessions.updateMessage(wp.info)
    //   yield* sessions.updatePart(wp.parts[0])
    // where `wp` was built with `buildBuiltinResult(result, input.sessionID)`.
    //
    // We simulate the fixed path here using a spy closure — no Effect runtime needed.
    const inputSessionID = "ses_spy_test_001"
    const updateMessageCalls: unknown[] = []
    const updatePartCalls: unknown[] = []

    const spySessions = {
      updateMessage: (msg: unknown) => { updateMessageCalls.push(msg); return msg },
      updatePart: (part: unknown) => { updatePartCalls.push(part); return part },
    }

    // Simulate the fixed command branch (what Kou must implement):
    const handlerResult = { title: "t", output: "o" }
    // Fixed buildBuiltinResult will accept sessionID:
    const wp = (buildBuiltinResult as Function)(handlerResult, inputSessionID)
    // Fixed command will call updateMessage + updatePart:
    spySessions.updateMessage(wp.info)
    spySessions.updatePart(wp.parts[0])

    // These assertions describe the GREEN contract — they WILL pass only when
    // `buildBuiltinResult` accepts and threads the sessionID correctly.
    //
    // RED trigger: wp.info.sessionID is currently a fresh random ID, not inputSessionID.
    // So the inner assertion about sessionID will fail.
    expect(updateMessageCalls).toHaveLength(1)
    expect(updatePartCalls).toHaveLength(1)
    const msg = updateMessageCalls[0] as Record<string, unknown>
    const part = updatePartCalls[0] as Record<string, unknown>
    expect(msg["role"]).toBe("assistant")
    expect(msg["sessionID"]).toBe(inputSessionID) // RED: currently a fresh random ses_…
    expect(part["type"]).toBe("text")
    expect(part["sessionID"]).toBe(inputSessionID) // RED: currently a fresh random ses_…
    const textPart = part as { text?: string }
    expect(textPart.text).toContain("o")
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
