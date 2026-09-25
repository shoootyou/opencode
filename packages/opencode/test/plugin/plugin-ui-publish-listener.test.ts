/**
 * @spec-handoff
 * @interface `PluginInput.ui.publish` (unchanged wire contract) — this file's own subject is the
 *   INTERNAL delivery mechanism `plugin/index.ts`'s `sendPublish` uses when a plugin's own
 *   `server()` hook calls `input.ui.publish(...)` synchronously during that same directory's
 *   first bootstrap. `publishDirect` (`@/plugin/ui-store`) writes straight into the shared
 *   module-level retained store (D2) and relays over SSE — no HTTP round-trip, no
 *   `InstanceContextMiddleware` / `InstanceStore.load()` re-entry (D1).
 * @behavior
 *   - The E6b `AsyncLocalStorage` reentrancy guard in `project/instance-store.ts` only survives
 *     a SINGLE process's async-continuation graph. It does NOT survive a real TCP round-trip,
 *     because the inbound request on a real `Server.listen()` socket runs in a brand-new async
 *     context on the server side (r1-sho-e5e6e6b.md finding #1 / r1-ei-general.md finding #1).
 *     Every test in this file therefore uses a REAL `Server.listen()` listener — never
 *     `Server.Default()`'s in-process fallback — since that is the only transport that can
 *     actually discriminate "reentrancy guard survives the wire" from "reentrancy guard only
 *     survives in-process."
 *   - A plugin calling `input.ui.publish(...)` synchronously inside its own `server()` hook must
 *     not deadlock that directory's first bootstrap under a real listener, and the published
 *     entry must actually land in a subsequent snapshot read (not just "the request didn't
 *     hang").
 *   - The D15 two-concurrent-directory case must also hold under a real listener: two fresh
 *     directories, each with a synchronously-publishing plugin, requested concurrently, must
 *     both resolve and each entry must be attributed to its own directory.
 * @edge-cases
 *   - Mutation check: temporarily reverting `sendPublish` to the old HTTP round-trip (Task E6/E6b
 *     shape) must reproduce the deadlock under a real listener — proving this suite's assertions
 *     are genuinely discriminating, not passing by coincidence. See this session's own report for
 *     the mutation-test transcript; the mutation itself is not committed to this file (per
 *     `mutation-test-assertion`'s "mutate the SOURCE, not the test" recipe).
 * @see .yui-soul/reviews/293-opencode-plugin-ui-event-channel/r1-sho-e5e6e6b.md finding #1
 * @see .yui-soul/reviews/293-opencode-plugin-ui-event-channel/r1-ei-general.md finding #1
 * @see .yui-soul/debug/active/20260922-224215-f83edc-plugin-ui-publish-deadlock/session.md
 * @see ../../src/plugin/ui-store.ts (`publishDirect`, the fix under test)
 * @see ../../src/plugin/index.ts (`sendPublish`, the call site wired to `publishDirect`)
 * @see ./plugin-ui-publish.test.ts (the E6/E6b in-process-only suite this file complements)
 */

