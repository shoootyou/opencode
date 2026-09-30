/**
 * @spec-handoff
 * @interface `readSnapshot` (`PluginUiHttpApi.snapshot`, the `GET /plugin-ui/snapshot` handler
 *   in `src/server/routes/instance/httpapi/handlers/plugin-ui.ts`) aggregates
 *   `directories()` (`@/plugin/ui-store`) — EVERY directory the server currently holds
 *   plugin-UI state for, module-level, process-wide — into ONE response array, then encodes
 *   that whole array against `SnapshotResponse`'s `Schema.Array(SnapshotEntry)` (D20/D21).
 * @behavior
 *   - **The invariant this file proves must hold once the round-3 fix lands:** a malformed
 *     (non-object `data`) row retained under ANY directory must never cause `GET
 *     /plugin-ui/snapshot` to fail for an UNRELATED, healthy directory's own snapshot read. Per
 *     r2-sho-e6c-deadlock.md finding #1, the CURRENT (unfixed) behavior is the opposite: because
 *     `publishDirect` has no runtime type gate on `data`, a single malformed direct-path write to
 *     directory `bad` poisons the aggregate array's `Schema` response encode for EVERY directory,
 *     including a completely healthy, unrelated directory `good` — that directory's own snapshot
 *     read 400s even though `good` itself never received anything invalid. This is a
 *     cross-directory availability DoS via one bad row.
 *   - Once `publishDirect`/`validatePayload` gain the `invalid_data` gate (see the sibling
 *     `ui-store-validation-parity.test.ts`'s `@spec-handoff` for the exact fix), the malformed
 *     write is rejected AT THE DIRECT-WRITE CALL SITE and never reaches the shared store at all —
 *     so this file's test should pass as an simple consequence of the input-rejection fix, NOT
 *     because `readSnapshot`/`flatten` itself gained defensive skip-invalid-rows logic. This file
 *     intentionally tests the OBSERABLE blast-radius symptom (a healthy directory's snapshot read
 *     failing) rather than re-asserting the input-rejection behavior the parity file already
 *     covers — the two files are deliberately non-overlapping in what they assert.
 *   - Defense-in-depth (Sho's alternative/additional recommendation, NOT required to close this
 *     finding but worth flagging to Kou): `readSnapshot`/`flatten` in `plugin-ui.ts` could
 *     additionally skip a structurally-invalid retained row rather than let it fail the whole
 *     response encode, so a future bypass of the write-time gate (e.g. a bug in `validatePayload`
 *     itself) cannot repeat this exact cross-directory blast radius. Out of scope for this
 *     specific test file, which only asserts the write-time-gate fix is sufficient on its own.
 * @edge-cases
 *   - The "good" directory must have its OWN healthy, valid entry actually present and correctly
 *     attributed in its own snapshot response — not merely a 200 status with an empty/wrong
 *     body. A 200 with a missing/incorrect entry would be a silent-drop bug of its own.
 *   - The malformed write must be attempted via the exact same `publishDirect` entry point the
 *     plugin runtime's `sendPublish` calls (`@/plugin/ui-store`) — not a hand-crafted store
 *     mutation that bypasses whatever gate eventually exists there.
 * @see .yui-soul/reviews/293-opencode-plugin-ui-event-channel/r2-sho-e6c-deadlock.md finding #1
 *      (the live, cap-exceeding HIGH this file's invariant closes — round 3 remediation)
 * @see ./ui-store-validation-parity.test.ts (the sibling file asserting the actual input
 *      rejection at the `publishDirect`/`validatePayload` boundary)
 * @see ../../src/server/routes/instance/httpapi/handlers/plugin-ui.ts (`readSnapshot`, `flatten`,
 *      `snapshot` — the response-encoding path this blast radius travels through)
 * @see ../../src/plugin/ui-store.ts (`publishDirect`, `directories()` — the shared store both the
 *      malformed write and the healthy directory's own state live in)
 */

import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { publishDirect } from "../../src/plugin/ui-store"
import { disposeInstance } from "../../src/effect/instance-registry"
import { PluginUiPaths } from "../../src/server/routes/instance/httpapi/groups/plugin-ui"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "../server/httpapi-layer"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const it = testEffect(httpApiLayer)

function freshBadDirectory() {
  return `/tmp/shin-e6c-blast-radius-bad-${Math.random().toString(36).slice(2)}`
}

describe("publishDirect cross-directory blast radius (round-3 remediation, r2-sho-e6c-deadlock.md #1)", () => {
  it.instance(
    "a malformed non-object data write to one directory does not break GET /plugin-ui/snapshot for an unrelated healthy directory",
    () =>
      Effect.gen(function* () {
        const good = yield* TestInstance

        // The healthy directory publishes a perfectly valid entry through the real HTTP wire
        // path — exactly the request this finding's blast radius incorrectly breaks.
        const published = yield* requestInDirectory(PluginUiPaths.publish, good.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pluginID: "healthy-plugin", event: "ok", data: { status: "fine" } }),
        })
        expect(published.status).toBe(200)

        // An UNRELATED directory receives a malformed direct-path write — the exact entry point
        // `plugin/index.ts`'s `sendPublish` uses for a plugin's own `input.ui.publish()` call.
        // This directory is never registered as a real instance; `publishDirect` only needs a
        // directory string, and `readSnapshot` aggregates every directory the module-level store
        // knows about regardless of instance registration (D2/D20).
        const bad = freshBadDirectory()
        try {
          const reason = publishDirect({
            directory: bad,
            workspaceID: undefined,
            pluginID: "bad-plugin",
            event: "boom",
            data: "i-am-a-string",
          })

          // This assertion documents intent, not this file's own subject: once the round-3 fix
          // lands, this direct write is rejected (`invalid_data`) and never reaches the shared
          // store — so the snapshot read below never even encounters a malformed row. Asserting
          // it here (rather than leaving it silently unchecked) makes the causal chain explicit:
          // reject-at-write-time is WHY the read below stays healthy, not a defensive skip on
          // the read side.
          expect(reason).toBe("invalid_data")

          // THE load-bearing assertion for this file: the good, unrelated, healthy directory's
          // OWN snapshot read must still succeed and still contain its own entry — a single bad
          // write elsewhere in the process must never take this down.
          const snapshot = yield* requestInDirectory(PluginUiPaths.snapshot, good.directory)
          expect(snapshot.status).toBe(200)

          const body = (yield* snapshot.json) as {
            entries: Array<{ pluginID: string; event: string; data: unknown; directory: string }>
          }
          expect(body.entries).toContainEqual(
            expect.objectContaining({
              pluginID: "healthy-plugin",
              event: "ok",
              data: { status: "fine" },
              directory: good.directory,
            }),
          )
        } finally {
          yield* Effect.promise(() => disposeInstance(bad))
        }
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
