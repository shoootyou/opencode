/**
 * @spec-handoff
 * @interface isSafeName(name: string): boolean
 * @interface isSafeFilePath(file: string): boolean
 * @behavior
 *   Fast, unit-level pin for the exact vulnerability reproduced end-to-end in
 *   ./discovery.test.ts's "identity bypass" describe block (Ei audit r1, Point 1
 *   CRITICAL, plan 123-opencode-fork-sync-v1-17-13): `"."` passes BOTH of these
 *   character guards today (it contains none of "/", "\\", ".."), which is
 *   exactly why the separate resolved-boundary check further down in
 *   discovery.ts is the only thing left standing between a malicious
 *   `skill.name: "."` and writing anywhere inside the shared skills cache — and
 *   that boundary check is ALSO broken for `"."` (see discovery.test.ts). This
 *   file exists so the two layers of defense can be killed independently: a
 *   payload using literal ".." or "/" is caught here, before the boundary-check
 *   code path is ever exercised in isolation — the two integration tests in
 *   ./discovery.test.ts use `"."` specifically because it is the one input that
 *   defeats this character guard while still reaching the (also broken)
 *   boundary check.
 * @edge-cases
 *   - `isSafeName(".")` → MUST be `false`. `"."` resolves the constructed root
 *     to exactly the shared cache directory (`path.join(cache, ".") === cache`);
 *     a name-level guard is the correct, cheapest place to reject it, before any
 *     boundary-resolution logic runs at all.
 *   - `isSafeFilePath(".")` → MUST be `false`, for the same reason applied to a
 *     `skill.files[]` entry (`path.join(root, ".") === root`, planting/replacing
 *     the skill's own directory instead of a file inside it).
 * @testability
 *   `isSafeName`/`isSafeFilePath` are private (non-exported) top-level consts in
 *   discovery.ts today. This file imports them by name deliberately — the import
 *   fails with a `SyntaxError` at module load until discovery.ts adds them to its
 *   export surface, which is the intended RED signal driving that (minimal,
 *   safe) export addition as part of the Point 1 remediation. Kept in its own
 *   file, separate from discovery.test.ts, so this module-load failure cannot
 *   collateral-damage that file's four pre-existing, currently-passing tests.
 * @see ./discovery.ts (isSafeName, isSafeFilePath — currently unexported)
 * @see ./discovery.test.ts (integration-level "identity bypass" reproduction)
 */

import { describe, expect, test } from "bun:test"
import { isSafeFilePath, isSafeName } from "./discovery"

describe("discovery.ts name/path guards — '.' identity bypass (Point 1/4, CRITICAL)", () => {
  test("isSafeName('.') is rejected", () => {
    expect(isSafeName(".")).toBe(false)
  })

  test("isSafeFilePath('.') is rejected", () => {
    expect(isSafeFilePath(".")).toBe(false)
  })

  test("isSafeName still accepts an ordinary safe name (no regression)", () => {
    expect(isSafeName("my-skill")).toBe(true)
  })

  test("isSafeFilePath still accepts an ordinary safe subpath (no regression)", () => {
    expect(isSafeFilePath("assets/icon.png")).toBe(true)
  })
})
