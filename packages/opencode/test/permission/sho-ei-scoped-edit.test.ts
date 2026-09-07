/**
 * @spec-handoff
 * @interface Permission.fromConfig(permission: ConfigPermissionV1.Info): PermissionV1.Rule[]
 * @interface Permission.merge(...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule[]
 * @interface Permission.evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule
 * @behavior
 *   - Sho/Ei's `permission.edit` config value (yui-soul workspace RFC 046 D-L1-6) is a path-scoped
 *     object, NOT a flat string: a deny-all "*" pattern FIRST, then a "reviews" wildcard pattern
 *     (star, slash, .yui-soul, slash, reviews, slash, star) and an "rfcs review filename" pattern
 *     (see SHO_SCOPED_EDIT/EI_SCOPED_EDIT below for the exact literal - not reproduced here to
 *     avoid a stray comment-closing token inside this block comment).
 *   - Through the REAL `fromConfig`/`merge`/`evaluate` pipeline (no reimplementation), a path
 *     matching a scoped-allow pattern evaluates to "allow"; a path matching neither scoped pattern
 *     evaluates to "deny" (via the deny-all "*" entry), never falls through to the agent-level
 *     `"*": "allow"` default.
 *   - `evaluate()`'s `.findLast()` semantics make key ORDER inside the `edit` object
 *     correctness-critical: with the deny-all listed first (correct), a match against a scoped
 *     pattern picks up the LATER (more specific) rule and wins over the earlier deny-all. Reversing
 *     the order breaks the POSITIVE case (own review path becomes denied). Omitting the deny-all
 *     entirely lets an unrelated path fall through to the agent-level `"*": "allow"` default and
 *     resolve to "allow" — a silent fail-open, not a hypothetical.
 * @edge-cases
 *   - Own reviews-directory and own rfcs-review-filename paths (see the constants below) -> allow.
 *   - `.yui-soul/knowledge/gotchas` and application source paths -> deny.
 *   - A lookalike substring match (`.yui-soul/reviews/` present but not root-anchored) is NOT this
 *     suite's concern — that adversarial class is closed at the `soul-tools` plugin hook level
 *     (D-L1-9), not the permission-pattern DSL, and is covered in `opencode-plan-query`'s own test
 *     suite (`plugin.e3-canonical-root-containment.test.ts`).
 *   - Round-1 audit remediation (Ei r1-ei-permissions-signing.md Finding 1, plan 262): the
 *     star-slash-prefixed patterns alone never match a resource path with ZERO segments before
 *     `.yui-soul` — the canonical single-repo scaffold topology (`.yui-soul/` directly at
 *     `location.directory`'s root), NOT merely a corner case. The zero-prefix companion patterns
 *     (`SHO_SCOPED_EDIT`/`EI_SCOPED_EDIT` below now carry both) close this without reopening the
 *     lookalike bypass above: the zero-prefix reviews pattern is anchored at position 0, so it
 *     does not match `src/x.yui-soul/reviews/y.md`.
 * @see ../../src/permission/index.ts (fromConfig/merge/evaluate, disabled)
 * @see ../../src/agent/agent.ts:119-136 (the real agent-level `"*": "allow"` default this suite's
 *   fail-open demonstration reproduces the masking effect of)
 * @see ../../../../.yui-soul/rfcs/approved/046-yui-soul-write-safety-and-commit-governance/README.md
 *   §4.1.1 D-L1-6, residual risk #7 ("Permission-pattern ordering is a new, silent
 *   misconfiguration risk")
 * @see ../../../../yui-soul/bin/lib/defaults.js — DEFAULTS.crew sho/ei entries (this literal MUST
 *   stay in lockstep with that file's `permission.edit` value; see that repo's own
 *   `test/defaults.test.js` for the generator-side assertion of the identical shape/order)
 * @see ../../../../.yui-soul/reviews/262-yui-soul-write-safety-commit-governance/r1-ei-permissions-signing.md
 *   Finding 1 (zero-prefix pattern-anchoring gap, round-1 audit remediation)
 */
