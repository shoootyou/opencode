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

import { describe, expect, test } from "bun:test"
import { pathToFileURL } from "url"
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
