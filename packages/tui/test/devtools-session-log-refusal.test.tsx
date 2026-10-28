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
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises"
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

const temporaryVariables = ["TMPDIR", "TEMP", "TMP"] as const

async function ensureLongTemporaryParent(temporaryParent: string) {
  const existing = await lstat(temporaryParent).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return
    throw error
  })
  if (existing?.isSymbolicLink()) throw new Error("DevTools long temporary parent must not be a symlink")
  await mkdir(temporaryParent, { recursive: true, mode: 0o700 })
  await chmod(temporaryParent, 0o700)
  const [physicalTemporaryParent, physicalPackageRoot, metadata] = await Promise.all([
    realpath(temporaryParent),
    realpath(path.dirname(import.meta.dir)),
    lstat(temporaryParent),
  ])
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    !physicalTemporaryParent.startsWith(`${physicalPackageRoot}${path.sep}`) ||
    (metadata.mode & 0o777) !== 0o700
  )
    throw new Error("DevTools long temporary parent escaped the TUI package")
  return physicalTemporaryParent
}

function temporaryEnvironment() {
  return Object.fromEntries(temporaryVariables.map((key) => [key, process.env[key]]))
}

async function dump(stream: string, temporaryParent = tmpdir(), long = false) {
  let temporaryDirectory: string | undefined
  let physicalTemporaryDirectory: string | undefined
  let physicalTemporaryParent: string | undefined
  let previousTemporaryEnvironment: Record<string, string | undefined> | undefined

  try {
    physicalTemporaryParent = long ? await ensureLongTemporaryParent(temporaryParent) : await realpath(temporaryParent)
    temporaryDirectory = await mkdtemp(path.join(physicalTemporaryParent, "opencode-devtools-refusal-"))
    await chmod(temporaryDirectory, 0o700)
    physicalTemporaryDirectory = await realpath(temporaryDirectory)
    const metadata = await lstat(temporaryDirectory)
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      !physicalTemporaryDirectory.startsWith(`${physicalTemporaryParent}${path.sep}`) ||
      (metadata.mode & 0o777) !== 0o700
    )
      throw new Error("Expected an owned private temporary directory")
    previousTemporaryEnvironment = temporaryEnvironment()
    temporaryVariables.forEach((key) => (process.env[key] = physicalTemporaryDirectory!))
    expect(temporaryEnvironment()).toEqual(
      Object.fromEntries(temporaryVariables.map((key) => [key, physicalTemporaryDirectory])),
    )
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
    const environment = previousTemporaryEnvironment
    if (environment)
      temporaryVariables.forEach((key) => {
        const value = environment[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
    if (temporaryDirectory && physicalTemporaryDirectory && physicalTemporaryParent) {
      const [physicalRoot, metadata] = await Promise.all([realpath(temporaryDirectory), lstat(temporaryDirectory)])
      if (
        metadata.isSymbolicLink() ||
        !metadata.isDirectory() ||
        path.basename(temporaryDirectory).startsWith("opencode-devtools-refusal-") === false ||
        !physicalRoot.startsWith(`${physicalTemporaryParent}${path.sep}`) ||
        (metadata.mode & 0o777) !== 0o700
      )
        throw new Error("Refusing to remove an unproven DevTools temporary directory")
      await rm(physicalRoot, { recursive: true, force: true })
    }
  }
}

const temporaryParents = [
  ["default", undefined, false],
  ["long", path.join(import.meta.dir, "../.debug"), true],
] as const

test.each(temporaryParents)(
  "falls back to existing history when the session log ends with a terminal refusal (%s TMPDIR)",
  async (_, temporaryParent, long) => {
    const environment = temporaryEnvironment()
    const snapshot = await dump(refusal, temporaryParent, long)
    expect(temporaryEnvironment()).toEqual(environment)

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
  async (_, temporaryParent, long) => {
    const environment = temporaryEnvironment()
    const snapshot = await dump(synced, temporaryParent, long)
    expect(temporaryEnvironment()).toEqual(environment)

    expect(snapshot.events.map((event) => event.type)).toContain("session.model.selected")
    expect(snapshot.events.map((event) => event.type)).not.toContain("log.synced")
  },
)