import { test, expect } from "bun:test"
import { Permission } from "../../src/permission"

// Mirrors `agent.ts`'s own literal `"*": "allow"` prepend (src/agent/agent.ts:119-120,
// `Permission.fromConfig({ "*": "allow", ... })`) — the SAME real top-level fallback whose masking
// effect this suite's fail-open demonstration exercises. Only the slice relevant to an `edit`
// lookup is reproduced: `Wildcard.match("edit", rule.permission)` only ever matches a rule.permission
// of "*" or "edit" itself, so the other default keys (doom_loop, external_directory, question,
// plan_enter/exit, read) can never influence an "edit" evaluation and are omitted here.
const AGENT_LEVEL_DEFAULTS = Permission.fromConfig({ "*": "allow" })

// The EXACT `permission.edit` value RFC 046 D-L1-6 specifies for `sho` (anchored patterns,
// deny-all FIRST — see this file's own @spec-handoff and the RFC's residual risk #7). Round-1
// audit remediation (Ei r1-ei-permissions-signing.md Finding 1, plan 262) added the zero-prefix
// companion patterns (`.yui-soul/reviews/*`, `.yui-soul/rfcs/*/*/review-<name>.md`).
const SHO_SCOPED_EDIT = {
  "*": "deny",
  ".yui-soul/reviews/*": "allow",
  "*/.yui-soul/reviews/*": "allow",
  ".yui-soul/rfcs/*/*/review-sho.md": "allow",
  "*/.yui-soul/rfcs/*/*/review-sho.md": "allow",
} as const

const EI_SCOPED_EDIT = {
  "*": "deny",
  ".yui-soul/reviews/*": "allow",
  "*/.yui-soul/reviews/*": "allow",
  ".yui-soul/rfcs/*/*/review-ei.md": "allow",
  "*/.yui-soul/rfcs/*/*/review-ei.md": "allow",
} as const

// Realistic resolved-relative-path shapes for this workspace: `instance.worktree` resolves to
// `"/"` for this non-git workspace root (RFC 046 §4.1.1), so every real target has a genuine path
// segment, and therefore a real `/`, before `.yui-soul` — bare `.yui-soul/...` (no leading
// segment) is deliberately NOT used here since the leading `*` in the pattern DSL requires a `/`
// immediately before `.yui-soul` to match at all (packages/core/src/util/wildcard.ts:8, `*` -> `.*`).
const OWN_REVIEWS_PATH = "code-projects/personal/.yui-soul/reviews/046-x/review-sho.md"
const OWN_RFC_REVIEW_PATH = "code-projects/personal/.yui-soul/rfcs/046-x/round1/review-sho.md"
const OWN_RFC_REVIEW_PATH_EI = "code-projects/personal/.yui-soul/rfcs/046-x/round1/review-ei.md"
const OTHER_KNOWLEDGE_PATH = "code-projects/personal/.yui-soul/knowledge/gotchas/foo.md"
const APP_SOURCE_PATH = "code-projects/personal/opencode-plan-query/src/plugin.ts"

// Round-1 audit remediation (Ei r1-ei-permissions-signing.md Finding 1, plan 262): the canonical
// single-repo scaffold topology — `.yui-soul/` sits directly at `location.directory`'s own root,
// so the resolved-relative resource path has ZERO segments before `.yui-soul` (no leading `/`, no
// leading `code-projects/personal/`-style prefix). A resource literal of EXACTLY this shape, per
// Ei's own finding text.
const OWN_REVIEWS_PATH_ZERO_PREFIX = ".yui-soul/reviews/x.md"
const OWN_RFC_REVIEW_PATH_ZERO_PREFIX = ".yui-soul/rfcs/046-x/round1/review-sho.md"
const OWN_RFC_REVIEW_PATH_EI_ZERO_PREFIX = ".yui-soul/rfcs/046-x/round1/review-ei.md"

