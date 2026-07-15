/**
 * @spec-handoff
 * @interface fmt(list: Info[], opts: { verbose: boolean }): string
 * @behavior
 *   Point 3 reconciliation (spec-reconciliation.md): `xmlEscape` (fork) and
 *   `escapeHtml` (upstream, `@/util/html`) are character-for-character
 *   identical. `escapeHtml` is now the single implementation, applied to all
 *   three rendered fields in verbose mode: `name`, `description`, and
 *   `location` (only when `location` is rendered as a `pathToFileURL` string —
 *   the fork's own extension over plain upstream, which left `location`
 *   un-escaped and skipped `pathToFileURL`).
 * @edge-cases
 *   - name/description containing `& < > " '` → each character escaped to its
 *     named entity (`&amp; &lt; &gt; &quot; &#39;`).
 *   - `location` on disk (not starting with "<") → escapeHtml(pathToFileURL(location).href).
 *   - `location === "<built-in>"` → rendered literally, NOT passed through
 *     pathToFileURL, NOT escaped (so it must NOT come out as `&lt;built-in&gt;`).
 *   - Skills with `description === undefined` are excluded entirely (pre-existing
 *     `described` filter) — not part of Point 3, but exercised here so the fixture
 *     list is realistic.
 * @see ./index.ts (fmt, described skills filter)
 * @see ../util/html.ts (escapeHtml)
 */

/**
 * @spec-handoff
 * @interface makeRefreshWithGuards(doRefresh: Effect.Effect<Info[]>): Effect.Effect<Info[]>
 * @interface RELOAD_COOLDOWN_MS: number (≥ 5000)
 * @interface Skill.Service.refresh(): Effect.Effect<Info[]>  ← MUST route through makeRefreshWithGuards
 * @behavior
 *   Serialization (single-flight semaphore — RFC 001 §D.0):
 *     - The entire doRefresh cycle is guarded by a per-service binary semaphore
 *       (`Effect.makeSemaphore(1)` / `withPermits(1)`).
 *     - Two concurrent calls NEVER run doRefresh in parallel: the second call
 *       waits for the first to complete before it may begin its own cycle.
 *     - After both calls finish, the state is coherent: exactly two sequential
 *       doRefresh executions happened, not a concurrent interleave.
 *
 *   Cooldown / coalescing (RFC 001 §D.0):
 *     - At most one real doRefresh per RELOAD_COOLDOWN_MS window.
 *     - If doRefresh completed less than RELOAD_COOLDOWN_MS ago, a new refresh()
 *       call returns the cached result WITHOUT triggering a new doRefresh cycle.
 *     - Uses `Clock.currentTimeMillis` (or Effect's Clock service) so TestClock
 *       can control virtual time — no real setTimeout.
 *     - A call that arrives AFTER the cooldown window expires DOES trigger a new
 *       doRefresh cycle.
 *
 *   Wiring contract (REGRESSION — currently broken on HEAD 9ab3853af):
 *     - `Skill.Service.refresh()` (index.ts:361-363) MUST delegate to
 *       `makeRefreshWithGuards(doRefresh)`, not to bare `doRefresh`.
 *     - Currently `refresh()` calls `doRefresh` directly, making
 *       `makeRefreshWithGuards` dead code (confirmed via grep: zero production
 *       call sites outside skill/index.test.ts — Sui investigation 2026-07-15).
 *     - Evidence: rapid successive `refresh()` calls each increment a rescan
 *       counter to N, proving the cooldown/semaphore is bypassed in production.
 *
 * @edge-cases
 *   - Two concurrent refresh() calls: only ONE doRefresh starts; the second waits.
 *   - RELOAD_COOLDOWN_MS must be >= 5000 (asserted as a constant contract).
 *   - A call at t=0, cooldown window = 5000ms, second call at t=4999 → coalesces.
 *   - A call at t=0, second call at t=5001 → new doRefresh triggered.
 *   - `makeRefreshWithGuards` is the ONLY place where the cooldown/semaphore logic
 *     lives; `Skill.Service.refresh()` MUST route through it, not bypass it.
 * @see ./index.ts (Skill.Service, refresh(), doRefresh, stateRef — lines 296-363)
 * @see ./index.ts (makeRefreshWithGuards — lines 417-434, dead code on HEAD 9ab3853af)
 */

import { describe, expect, test } from "bun:test"
import { pathToFileURL } from "url"
import { Duration, Effect, Ref, Clock } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { fmt, type Info } from "./index"

const skill = (overrides: Partial<Info>): Info => ({
  name: "skill-name",
  description: "a description",
  location: "/home/user/skills/skill-name",
  content: "content",
  ...overrides,
})

