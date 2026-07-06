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
 *
 *   CRITICAL follow-up (audit round 1, Ei — Point 1 real vulnerability, plan
 *   123-opencode-fork-sync-v1-17-13): `skill.name: "."` passes `isSafeName` (it
 *   contains none of "/", "\\", ".."), but `path.join(cache, ".")` normalizes to
 *   EXACTLY `cache` — so the boundary check `!x.startsWith(base + sep) && x !==
 *   base` treats it as safe (the `x !== base` half of the guard is false, so the
 *   whole `!A && B` short-circuits to false — nothing is skipped). This defeats the
 *   per-skill root boundary at all three construction points: the fast-path root
 *   check, the slow-path staging-root check inherits the same broken `root`, and
 *   the version-refresh swap operates directly on the shared cache directory
 *   itself. See the "identity bypass" describe block below for the two tests that
 *   pin this down; they are the CURRENT reproduction of the vulnerability and must
 *   be RED until command/index.ts's discovery.ts is patched to reject `name === "."`
 *   (and `".."`-normalizing equivalents) explicitly.
 * @edge-cases
 *   - `{ name: "../../escape", files: ["SKILL.md"] }` → skill fully skipped, zero
 *     HTTP requests for it, nothing written outside the skills cache.
 *   - Fast path, `{ name: "safe", files: ["SKILL.md", "../escape.txt"] }` → SKILL.md
 *     downloads normally; "../escape.txt" is never fetched and never written
 *     anywhere (in particular, not one level up from the skill root).
 *   - Slow path (has `version`), same shape → the entire install is aborted: no
 *     `root` directory is left behind (or, if one already existed from a prior good
 *     install, it is byte-for-byte unchanged), no `.tmp-*` / `.old-*` siblings leak.
 *   - `{ name: ".", files: ["SKILL.md", "<victim>/SKILL.md"] }` (fast path, no
 *     version) → the write into `<victim>/SKILL.md` must be skipped (it targets a
 *     DIFFERENT skill's namespace, one level "up" from any real per-skill root);
 *     today it is NOT skipped.
 *   - `{ name: ".", version: "1", files: ["SKILL.md"] }` (slow path) → the ENTIRE
 *     skills cache — every already-installed skill from every source — must
 *     survive untouched; today the whole cache directory is renamed to a backup,
 *     replaced by the malicious staged content, and the backup (containing every
 *     other skill) is deleted.
 * @testability
 *   This module reads `Global.Path.cache` directly (not injected via DI), so tests
 *   run against the real OS cache directory scoped under uniquely-randomized skill
 *   names to avoid colliding with ../../test/skill/discovery.test.ts, which
 *   exercises the same real cache directory for non-adversarial download/versioning
 *   behavior. The two `name: "."` tests below target the shared cache ROOT itself
 *   (not a randomized subdirectory, by definition of the bug), so the slow-path one
 *   quarantines whatever already lives at the cache root before running, and
 *   restores it afterward inside `Effect.ensuring`, so it can never permanently
 *   destroy a sibling test file's fixtures even though it deliberately destroys its
 *   own — see "quarantine" in that test.
 *   Pure-function unit tests for `isSafeName(".")`/`isSafeFilePath(".")` live in
 *   ./discovery-name-guards.test.ts instead of here: importing those two
 *   currently-unexported functions makes THAT file fail at module-load with a
 *   `SyntaxError`, which would otherwise take out every test in this shared file.
 * @see ./discovery.ts
 * @see ./discovery-name-guards.test.ts (isSafeName(".")/isSafeFilePath(".") pure-function unit tests)
 * @see ../../test/skill/discovery.test.ts (non-adversarial download/versioning coverage)
 * @see ../../../core/test/skill-discovery.test.ts (V2 sibling module, stricter whole-skill-reject contract)
 */

import { afterAll, beforeAll, describe, expect } from "bun:test"
import { mkdir, readdir, rename, rm } from "fs/promises"
import os from "os"
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
  // Collateral of the "." identity-bypass fast-path test below: the malicious
  // entry's mandatory "SKILL.md" sentinel lands directly at the cache root.
  await rm(path.join(cacheDir, "SKILL.md"), { force: true })
  await rm(path.join(cacheDir, skillName("dot-fast-victim")), { recursive: true, force: true })
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

describe("Discovery.pull — skill.name '.' bypasses the resolved-boundary check (Point 1, CRITICAL — Ei audit r1)", () => {
  it.live(
    "fast path: name '.' plants a file inside a DIFFERENT skill's own directory, crossing the per-skill root boundary",
    () =>
      Effect.gen(function* () {
        const discovery = yield* Discovery.Service
        const fsys = yield* FSUtil.Service
        const key = "dot-fast"
        const victim = skillName("dot-fast-victim")
        // The mandatory "SKILL.md" sentinel is required for this entry to survive
        // the `list = data.skills.filter((s) => s.files.includes("SKILL.md"))` gate
        // at all (see discovery.ts) — every real attack payload needs it too.
        indexBodies.set(key, { skills: [{ name: ".", files: ["SKILL.md", `${victim}/SKILL.md`] }] })

        const dirs = yield* discovery.pull(`${baseUrl}/${key}/`)

        // The write into another skill's namespace must never happen — this is
        // the CURRENT reproduction of the bug: `root = path.join(cache, ".")`
        // normalizes to exactly `cache`, so the boundary check never rejects it,
        // and `path.join(root, "<victim>/SKILL.md")` resolves inside `cache` and
        // is written.
        expect(yield* fsys.existsSafe(path.join(cacheDir, victim, "SKILL.md"))).toBe(false)
        // Nor should the malicious "." entry ever be reported as a legitimate
        // discovered skill directory — the shared cache root is not a skill.
        expect(dirs).not.toContain(cacheDir)
      }),
  )

  it.live(
    "slow path (versioned): name '.' destroys/replaces the ENTIRE skills cache root — every pre-existing skill from every source is lost",
    () =>
      Effect.gen(function* () {
        const fsys = yield* FSUtil.Service
        const discovery = yield* Discovery.Service

        // This attack targets the shared cache ROOT itself (that's the bug), not
        // a randomized subdirectory like every other test in this file. Quarantine
        // whatever currently lives there — including fixtures from sibling test
        // files sharing this same real OS directory — so this destructive PoC can
        // only ever destroy the two fixtures IT creates below, never a sibling's.
        const quarantine = path.join(os.tmpdir(), `shin-quarantine-${rand}`)
        yield* Effect.promise(async () => {
          await mkdir(quarantine, { recursive: true })
          const entries = await readdir(cacheDir, { withFileTypes: true }).catch(() => [])
          await Promise.all(entries.map((e) => rename(path.join(cacheDir, e.name), path.join(quarantine, e.name))))
          await mkdir(cacheDir, { recursive: true })
        })

        const result = yield* Effect.gen(function* () {
          const legitA = skillName("legit-a")
          const legitB = skillName("legit-b")
          yield* fsys.writeWithDirs(
            path.join(cacheDir, legitA, "SKILL.md"),
            new TextEncoder().encode("# legit A content"),
          )
          yield* fsys.writeWithDirs(
            path.join(cacheDir, legitB, "SKILL.md"),
            new TextEncoder().encode("# legit B content"),
          )

          const key = "dot-slow"
          indexBodies.set(key, { skills: [{ name: ".", version: "1", files: ["SKILL.md"] }] })
          const dirs = yield* discovery.pull(`${baseUrl}/${key}/`)

          return {
            dirs,
            legitAExists: yield* fsys.existsSafe(path.join(cacheDir, legitA, "SKILL.md")),
            legitBExists: yield* fsys.existsSafe(path.join(cacheDir, legitB, "SKILL.md")),
            // The malicious entry's own file, dropped directly at the cache root.
            rootSkillMd: yield* fsys.existsSafe(path.join(cacheDir, "SKILL.md")),
          }
        }).pipe(
          // Restore the quarantined siblings BEFORE any assertion runs, so a
          // failing (RED) assertion below can never leave the shared cache
          // corrupted for other test files.
          Effect.ensuring(
            Effect.promise(async () => {
              await rm(cacheDir, { recursive: true, force: true })
              await mkdir(cacheDir, { recursive: true })
              const quarantined = await readdir(quarantine, { withFileTypes: true }).catch(() => [])
              await Promise.all(
                quarantined.map((e) => rename(path.join(quarantine, e.name), path.join(cacheDir, e.name))),
              )
              await rm(quarantine, { recursive: true, force: true })
            }),
          ),
        )

        // CURRENT (buggy) reproduction: `root = path.join(cache, ".")` normalizes
        // to `cache`, so `fs.rename(root, backup)` renames the WHOLE cache away,
        // `fs.rename(staging, root)` replaces it with just the malicious payload,
        // and the backup (containing legitA + legitB) is deleted. Both legit
        // installs vanish, and the raw cache root gets reported as a "skill dir".
        expect(result.dirs).not.toContain(cacheDir)
        expect(result.legitAExists).toBe(true)
        expect(result.legitBExists).toBe(true)
        expect(result.rootSkillMd).toBe(false)
      }),
  )
})
