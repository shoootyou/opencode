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
import { lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises"
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

async function dump(stream: string, temporaryParent = tmpdir()) {
  const temporaryDirectory = await mkdtemp(path.join(temporaryParent, "opencode-devtools-refusal-"))
  const physicalTemporaryDirectory = await realpath(temporaryDirectory)
  const metadata = await lstat(temporaryDirectory)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("Expected an owned temporary directory")
  const previousTemporaryDirectory = process.env.TMPDIR
  process.env.TMPDIR = physicalTemporaryDirectory

  try {
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
    const snapshots = (await readdir(physicalTemporaryDirectory)).filter((name) =>
      /^opencode-debug-[\w-]+\.json$/.test(name),
    )
    if (snapshots.length !== 1) throw new Error(`Expected one owned debug snapshot: ${setup.captureCharFrame()}`)
    return JSON.parse(await Bun.file(path.join(physicalTemporaryDirectory, snapshots[0]!)).text()) as {
      events: { type: string }[]
    }
  } finally {
    if (previousTemporaryDirectory === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTemporaryDirectory
    if ((await realpath(temporaryDirectory)) !== physicalTemporaryDirectory)
      throw new Error("Temporary directory escaped")
    await rm(physicalTemporaryDirectory, { recursive: true, force: true })
  }
}

const temporaryParents = [
  ["default", undefined],
  ["long", path.join(import.meta.dir, "../.debug")],
] as const

test.each(temporaryParents)(
  "falls back to existing history when the session log ends with a terminal refusal (%s TMPDIR)",
  async (_, temporaryParent) => {
    const snapshot = await dump(refusal, temporaryParent)

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
  },
)

test.each(temporaryParents)(
  "dumps durable session log items when a synced marker ends the stream (%s TMPDIR)",
  async (_, temporaryParent) => {
    const snapshot = await dump(synced, temporaryParent)

    expect(snapshot.events.map((event) => event.type)).toContain("session.model.selected")
    expect(snapshot.events.map((event) => event.type)).not.toContain("log.synced")
  },
)
