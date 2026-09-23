/**
 * @spec-handoff
 * @interface `InstanceStore.load(input: LoadInput): Effect.Effect<InstanceContext>` (no signature
 *   change — this file is regression coverage FOR an already-landed fix, not a new interface).
 * @behavior
 *   - A directory's FIRST bootstrap (`InstanceStore.load()` -> `bootstrap.run` ->
 *     `plugin.init()`) must resolve even when a plugin's own `server()` hook makes a
 *     self-referential in-process HTTP round-trip back into the SAME directory before returning
 *     — e.g. `input.ui.publish(...)` (plugin-ui's documented "safe" pattern) or
 *     `input.client.*` (any plain SDK client call, zero plugin-ui code involved).
 *   - The fix (commit a9d91e92d9, `src/project/instance-store.ts`) is an `AsyncLocalStorage`
 *     reentrancy guard scoped at the `InstanceStore.load()` layer itself, not at the
 *     plugin-ui-publish call site — so it must cover ANY self-referential call, not just
 *     `input.ui.publish()`. Test 2 below is the discriminating case: it would still deadlock
 *     under a narrower, publish-specific fix (e.g. extracting just the plugin-ui flush to bypass
 *     HTTP) and only passes under the general, `InstanceStore`-level fix that was actually chosen.
 * @edge-cases
 *   - Test 1 (ported from Sui's debug-session repro) uses `input.ui.publish()` exclusively — the
 *     ORIGINAL symptom, on a single `Server.Default()` graph, no second DI graph, no
 *     blocking/looping plugin.
 *   - Test 2 uses `input.client.config.get()` exclusively — proves the fix is NOT
 *     plugin-ui-specific. See `.yui-soul/debug/active/20260922-224215-f83edc-plugin-ui-publish-deadlock/session.md`
 *     Resolution section for why a plugin-ui-only fix would leave this case deadlocked.
 * @see .yui-soul/plans/wip/293-opencode-plugin-ui-event-channel/e6b-instance-store-reentrancy-fix.md
 * @see .yui-soul/debug/active/20260922-224215-f83edc-plugin-ui-publish-deadlock/repros/single-instance-deadlock.test.ts
 * @see ../../src/project/instance-store.ts (the fix under test)
 */

// -----------------------------------------------------------------------------------------------
// Invocation note (Kou's cross-file test-isolation flag, E6b Task 1):
//
//   Running this file TOGETHER with `test/plugin/plugin-ui-publish.test.ts` in the SAME bun
//   test worker (no `--isolate`) can fail even against the landed fix, because both files touch
//   `Server.Default()` — a `lazy()`-memoized module-level singleton — and the shared process-wide
//   `memoMap` those in-process HTTP round-trips resolve services through. Without `--isolate`,
//   leftover global/module state from one file's run can bleed into the other's.
//
//   Always run either:
//     bun test test/project/instance-store-reentrancy.test.ts --isolate        (standalone)
//   or:
//     bun test test/project/ test/plugin/plugin-ui-publish.test.ts --isolate   (combined)
//
//   This file was confirmed green both standalone and combined, with `--isolate`, against the
//   Task-1 fix (commit a9d91e92d9). Do not drop `--isolate` when combining with
//   `test/plugin/plugin-ui-publish.test.ts` — see Kou's Task 1 handoff / Taku's diagnosis in the
//   plan's debug session for the mechanism.
// -----------------------------------------------------------------------------------------------

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shin-reentrancy-"))
  try {
    await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

async function writePluginProject(dir: string, pluginBody: string) {
  const pluginFile = path.join(dir, "plugin.ts")
  await fs.writeFile(
    pluginFile,
    ["export default {", '  id: "reentrancy-plugin",', "  server: async (input, options) => {", pluginBody, "    return {}", "  },", "}", ""].join(
      "\n",
    ),
  )
  await fs.writeFile(
    path.join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: [pathToFileURL(pluginFile).href] }, null, 2),
  )
}

