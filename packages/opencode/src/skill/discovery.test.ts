/**
 * @spec-handoff
 * @interface Discovery.Service.pull(url: string): Effect.Effect<string[]>
 * @behavior
 *   Path-traversal guard (spec-reconciliation.md, Point 4 — CRITICAL). `skill.name`
 *   and `skill.files[]` come from a remote, untrusted `index.json`. `isSafeName` /
 *   isSafeFilePath` plus a resolved-boundary check on every constructed path are the
 *   only thing standing between a malicious index and arbitrary file writes on disk.
 *
 *   Contract (see spec-reconciliation.md Point 4 for the full table):
 *     - Unsafe `skill.name` (contains "/", "\\", "..", empty, or too long) → the
 *       WHOLE skill is skipped, before the version file is ever read, before any
 *       network request for that skill's files is made.
 *     - Fast path (no `version`, or cached version matches): an unsafe `file` entry
 *       (contains "..", starts with "/" or "\\") or a destination that resolves
 *       outside the skill root → that ONE file is skipped, download continues for
 *       the rest of `skill.files`.
 *     - Slow path (versioned refresh, staged install): an unsafe `file` entry counts
 *       as a failed download for that file → `downloaded.every(Boolean)` is false →
 *       the ENTIRE staged swap is aborted. The staging directory is removed, and any
 *       pre-existing cached install (`root`) is left completely untouched — not
 *       partially overwritten, not deleted.
 * @edge-cases
 *   - `{ name: "../../escape", files: ["SKILL.md"] }` → skill fully skipped, zero
 *     HTTP requests for it, nothing written outside the skills cache.
 *   - Fast path, `{ name: "safe", files: ["SKILL.md", "../escape.txt"] }` → SKILL.md
 *     downloads normally; "../escape.txt" is never fetched and never written
 *     anywhere (in particular, not one level up from the skill root).
 *   - Slow path (has `version`), same shape → the entire install is aborted: no
 *     `root` directory is left behind (or, if one already existed from a prior good
 *     install, it is byte-for-byte unchanged), no `.tmp-*` / `.old-*` siblings leak.
 * @testability
 *   This module reads `Global.Path.cache` directly (not injected via DI), so tests
 *   run against the real OS cache directory scoped under uniquely-randomized skill
 *   names to avoid colliding with ../../test/skill/discovery.test.ts, which
 *   exercises the same real cache directory for non-adversarial download/versioning
 *   behavior.
 * @see ./discovery.ts
 * @see ../../test/skill/discovery.test.ts (non-adversarial download/versioning coverage)
 * @see ../../../core/test/skill-discovery.test.ts (V2 sibling module, stricter whole-skill-reject contract)
 */

import { afterAll, beforeAll, describe, expect } from "bun:test"
import { rm } from "fs/promises"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Effect } from "effect"
import { Discovery } from "./discovery"
import { testEffect } from "../../test/lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Discovery.node, FSUtil.node])))

const cacheDir = path.join(Global.Path.cache, "skills")
const rand = crypto.randomUUID().slice(0, 8)
const skillName = (label: string) => `shin-traversal-${label}-${rand}`

let server: ReturnType<typeof Bun.serve>
let baseUrl: string
const requestLog: string[] = []

// Per-skill mutable index bodies so each test can control exactly what the
// remote (untrusted) manifest claims without spinning up a new server.
const indexBodies = new Map<string, unknown>()

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      requestLog.push(url.pathname)

      const indexMatch = /^\/([^/]+)\/index\.json$/.exec(url.pathname)
      if (indexMatch) {
        const body = indexBodies.get(indexMatch[1])
        if (!body) return new Response("Not Found", { status: 404 })
        return Response.json(body)
      }
      if (url.pathname.endsWith("/SKILL.md")) return new Response("# safe content")

      // Any other path — INCLUDING whatever a traversal-crafted `file` entry
      // resolves to remotely once ".." segments collapse against the URL — is
      // served with 200 content. This deliberately removes "remote 404" as a
      // confound: whether the traversal write actually lands on disk must be
      // decided purely by the LOCAL destination guard in discovery.ts, not by
      // whether this fixture server happens to have that path.
      return new Response("# escaped content (should never be written locally)")
    },
  })
  baseUrl = `http://localhost:${server.port}`
})

afterAll(async () => {
  server?.stop()
  await Promise.all(
    ["name-escape", "fast", "slow", "slow-preserve"].map((label) =>
      rm(path.join(cacheDir, skillName(label)), { recursive: true, force: true }),
    ),
  )
  await rm(path.join(cacheDir, `ESCAPED-${rand}.txt`), { force: true })
})