// D-L1-6 sub-case (a): positive — Sho/Ei can Edit/Write their own known review-artifact paths
// directly, through the REAL evaluate() pipeline (defaults merged with the scoped config), not a
// hand-simulated equivalent.

test("D-L1-6 sub-case (a): sho's scoped edit:allow permits its own .yui-soul/reviews/ artifact", () => {
  const merged = Permission.merge(AGENT_LEVEL_DEFAULTS, Permission.fromConfig({ edit: SHO_SCOPED_EDIT }))
  expect(Permission.evaluate("edit", OWN_REVIEWS_PATH, merged).action).toBe("allow")
})

test("D-L1-6 sub-case (a): sho's scoped edit:allow permits its own review-sho.md under .yui-soul/rfcs/*/*/", () => {
  const merged = Permission.merge(AGENT_LEVEL_DEFAULTS, Permission.fromConfig({ edit: SHO_SCOPED_EDIT }))
  expect(Permission.evaluate("edit", OWN_RFC_REVIEW_PATH, merged).action).toBe("allow")
})

test("D-L1-6 sub-case (a): ei's scoped edit:allow permits its own review-ei.md under .yui-soul/rfcs/*/*/", () => {
  const merged = Permission.merge(AGENT_LEVEL_DEFAULTS, Permission.fromConfig({ edit: EI_SCOPED_EDIT }))
  expect(Permission.evaluate("edit", OWN_RFC_REVIEW_PATH_EI, merged).action).toBe("allow")
})

// D-L1-6 sub-case (b): negative — an Edit/Write attempt outside those scoped patterns is still
// denied, through the same real pipeline.

test("D-L1-6 sub-case (b): sho's scoped edit permission denies an unrelated .yui-soul/knowledge/ path", () => {
  const merged = Permission.merge(AGENT_LEVEL_DEFAULTS, Permission.fromConfig({ edit: SHO_SCOPED_EDIT }))
  expect(Permission.evaluate("edit", OTHER_KNOWLEDGE_PATH, merged).action).toBe("deny")
})

test("D-L1-6 sub-case (b): sho's scoped edit permission denies application source code", () => {
  const merged = Permission.merge(AGENT_LEVEL_DEFAULTS, Permission.fromConfig({ edit: SHO_SCOPED_EDIT }))
  expect(Permission.evaluate("edit", APP_SOURCE_PATH, merged).action).toBe("deny")
})

test("D-L1-6 sub-case (b): ei's scoped edit permission denies an unrelated .yui-soul/knowledge/ path", () => {
  const merged = Permission.merge(AGENT_LEVEL_DEFAULTS, Permission.fromConfig({ edit: EI_SCOPED_EDIT }))
  expect(Permission.evaluate("edit", OTHER_KNOWLEDGE_PATH, merged).action).toBe("deny")
})

test("D-L1-6 sub-case (b): sho's own reviews/ grant does NOT leak into ei's rfcs review filename (each agent's scope is its own, not shared)", () => {
  const merged = Permission.merge(AGENT_LEVEL_DEFAULTS, Permission.fromConfig({ edit: SHO_SCOPED_EDIT }))
  // sho's config has no entry for review-ei.md's exact pattern; the reviews/* wildcard doesn't
  // cover the rfcs/ subtree at all, so this must fall through to the deny-all, never allow.
  expect(Permission.evaluate("edit", OWN_RFC_REVIEW_PATH_EI, merged).action).toBe("deny")
})

// Round-1 audit remediation (Ei r1-ei-permissions-signing.md Finding 1, plan 262): zero-prefix
// topology regression — a resource path with NO path segment before `.yui-soul` (the canonical
// single-repo scaffold, `.yui-soul/` directly at the workspace root) must ALSO be permitted, not
// just the `personal` container's own accidentally-prefixed shape covered above.