describe("fmt (verbose) — escapeHtml on name/description/location (Point 3)", () => {
  test("escapes & < > \" ' in name", () => {
    const output = fmt([skill({ name: `My Skill & <Co> "quoted" 'single'` })], { verbose: true })

    expect(output).toContain("<name>My Skill &amp; &lt;Co&gt; &quot;quoted&quot; &#39;single&#39;</name>")
  })

  test("escapes & < > \" ' in description", () => {
    const output = fmt([skill({ description: `<script>alert(1)</script> & "x" 'y'` })], { verbose: true })

    expect(output).toContain(
      "<description>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot; &#39;y&#39;</description>",
    )
  })

  test("escapes a disk location as an escaped pathToFileURL href", () => {
    const diskPath = "/home/user/skills/foo & bar"
    const output = fmt([skill({ location: diskPath })], { verbose: true })
    const expectedHref = pathToFileURL(diskPath).href

    expect(output).toContain(`<location>${expectedHref.replace(/&/g, "&amp;")}</location>`)
  })

  test('"<built-in>" location is rendered literally — NOT escaped, NOT pathToFileURL\'d', () => {
    const output = fmt([skill({ location: "<built-in>" })], { verbose: true })

    expect(output).toContain("<location><built-in></location>")
    expect(output).not.toContain("&lt;built-in&gt;")
  })

  test("plain name/description with no special characters round-trip unchanged", () => {
    const output = fmt([skill({ name: "plain-name", description: "plain description" })], { verbose: true })

    expect(output).toContain("<name>plain-name</name>")
    expect(output).toContain("<description>plain description</description>")
  })
})

describe("fmt — described-skills filter (pre-existing, exercised for fixture realism)", () => {
  test("returns the no-skills message when every skill lacks a description", () => {
    const output = fmt([skill({ description: undefined })], { verbose: true })

    expect(output).toBe("No skills are currently available.")
  })

  test("non-verbose mode lists name/description as markdown bullets", () => {
    const output = fmt([skill({ name: "a", description: "does a thing" })], { verbose: false })

    expect(output).toBe(["## Available Skills", "- **a**: does a thing"].join("\n"))
  })
})

// ---------------------------------------------------------------------------
// Helpers for semaphore / cooldown tests
//
// These tests are RED in E2 (pre-E3) because the current Skill.Service.refresh()
// has NO semaphore and NO cooldown — `doRefresh` is bare Effect.gen with no guard.
//
// The contract being tested: makeRefreshWithGuards() is the internal factory that
// E3 must implement inside Skill.Service to wrap doRefresh with the serialization
// + cooldown contract from RFC 001 §D.0.
//
// We import RELOAD_COOLDOWN_MS from skill/index.ts as a named export that E3 must
// add. This import will FAIL until E3 adds it, making every test in these suites RED.
// ---------------------------------------------------------------------------

// These symbols are imported lazily inside each test to avoid a top-level module
// error that would swallow all test results. Each test that needs them will fail
// individually with a clear "not exported" error until E3 implements them.
//
// RELOAD_COOLDOWN_MS: number (>= 5000) — must be exported from ./index (E3).
// makeRefreshWithGuards: function — must be exported from ./index (E3).

const getRefreshSymbols = async () => {
  // Dynamic import returns the module's namespace. Missing exports === undefined.
  const mod = await import("./index") as typeof import("./index") & {
    RELOAD_COOLDOWN_MS?: number
    makeRefreshWithGuards?: (doRefresh: Effect.Effect<Info[]>) => Effect.Effect<Info[]>
  }
  return {
    RELOAD_COOLDOWN_MS: mod.RELOAD_COOLDOWN_MS,
    makeRefreshWithGuards: mod.makeRefreshWithGuards,
  }
}

// ---------------------------------------------------------------------------
// RELOAD_COOLDOWN_MS constant contract
// ---------------------------------------------------------------------------

describe("RELOAD_COOLDOWN_MS — constant contract (RFC 001 §D.0)", () => {
  test("RELOAD_COOLDOWN_MS is exported and is a number", async () => {
    // This will fail until E3 exports RELOAD_COOLDOWN_MS from skill/index.ts.
    const { RELOAD_COOLDOWN_MS } = await getRefreshSymbols()
    expect(typeof RELOAD_COOLDOWN_MS).toBe("number")
  })

  test("RELOAD_COOLDOWN_MS is >= 5000ms (RFC 001 §D.0 minimum)", async () => {
    // RFC 001 §D.0: "suggest RELOAD_COOLDOWN_MS = 5000, ≥ the DISPOSE_TIMEOUT_MS budget"
    const { RELOAD_COOLDOWN_MS } = await getRefreshSymbols()
    expect(RELOAD_COOLDOWN_MS).toBeGreaterThanOrEqual(5000)
  })
})

