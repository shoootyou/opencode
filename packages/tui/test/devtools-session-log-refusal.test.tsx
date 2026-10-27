/**
 * @spec-handoff
 * @interface DevToolsBar session-log dump: AsyncIterable<unknown> -> debug snapshot
 * @behavior
 *   - Treats a terminal `log.error` SSE item as a failed session-log dump.
 *   - Uses the existing fallback history instead of serializing partial or refusal items.
 *   - A normal durable item followed by `log.synced` completes and serializes that item.
 * @edge-cases
 *   - The refusal stream ends immediately after its one terminal SSE frame.
 * @see ../src/component/devtools-bar.tsx
 */
import { expect, test } from "bun:test"
import { lstat, readdir, realpath, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

const session = {
  id: "ses_log_refusal",
  title: "Log refusal fixture",
  projectID: "proj_test",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}

const partial = `data: {"id":"evt_partial","created":1,"type":"session.agent.selected","durable":{"aggregateID":"ses_log_refusal","seq":1,"version":1},"data":{"sessionID":"ses_log_refusal","agent":"partial"}}\n\n`
const refusal = `${partial}data: {"type":"log.error","reason":"Session log unavailable"}\n\n`
const synced = `data: {"id":"evt_model","created":1,"type":"session.model.selected","durable":{"aggregateID":"ses_log_refusal","seq":1,"version":1},"data":{"sessionID":"ses_log_refusal","model":{"providerID":"fixture","id":"fixture"}}}\n\ndata: {"type":"log.synced","aggregateID":"ses_log_refusal","seq":1}\n\n`

async function dump(stream: string) {
  const temporaryDirectory = tmpdir()
  const physicalTemporaryDirectory = await realpath(temporaryDirectory)
  const initialFiles = new Set(await readdir(physicalTemporaryDirectory))
  let file: string | undefined
  await using setup = await createAppFixture({
    width: 112,
    height: 34,
    config: { animations: false, debug: { devtools: true } },
    args: { sessionID: session.id },
    fetch: (url) => {
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/inbox`) return json({ data: [] })
      if (url.pathname === `/api/session/${session.id}/message`) return json({ data: [], cursor: {} })
      if (url.pathname === `/api/experimental/session/${session.id}/log`)
        return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    },
  })

  try {
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("Tools"))
    const tools = setup
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => line.includes("Tools"))
    if (tools === -1) throw new Error(`DevTools Tools action was not rendered: ${setup.captureCharFrame()}`)
    await setup.mockMouse.click(setup.captureCharFrame().split("\n")[tools]!.indexOf("Tools") + 1, tools)
    await setup.waitForFrame((frame) => frame.includes("Write debug snapshot"))
    const row = setup
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => line.includes("Write debug snapshot"))
    if (row === -1) throw new Error(`DevTools snapshot action was not rendered: ${setup.captureCharFrame()}`)
    await setup.mockMouse.click(setup.captureCharFrame().split("\n")[row]!.indexOf("Write debug snapshot") + 1, row)
    await setup.waitForFrame((frame) => frame.includes("opencode-debug-"))
    const frame = setup.captureCharFrame().split("\n")
    const first = frame.findIndex((line) => line.includes("opencode-debug-"))
    const column = frame[first]?.indexOf(path.join(temporaryDirectory, "opencode-debug-"))
    file =
      column === undefined || column < 0 || !frame[first + 1]
        ? undefined
        : `${frame[first]!.slice(column).trim()}${frame[first + 1]!.slice(column).trim()}`
    if (
      !file?.match(
        new RegExp(
          `^${path.join(temporaryDirectory, "opencode-debug-").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\w-]+\\.json$`,
        ),
      )
    )
      throw new Error(`Debug snapshot path was not rendered: ${setup.captureCharFrame()}`)
    return JSON.parse(await Bun.file(file).text()) as { events: { type: string }[] }
  } finally {
    const candidates = file
      ? [file]
      : (await readdir(physicalTemporaryDirectory))
          .filter((name) => !initialFiles.has(name) && /^opencode-debug-[\w-]+\.json$/.test(name))
          .map((name) => path.join(physicalTemporaryDirectory, name))
    await Promise.all(
      candidates.map(async (candidate) => {
        const metadata = await lstat(candidate)
        if (metadata.isSymbolicLink() || !metadata.isFile()) return
        if (
          path.dirname(candidate) !== physicalTemporaryDirectory ||
          (await realpath(path.dirname(candidate))) !== physicalTemporaryDirectory
        )
          return
        await unlink(candidate)
      }),
    )
  }
}

test("falls back to existing history when the session log ends with a terminal refusal", async () => {
  const snapshot = await dump(refusal)

  expect(
    snapshot.events.map((event) => event.type),
    "terminal refusal must return the existing fallback history",
  ).toContain("client.connection")
  expect(
    snapshot.events.map((event) => event.type),
    "partial history must not be accepted as a synchronized dump",
  ).not.toContain("session.agent.selected")
  expect(
    snapshot.events.map((event) => event.type),
    "terminal refusal must not enter durable debug history",
  ).not.toContain("log.error")
  expect(
    snapshot.events.map((event) => event.type),
    "terminal refusal must not be mistaken for synchronization",
  ).not.toContain("log.synced")
})

test("dumps durable session log items when a synced marker ends the stream", async () => {
  const snapshot = await dump(synced)

  expect(snapshot.events.map((event) => event.type)).toContain("session.model.selected")
  expect(snapshot.events.map((event) => event.type)).not.toContain("log.synced")
})