test("D-L1-6 sub-case (a), zero-prefix topology: sho's scoped edit:allow permits its own .yui-soul/reviews/ artifact even with NO leading path segment", () => {
  const merged = Permission.merge(AGENT_LEVEL_DEFAULTS, Permission.fromConfig({ edit: SHO_SCOPED_EDIT }))
  expect(Permission.evaluate("edit", OWN_REVIEWS_PATH_ZERO_PREFIX, merged).action).toBe("allow")
})

test("D-L1-6 sub-case (a), zero-prefix topology: sho's scoped edit:allow permits its own review-sho.md under .yui-soul/rfcs/*/*/ even with NO leading path segment", () => {
  const merged = Permission.merge(AGENT_LEVEL_DEFAULTS, Permission.fromConfig({ edit: SHO_SCOPED_EDIT }))
  expect(Permission.evaluate("edit", OWN_RFC_REVIEW_PATH_ZERO_PREFIX, merged).action).toBe("allow")
})

test("D-L1-6 sub-case (a), zero-prefix topology: ei's scoped edit:allow permits its own review-ei.md under .yui-soul/rfcs/*/*/ even with NO leading path segment", () => {
  const merged = Permission.merge(AGENT_LEVEL_DEFAULTS, Permission.fromConfig({ edit: EI_SCOPED_EDIT }))
  expect(Permission.evaluate("edit", OWN_RFC_REVIEW_PATH_EI_ZERO_PREFIX, merged).action).toBe("allow")
})

// Residual risk #7 (RFC 046 §8) — ordering/omission mutation demonstrations, against the REAL
// evaluate()/findLast() pipeline, not a reimplementation. These prove the deny-all "*" entry's
// POSITION and PRESENCE are load-bearing, not stylistic.

test("residual risk #7 (mutation): reversing the key order (scoped-allow FIRST, deny-all LAST) breaks the POSITIVE case — sho's own review path becomes denied", () => {
  const reversed = {
    "*/.yui-soul/reviews/*": "allow",
    "*/.yui-soul/rfcs/*/*/review-sho.md": "allow",
    "*": "deny",
  } as const
  const merged = Permission.merge(AGENT_LEVEL_DEFAULTS, Permission.fromConfig({ edit: reversed }))
  // Both the reviews/* rule and the deny-all rule match this path; .findLast() picks the LAST
  // matching entry, which is now the deny-all — the correctly-ordered config (this file's
  // SHO_SCOPED_EDIT, tested above) allows the identical path.
  expect(Permission.evaluate("edit", OWN_REVIEWS_PATH, merged).action).toBe("deny")
})

test("residual risk #7 (mutation, CRITICAL): omitting the deny-all '*' entry entirely lets an unrelated .yui-soul path silently fall through to the agent-level '*': 'allow' default", () => {
  const scopedAllowOnly = {
    "*/.yui-soul/reviews/*": "allow",
    "*/.yui-soul/rfcs/*/*/review-sho.md": "allow",
    // deliberately no "*": "deny" entry
  } as const
  const merged = Permission.merge(AGENT_LEVEL_DEFAULTS, Permission.fromConfig({ edit: scopedAllowOnly }))
  // Neither scoped-allow pattern matches a knowledge/gotchas path, so `evaluate()`'s `.findLast()`
  // finds no match within the user config at all and falls all the way back to
  // AGENT_LEVEL_DEFAULTS's own `"*": "allow"` entry (agent.ts:120) — an unrelated .yui-soul path,
  // and by the same mechanism any application source path, is silently ALLOWED. This is the exact
  // failure mode the deny-all "*" entry exists to close; the correctly-configured suite above
  // (SHO_SCOPED_EDIT, "denies application source code") proves the fix.
  expect(Permission.evaluate("edit", OTHER_KNOWLEDGE_PATH, merged).action).toBe("allow")
  expect(Permission.evaluate("edit", APP_SOURCE_PATH, merged).action).toBe("allow")
})
