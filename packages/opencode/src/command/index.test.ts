/**
 * @spec-handoff
 * @interface ConfigCommandV1.Info (Schema.Struct in core/src/v1/config/command.ts)
 * @interface Command.Service.list(): Effect.Effect<Info[]>
 * @interface Command.Service.get(name: string): Effect.Effect<Info | undefined>
 * @behavior
 *   - ACE security invariant (RFC 001 §A / Ei F1): a `handler` field injected into a
 *     user-config object is stripped at schema decode time — `ConfigCommandV1.Info` has
 *     no `handler` field, so `Schema.decodeUnknown` strips it silently.
 *   - `list()` and `get()` NEVER surface a `handler` field on any returned object,
 *     regardless of what data was fed into the registry. This is the structural control
 *     that prevents an arbitrary-code-execution path from config/markdown/MCP.
 *   - A `BuiltinCommand` registered in the internal registry IS castable to `Info` and
 *     therefore does NOT expose `handler` through the public `list()`/`get()` API
 *     surface (which is typed to return `Info`, not `BuiltinCommand`).
 * @edge-cases
 *   - Input object with `handler: () => {}` → decoded `ConfigCommandV1.Info` has no
 *     `handler` key (`"handler" in decoded === false`).
 *   - Input object with `handler: "string"` → same: stripped.
 *   - `list()` enumerates every built-in and user command; none may carry `handler`.
 *   - `get("reload")` for the built-in reload command: no `handler` on the result.
 * @see ./index.ts (Command.Info schema, BuiltinCommand internal type)
 * @see ../../../core/src/v1/config/command.ts (ConfigCommandV1.Info schema)
 */

import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigCommandV1 } from "@opencode-ai/core/v1/config/command"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const decodeCommandInfo = (input: unknown) =>
  Schema.decodeUnknownPromise(ConfigCommandV1.Info)(input)

// ---------------------------------------------------------------------------
// §A ACE regression: ConfigCommandV1.Info never carries a handler after decode
// ---------------------------------------------------------------------------

describe("ACE invariant — ConfigCommandV1.Info decodeUnknown strips handler (RFC 001 §A)", () => {
  test("handler field is absent from decoded result when input carries a function handler", async () => {
    const injected = {
      template: "Run reload_skills.",
      description: "injected with function handler",
      handler: () => ({ title: "pwned", output: "evil" }),
    }

    const decoded = await decodeCommandInfo(injected)

    // The decoded value MUST NOT carry handler — structural ACE control.
    expect("handler" in decoded).toBe(false)
  })

  test("handler field is absent from decoded result when input carries a string handler", async () => {
    const injected = {
      template: "some template",
      description: "injected with string handler",
      handler: "alert('xss')",
    }

    const decoded = await decodeCommandInfo(injected)

    expect("handler" in decoded).toBe(false)
  })

  test("handler field is absent from decoded result when input carries an object handler", async () => {
    const injected = {
      template: "some template",
      handler: { type: "builtin", name: "reload" },
    }

    const decoded = await decodeCommandInfo(injected)

    expect("handler" in decoded).toBe(false)
  })

  test("valid ConfigCommandV1.Info fields are preserved after decode", async () => {
    const input = {
      template: "do something with $ARGUMENTS",
      description: "a user command",
      agent: "coding",
      model: "claude-opus",
      subtask: true,
      handler: () => {},
    }

    const decoded = await decodeCommandInfo(input)

    expect(decoded.template).toBe("do something with $ARGUMENTS")
    expect(decoded.description).toBe("a user command")
    expect(decoded.agent).toBe("coding")
    expect(decoded.model).toBe("claude-opus")
    expect(decoded.subtask).toBe(true)
    // handler is stripped
    expect("handler" in decoded).toBe(false)
  })

  test("decode fails for input missing the required template field — schema enforces contract", async () => {
    const input = {
      description: "missing template",
      handler: () => {},
    }

    await expect(decodeCommandInfo(input)).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// §A ACE regression: Command.Info (public schema) also has no handler field
//
// This test exercises the public Command.Info schema exported from command/index.ts
// directly — the schema that get()/list() encode results against at the type level.
// ---------------------------------------------------------------------------

describe("ACE invariant — Command.Info public schema has no handler field (RFC 001 §A)", () => {
  test("Command.Info decodeUnknown strips a function handler", async () => {
    // Import the public schema — this is what get()/list() return values conform to.
    const { Info } = await import("./index")

    const input = {
      name: "reload",
      description: "reload skills",
      source: "command" as const,
      template: "Run reload_skills.",
      hints: [],
      handler: () => ({ title: "pwned", output: "evil" }),
    }

    const decoded = await Schema.decodeUnknownPromise(Info)(input)

    expect("handler" in decoded).toBe(false)
  })

  test("Command.Info decodeUnknown strips an object handler", async () => {
    const { Info } = await import("./index")

    const input = {
      name: "init",
      template: "some template",
      hints: [],
      handler: { type: "builtin", fn: "reloadSkills" },
    }

    const decoded = await Schema.decodeUnknownPromise(Info)(input)

    expect("handler" in decoded).toBe(false)
  })
})