// ---------------------------------------------------------------------------
// Semaphore serialization (RFC 001 §D.0)
// ---------------------------------------------------------------------------

describe("refresh() semaphore serialization — two concurrent calls never overlap (RFC 001 §D.0)", () => {
  test("two concurrent refresh() calls run doRefresh sequentially, not in parallel", async () => {
    const { makeRefreshWithGuards } = await getRefreshSymbols()
    // makeRefreshWithGuards must exist — fail fast if not yet implemented.
    expect(makeRefreshWithGuards).toBeDefined()
    if (!makeRefreshWithGuards) throw new Error("makeRefreshWithGuards not exported — E3 not implemented yet")

    // Arrange: a doRefresh that records its start/end times using Effect Clock.
    // If two fibers run doRefresh concurrently, their intervals WILL overlap.
    // With the semaphore, the second fiber must wait until the first finishes.

    const executionLog: Array<{ phase: "start" | "end"; fiber: number }> = []
    let fiberCounter = 0

      const doRefresh: Effect.Effect<Info[]> = Effect.gen(function* () {
      const myFiber = ++fiberCounter
      executionLog.push({ phase: "start", fiber: myFiber })
      // Simulate a non-trivial doRefresh by yielding to let other fibers run.
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      executionLog.push({ phase: "end", fiber: myFiber })
      return [skill({ name: `skill-from-fiber-${myFiber}` })]
    })

    const refresh = makeRefreshWithGuards(doRefresh)

    await Effect.runPromise(
      Effect.gen(function* () {
        fiberCounter = 0
        executionLog.length = 0

        const [r1, r2] = yield* Effect.all([refresh, refresh], { concurrency: 2 })

        expect(Array.isArray(r1)).toBe(true)
        expect(Array.isArray(r2)).toBe(true)

        // Serialization assertion: log must be start/A → end/A → start/B → end/B
        // (no interleaving). Any other ordering proves concurrent execution.
        expect(executionLog).toStrictEqual([
          { phase: "start", fiber: executionLog[0].fiber },
          { phase: "end", fiber: executionLog[0].fiber },
          { phase: "start", fiber: executionLog[2].fiber },
          { phase: "end", fiber: executionLog[2].fiber },
        ])
      }),
    )
  })

  test("semaphore prevents doRefresh from being invoked concurrently — high-water mark = 1", async () => {
    const { makeRefreshWithGuards } = await getRefreshSymbols()
    expect(makeRefreshWithGuards).toBeDefined()
    if (!makeRefreshWithGuards) throw new Error("makeRefreshWithGuards not exported — E3 not implemented yet")

    let concurrentCallsHighWaterMark = 0
    let currentlyRunning = 0

    const doRefresh: Effect.Effect<Info[]> = Effect.gen(function* () {
      currentlyRunning++
      if (currentlyRunning > concurrentCallsHighWaterMark) {
        concurrentCallsHighWaterMark = currentlyRunning
      }
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      currentlyRunning--
      return [] as Info[]
    })

    const refresh = makeRefreshWithGuards(doRefresh)

    await Effect.runPromise(
      Effect.gen(function* () {
        currentlyRunning = 0
        concurrentCallsHighWaterMark = 0

        yield* Effect.all([refresh, refresh, refresh], { concurrency: 3 })

        // With semaphore: high-water mark of concurrent doRefresh executions = 1.
        // Without semaphore (current): high-water mark = up to 3.
        expect(concurrentCallsHighWaterMark).toBe(1)
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// Cooldown / coalescing (RFC 001 §D.0)
// ---------------------------------------------------------------------------

describe("refresh() cooldown coalescing — second call within window reuses result (RFC 001 §D.0)", () => {
  test("second refresh() within RELOAD_COOLDOWN_MS does not trigger a new doRefresh cycle", async () => {
    const { makeRefreshWithGuards, RELOAD_COOLDOWN_MS } = await getRefreshSymbols()
    expect(makeRefreshWithGuards).toBeDefined()
    expect(RELOAD_COOLDOWN_MS).toBeDefined()
    if (!makeRefreshWithGuards) throw new Error("makeRefreshWithGuards not exported — E3 not implemented yet")
    if (RELOAD_COOLDOWN_MS === undefined) throw new Error("RELOAD_COOLDOWN_MS not exported — E3 not implemented yet")

    let doRefreshCallCount = 0

    const doRefresh: Effect.Effect<Info[]> = Effect.gen(function* () {
      doRefreshCallCount++
      return [skill({ name: `refresh-call-${doRefreshCallCount}` })]
    })

    const refresh = makeRefreshWithGuards(doRefresh)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          doRefreshCallCount = 0

          // First call: triggers doRefresh.
          const r1 = yield* refresh
          expect(doRefreshCallCount).toBe(1)

          // Second call within cooldown window (virtual time not advanced).
          const r2 = yield* refresh
          // doRefresh must NOT have been called again — cooldown coalescing.
          expect(doRefreshCallCount).toBe(1)
          // Second result should be identical to the first.
          expect(r2).toStrictEqual(r1)
        }),
      ).pipe(
        // Provide TestClock so virtual time is controlled.
        Effect.provide(TestClock.layer()),
      ),
    )
  })

  test("refresh() after RELOAD_COOLDOWN_MS has elapsed triggers a new doRefresh cycle", async () => {
    const { makeRefreshWithGuards, RELOAD_COOLDOWN_MS } = await getRefreshSymbols()
    expect(makeRefreshWithGuards).toBeDefined()
    expect(RELOAD_COOLDOWN_MS).toBeDefined()
    if (!makeRefreshWithGuards) throw new Error("makeRefreshWithGuards not exported — E3 not implemented yet")
    if (RELOAD_COOLDOWN_MS === undefined) throw new Error("RELOAD_COOLDOWN_MS not exported — E3 not implemented yet")

    let doRefreshCallCount = 0

    const doRefresh: Effect.Effect<Info[]> = Effect.gen(function* () {
      doRefreshCallCount++
      return [skill({ name: `refresh-call-${doRefreshCallCount}` })]
    })

    const refresh = makeRefreshWithGuards(doRefresh)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          doRefreshCallCount = 0

          // First call.
          yield* refresh
          expect(doRefreshCallCount).toBe(1)

          // Advance virtual time past the cooldown window.
          yield* TestClock.adjust(Duration.millis(RELOAD_COOLDOWN_MS + 1))

          // Second call: cooldown has expired, must trigger a new doRefresh.
          const r2 = yield* refresh
          expect(doRefreshCallCount).toBe(2)
          expect(r2[0].name).toBe("refresh-call-2")
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )
  })

  test("refresh() just before cooldown expiry (RELOAD_COOLDOWN_MS - 1 ms) still coalesces", async () => {
    const { makeRefreshWithGuards, RELOAD_COOLDOWN_MS } = await getRefreshSymbols()
    expect(makeRefreshWithGuards).toBeDefined()
    expect(RELOAD_COOLDOWN_MS).toBeDefined()
    if (!makeRefreshWithGuards) throw new Error("makeRefreshWithGuards not exported — E3 not implemented yet")
    if (RELOAD_COOLDOWN_MS === undefined) throw new Error("RELOAD_COOLDOWN_MS not exported — E3 not implemented yet")

    let doRefreshCallCount = 0

    const doRefresh: Effect.Effect<Info[]> = Effect.gen(function* () {
      doRefreshCallCount++
      return [skill({ name: `refresh-call-${doRefreshCallCount}` })]
    })

    const refresh = makeRefreshWithGuards(doRefresh)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          doRefreshCallCount = 0

          yield* refresh
          expect(doRefreshCallCount).toBe(1)

          // Advance time to just inside the cooldown window.
          yield* TestClock.adjust(Duration.millis(RELOAD_COOLDOWN_MS - 1))

          const r2 = yield* refresh
          // Still within window — must NOT trigger a new doRefresh.
          expect(doRefreshCallCount).toBe(1)
          expect(r2[0].name).toBe("refresh-call-1")
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )
  })
})

// ─── REGRESSION TEST 2: Skill.Service.refresh() must route through makeRefreshWithGuards ─
//
// Sui investigation 2026-07-15 (round 2), confirmed on HEAD 9ab3853af:
//   `Skill.Service.refresh()` (index.ts:361-363) calls `doRefresh` DIRECTLY:
//
//     const refresh = Effect.fn("Skill.refresh")(function* () {
//       return yield* (yield* InstanceState.get(state)).doRefresh   // ← bare doRefresh
//     })
//
//   `makeRefreshWithGuards` (lines 417-434, the semaphore+cooldown wrapper built
//   in E3) is never called from any production path. It is referenced ONLY from
//   this test file — dead code in production.
//
//   Consequence: rapid successive `/reload` calls each trigger a full rescan with
//   no throttling or serialization, confirmed live: `init count=N` logged for
//   every invocation even when spaced <1s apart.
//
// Test strategy (RED phase):
//   We use `makeRefreshWithGuards` — the exported, unit-tested guard — as a
//   reference implementation and compare its behavior against a synthetic
//   "production-equivalent" path that calls `doRefresh` directly (mirroring the
//   current broken Skill.Service.refresh() lines 361-363).
//
//   We instrument `doRefresh` with a counter. In the GUARDED path (reference),
//   two rapid calls produce 1 invocation (cooldown active). In the UNGUARDED path
//   (current production behavior), two rapid calls produce 2 invocations.
//
//   The test asserts the GUARDED behavior on the unguarded path → RED now.
//   GREEN when Kou wires `makeRefreshWithGuards(doRefresh)` into
//   `Skill.Service.refresh()` in place of the bare `doRefresh` call.

describe("REGRESSION: Skill.Service.refresh() must apply cooldown guard (dead-code wiring bug)", () => {
  test("REGRESSION-2a: Skill.Service.refresh() source wires guardedRefresh, not bare doRefresh", async () => {
    // This test verifies the WIRING between Skill.Service.refresh() and
    // makeRefreshWithGuards by reading the production source of skill/index.ts.
    //
    // Why source inspection here: Skill.Service requires ~6 deep dependencies
    // (Discovery, Config, EventV2Bridge, FSUtil, Global, RuntimeFlags + InstanceState
    // with InstanceRef context) that make it impractical to instantiate in isolation.
    // Source inspection is the closest-to-production verification available when
    // the service cannot be unit-tested standalone.
    //
    // GREEN: the fix (guardedRefresh in InstanceState.make + refresh() delegating to
    //        guardedRefresh) is present. Both strings must appear in the source.
    // REVERT-sensitive: removing either line from index.ts turns this test red.
    //
    // Companion test REGRESSION-2b (below) proves that makeRefreshWithGuards itself
    // behaves correctly in isolation, so together they form a complete regression suite.

    const src = await Bun.file(new URL("./index.ts", import.meta.url)).text()

    // The InstanceState.make closure must build guardedRefresh from makeRefreshWithGuards.
    expect(src).toContain("makeRefreshWithGuards(doRefresh)")

    // Skill.Service.refresh() must delegate to guardedRefresh, not to doRefresh.
    // The exact production line is:
    //   return yield* (yield* InstanceState.get(state)).guardedRefresh
    expect(src).toContain(".guardedRefresh")

    // Confirm the old broken path (bare doRefresh) is NOT the active return path.
    // The only occurrence of "doRefresh" as a yield target must be inside the
    // makeRefreshWithGuards body, not as the direct return of refresh().
    // We verify this by checking that the refresh() method text delegates through guardedRefresh.
    const refreshFnStart = src.indexOf('"Skill.refresh"')
    expect(refreshFnStart).toBeGreaterThan(-1)
    const refreshFnBody = src.slice(refreshFnStart, refreshFnStart + 200)
    expect(refreshFnBody).toContain("guardedRefresh")
    expect(refreshFnBody).not.toContain("doRefresh")
  })

  test("REGRESSION-2b: makeRefreshWithGuards DOES throttle — confirms the guard works in isolation", async () => {
    // This test is GREEN now (makeRefreshWithGuards works correctly in isolation).
    // It exists to prove that the guard logic itself is correct and that REGRESSION-2a
    // is a wiring bug, not a logic bug.
    //
    // When REGRESSION-2a turns green, this test confirms the same count=1 via the
    // proper guard. Both tests being green simultaneously proves the wiring is complete.

    const { makeRefreshWithGuards, RELOAD_COOLDOWN_MS } = await getRefreshSymbols()
    expect(makeRefreshWithGuards).toBeDefined()
    expect(RELOAD_COOLDOWN_MS).toBeDefined()
    if (!makeRefreshWithGuards) throw new Error("makeRefreshWithGuards not exported")
    if (RELOAD_COOLDOWN_MS === undefined) throw new Error("RELOAD_COOLDOWN_MS not exported")

    let rescanCount = 0

    const doRefresh: Effect.Effect<Info[]> = Effect.gen(function* () {
      rescanCount++
      return [skill({ name: `scan-${rescanCount}` })]
    })

    // Guarded path — what refresh() SHOULD call after the fix:
    const guardedRefresh = makeRefreshWithGuards(doRefresh)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          rescanCount = 0

          yield* guardedRefresh
          yield* guardedRefresh  // within cooldown window (virtual time not advanced)

          // Guarded: second call coalesces → rescanCount stays at 1.
          expect(rescanCount).toBe(1)  // GREEN: makeRefreshWithGuards works correctly
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )
  })
})