// Server.Default().app.request(...) is typed `Response | Promise<Response>` (the app's `fetch`
// override returns synchronously when `handler` short-circuits) — Taku's own flagged type issue
// from the ported repro. `Promise.resolve(...)` normalizes it to a real Promise so this composes
// correctly with `Promise.race` below, fixing the `bun typecheck` error the raw port produced.
function requestSnapshot(directory: string) {
  return Promise.resolve(
    Server.Default().app.request("/plugin-ui/snapshot", {
      headers: { "x-opencode-directory": directory },
    }),
  )
}

function requestConfig(directory: string) {
  return Promise.resolve(
    Server.Default().app.request("/config", {
      headers: { "x-opencode-directory": directory },
    }),
  )
}

// ---------------------------------------------------------------------------
// Test 1 — ported repro (Sui, debug session 20260922-224215-f83edc): the ORIGINAL symptom.
// Single Server.Default() graph, no second DI graph, no blocking/looping plugin — a plugin whose
// server() hook does `await input.ui.publish(...); return {}` synchronously. Before the fix, this
// deadlocked the directory's own first bootstrap (Evidence #4 in the debug session). After the
// fix, the request resolves well within a normal timeout — not the repro's original 8s
// race-timeout escape hatch, since the fix should resolve this promptly, not just "eventually".
// ---------------------------------------------------------------------------

test(
  "single Server.Default() graph: a plugin publishing via input.ui.publish() synchronously during its own server() hook does not deadlock the directory's first bootstrap",
  async () => {
    await withFreshDirectory(async (dir) => {
      await writePluginProject(dir, '    await input.ui.publish("status", { phase: "during-load" })')

      const response = await withTimeout(
        requestSnapshot(dir),
        5_000,
        "GET /plugin-ui/snapshot for a fresh directory did not settle within 5000ms — the input.ui.publish() reentrancy guard regressed",
      )

      expect(response.status).toBe(200)
    })
  },
  10_000,
)

// ---------------------------------------------------------------------------
// Test 2 — the discriminating general-case test (Taku's own repro basis, also mirrored by the
// pre-existing `test/server/httpapi-listen.test.ts` "plugin client requests reuse the listening
// server instance" case, which uses a REAL listener rather than a fresh directory's FIRST
// bootstrap). This plugin's server() hook calls ONLY `input.client.config.get()` — zero
// plugin-ui code involved. A fix narrowly scoped to the plugin-ui publish call site (e.g.
// rerouting just `input.ui.publish()` around the HTTP round-trip) would still deadlock THIS case,
// because the self-referential call here is a plain client request, not a publish. This test
// only passes because Taku's chosen fix guards reentrancy at the InstanceStore.load() layer
// itself — the general mechanism, not the specific call site.
// ---------------------------------------------------------------------------

test(
  "single Server.Default() graph: a plugin calling input.client.config.get() synchronously during its own server() hook does not deadlock the directory's first bootstrap (general-case, non-plugin-ui reentrancy)",
  async () => {
    await withFreshDirectory(async (dir) => {
      const marker = path.join(dir, "client-call-completed.marker")
      await writePluginProject(
        dir,
        [
          `    await input.client.config.get()`,
          `    await Bun.write(${JSON.stringify(marker)}, "completed")`,
        ].join("\n"),
      )

      const response = await withTimeout(
        requestConfig(dir),
        5_000,
        "GET /config for a fresh directory did not settle within 5000ms — the general (non-plugin-ui) InstanceStore.load() reentrancy guard regressed",
      )

      expect(response.status).toBe(200)
      // The discriminating assertion: not just "the outer request resolved" but "the plugin's own
      // self-referential input.client.config.get() call, made synchronously during its own
      // server() hook, actually completed" — proving the reentrant inner call itself returned
      // rather than the outer request resolving through some unrelated path.
      expect(await Bun.file(marker).exists()).toBe(true)
    })
  },
  10_000,
)