describe("Discovery.pull — path traversal guard (Point 4, CRITICAL)", () => {
  it.live("unsafe skill.name is skipped entirely, before any request for that skill's files", () =>
    Effect.gen(function* () {
      const discovery = yield* Discovery.Service
      const key = "name-escape"
      const escapedName = `../../${skillName(key)}`
      indexBodies.set(key, { skills: [{ name: escapedName, files: ["SKILL.md"] }] })
      requestLog.length = 0

      const dirs = yield* discovery.pull(`${baseUrl}/${key}/`)

      expect(dirs).toEqual([])
      // Only the index itself is ever requested — never SKILL.md for the unsafe name.
      expect(requestLog.filter((p) => p.endsWith("SKILL.md"))).toEqual([])
      // Where an unguarded `path.join(cache, skill.name)` would have landed.
      const wouldEscapeTo = path.join(cacheDir, "..", "..", skillName(key))
      expect(yield* (yield* FSUtil.Service).existsSafe(wouldEscapeTo)).toBe(false)
    }),
  )

  it.live("fast path: unsafe file entry is skipped, download continues for the rest of the skill", () =>
    Effect.gen(function* () {
      const discovery = yield* Discovery.Service
      const key = "fast"
      const name = skillName(key)
      indexBodies.set(key, { skills: [{ name, files: ["SKILL.md", `../ESCAPED-${rand}.txt`] }] })

      const dirs = yield* discovery.pull(`${baseUrl}/${key}/`)

      expect(dirs).toEqual([path.join(cacheDir, name)])
      const fsys = yield* FSUtil.Service
      expect(yield* fsys.existsSafe(path.join(cacheDir, name, "SKILL.md"))).toBe(true)
      // The traversal target — one level *above* the skill root, i.e. directly in
      // the shared skills cache — must never be created.
      expect(yield* fsys.existsSafe(path.join(cacheDir, `ESCAPED-${rand}.txt`))).toBe(false)
    }),
  )

  it.live(
    "slow path (versioned): unsafe file entry aborts the entire staged install, no partial root, no leaked staging/backup dirs",
    () =>
      Effect.gen(function* () {
        const discovery = yield* Discovery.Service
        const key = "slow"
        const name = skillName(key)
        indexBodies.set(key, {
          skills: [{ name, version: "1", files: ["SKILL.md", `../ESCAPED-${rand}.txt`] }],
        })

        const dirs = yield* discovery.pull(`${baseUrl}/${key}/`)

        expect(dirs).toEqual([])
        const fsys = yield* FSUtil.Service
        // No root was ever published (the swap never happened).
        expect(yield* fsys.existsSafe(path.join(cacheDir, name))).toBe(false)
        // No leaked staging/backup siblings.
        const siblings = yield* Effect.promise(() =>
          Array.fromAsync(new Bun.Glob(`${name}.{tmp,old}-*`).scan({ cwd: cacheDir, onlyFiles: false })),
        )
        expect(siblings).toEqual([])
        // The traversal target was never written anywhere.
        expect(yield* fsys.existsSafe(path.join(cacheDir, `ESCAPED-${rand}.txt`))).toBe(false)
      }),
  )

  it.live(
    "slow path (versioned): an aborted refresh leaves a pre-existing good install completely untouched",
    () =>
      Effect.gen(function* () {
        const discovery = yield* Discovery.Service
        const key = "slow-preserve"
        const name = skillName(key)

        // First, a clean v1 install.
        indexBodies.set(key, { skills: [{ name, version: "1", files: ["SKILL.md"] }] })
        const first = yield* discovery.pull(`${baseUrl}/${key}/`)
        expect(first).toEqual([path.join(cacheDir, name)])
        const fsys = yield* FSUtil.Service
        expect(yield* fsys.readFileString(path.join(cacheDir, name, "SKILL.md"))).toBe("# safe content")

        // Then a malicious v2 manifest attempts to hijack the refresh.
        indexBodies.set(key, {
          skills: [{ name, version: "2", files: ["SKILL.md", `../ESCAPED-${rand}.txt`] }],
        })
        const second = yield* discovery.pull(`${baseUrl}/${key}/`)

        // The install is reported as still present (root untouched from v1)...
        expect(second).toEqual([path.join(cacheDir, name)])
        // ...and the version file was never bumped to "2" (the swap aborted).
        expect(yield* fsys.readFileString(path.join(cacheDir, name, ".opencode-version"))).toBe("1")
        expect(yield* fsys.existsSafe(path.join(cacheDir, `ESCAPED-${rand}.txt`))).toBe(false)
        const siblings = yield* Effect.promise(() =>
          Array.fromAsync(new Bun.Glob(`${name}.{tmp,old}-*`).scan({ cwd: cacheDir, onlyFiles: false })),
        )
        expect(siblings).toEqual([])
      }),
  )
})