import { afterEach, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { Server } from "../../src/server/server"
import { disposeAllInstances } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { withTimeout } from "../../src/util/timeout"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

async function withFreshDirectory(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kou-e6c-listener-"))
  try {
    await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

async function writePluginProject(dir: string, id: string, body: string) {
  const pluginFile = path.join(dir, "plugin.ts")
  await fs.writeFile(
    pluginFile,
    ["export default {", `  id: ${JSON.stringify(id)},`, "  server: async (input, options) => {", body, "    return {}", "  },", "}", ""].join(
      "\n",
    ),
  )
  await fs.writeFile(
    path.join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: [pathToFileURL(pluginFile).href] }, null, 2),
  )
}

function snapshotURL(listenerUrl: URL, directory: string) {
  const url = new URL("/plugin-ui/snapshot", listenerUrl)
  url.searchParams.set("directory", directory)
  return url
}

// ---------------------------------------------------------------------------
// D1/D8 — the actual production case r1-sho/r1-ei's CRITICAL finding names: a plugin publishing
// synchronously during its own server() hook, on a directory's first bootstrap, behind a REAL
// TCP listener.
// ---------------------------------------------------------------------------

test(
  "REAL Server.listen(): a plugin publishing via input.ui.publish() synchronously during its own server() hook does not deadlock the directory's first bootstrap",
  async () => {
    await withFreshDirectory(async (dir) => {
      await writePluginProject(dir, "reentrancy-plugin", '    await input.ui.publish("status", { phase: "during-load" })')

      const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
      try {
        const response = await withTimeout(
          fetch(snapshotURL(listener.url, dir)),
          10_000,
          "GET /plugin-ui/snapshot against a REAL listener did not settle within 10000ms — the real-transport reentrancy fix regressed",
        )
        expect(response.status).toBe(200)
      } finally {
        await listener.stop(true)
      }
    })
  },
  20_000,
)

// The discriminating "did it actually land" check — a request merely not hanging is not
// sufficient; the entry must be observable in a follow-up snapshot read too.
test(
  "REAL Server.listen(): a publish made during the directory's first bootstrap actually lands in a subsequent snapshot read",
  async () => {
    await withFreshDirectory(async (dir) => {
      await writePluginProject(dir, "land-plugin", '    await input.ui.publish("status", { phase: "during-load" })')

      const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
      try {
        const first = await withTimeout(
          fetch(snapshotURL(listener.url, dir)),
          10_000,
          "first GET /plugin-ui/snapshot against a REAL listener did not settle within 10000ms",
        )
        expect(first.status).toBe(200)

        let found: any = undefined
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline) {
          const res = await fetch(snapshotURL(listener.url, dir))
          const body: any = await res.json()
          found = (body.entries ?? []).find((e: any) => e.pluginID === "land-plugin" && e.event === "status")
          if (found) break
          await new Promise((r) => setTimeout(r, 250))
        }
        expect(found).toBeDefined()
        expect(found.data).toEqual({ phase: "during-load" })
        expect(found.directory).toBe(dir)
      } finally {
        await listener.stop(true)
      }
    })
  },
  20_000,
)

// ---------------------------------------------------------------------------
// D15 — the named two-concurrent-directory case, also against a REAL listener.
// ---------------------------------------------------------------------------

test(
  "REAL Server.listen(): two fresh directories, each with a synchronously-publishing plugin, requested concurrently, both resolve and are each attributed to their own directory (D15)",
  async () => {
    const dirA = await fs.mkdtemp(path.join(os.tmpdir(), "kou-e6c-listener-A-"))
    const dirB = await fs.mkdtemp(path.join(os.tmpdir(), "kou-e6c-listener-B-"))
    await writePluginProject(dirA, "plugin-a", '    await input.ui.publish("status", { which: "A" })')
    await writePluginProject(dirB, "plugin-b", '    await input.ui.publish("status", { which: "B" })')

    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const both = await withTimeout(
        Promise.all([fetch(snapshotURL(listener.url, dirA)), fetch(snapshotURL(listener.url, dirB))]),
        15_000,
        "concurrent two-directory GET /plugin-ui/snapshot against a REAL listener did not settle within 15000ms (D15)",
      )
      for (const res of both) expect(res.status).toBe(200)

      let rows: any[] = []
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        rows = ((await (await fetch(snapshotURL(listener.url, dirA))).json()) as any).entries ?? []
        if (rows.some((e) => e.pluginID === "plugin-a") && rows.some((e) => e.pluginID === "plugin-b")) break
        await new Promise((r) => setTimeout(r, 250))
      }
      const a = rows.find((e: any) => e.pluginID === "plugin-a")
      const b = rows.find((e: any) => e.pluginID === "plugin-b")
      expect(a).toBeDefined()
      expect(b).toBeDefined()
      expect(a.directory).toBe(dirA)
      expect(b.directory).toBe(dirB)
      expect(a.data).toEqual({ which: "A" })
      expect(b.data).toEqual({ which: "B" })
    } finally {
      await listener.stop(true)
      await fs.rm(dirA, { recursive: true, force: true }).catch(() => {})
      await fs.rm(dirB, { recursive: true, force: true }).catch(() => {})
    }
  },
  30_000,
)
