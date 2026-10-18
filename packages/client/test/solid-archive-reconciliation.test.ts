/**
 * @spec-handoff
 * @interface createData(input: CreateDataInput): Data
 * @behavior
 *   - session.archive.changed follows the upstream session.renamed metadata-event pattern.
 *   - It syncs metadata, joins a same-ID pending family read, then patches only time.archived.
 *   - Connection events do not sweep remembered session metadata.
 * @edge-cases
 *   - Epoch zero remains archived; null removes only time.archived.
 *   - A live archive event for an unknown ID is not silently dropped.
 */
import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData, type CreateDataInput } from "../src/solid"
import { OpenCode, type OpenCodeEvent, type SessionInfo } from "../src/promise"

const session = (id: string, archived?: number): SessionInfo => ({
  id,
  projectID: "project",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 3, updated: 9, ...(archived === undefined ? {} : { archived }) },
  location: { directory: "/project" },
})

function fixture(fetch: Parameters<typeof OpenCode.make>[0]["fetch"]) {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const api = OpenCode.make({ baseUrl: "http://opencode.local", fetch })
  return createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
    }),
    emit(event: OpenCodeEvent) {
      listeners.forEach((listener) => listener({ name: event.type, details: event }))
    },
    dispose,
  }))
}

function archiveEvent(sessionID: string, archived: number | null): OpenCodeEvent {
  return {
    id: `evt_${sessionID}_${archived}`,
    created: 1,
    type: "session.archive.changed",
    durable: { aggregateID: sessionID, seq: 1, version: 1 },
    data: { sessionID, archived },
  }
}

async function wait(check: () => boolean) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > 2_000) throw new Error("Timed out waiting for condition")
    await Bun.sleep(5)
  }
}

test("applies archive zero after ordinary and pending-family hydration without overwriting other time fields", async () => {
  const familyRead = Promise.withResolvers<Response>()
  let reads = 0
  const setup = fixture(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    if (!request.url.endsWith("/api/session/ses_root")) return Response.json({ data: [], cursor: {} })
    reads++
    if (reads === 1) return familyRead.promise
    return Response.json({ data: session("ses_root", 17) })
  })
  try {
    setup.data.session.remember(session("ses_root", 4))
    const pendingFamily = setup.data.session.sync("ses_root", { children: true })
    await wait(() => reads === 1)
    setup.emit(archiveEvent("ses_root", 0))
    familyRead.resolve(Response.json({ data: session("ses_root", 17) }))
    await pendingFamily
    await wait(() => setup.data.session.get("ses_root")?.time.archived === 0)
    expect(setup.data.session.get("ses_root")?.time).toEqual({ created: 3, updated: 9, archived: 0 })
  } finally {
    familyRead.resolve(Response.json({ data: session("ses_root", 17) }))
    setup.dispose()
  }
})

test("clears only archive metadata for a restore event after canonical hydration", async () => {
  const setup = fixture(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    if (!request.url.endsWith("/api/session/ses_restore")) return Response.json({ data: [], cursor: {} })
    return Response.json({ data: session("ses_restore", 12) })
  })
  try {
    setup.data.session.remember(session("ses_restore", 4))
    setup.emit(archiveEvent("ses_restore", null))
    await wait(() => setup.data.session.get("ses_restore")?.time.archived === undefined)
    expect(setup.data.session.get("ses_restore")?.time).toEqual({ created: 3, updated: 9 })
  } finally {
    setup.dispose()
  }
})

test("does not silently drop a live archive event for an unknown session", async () => {
  let reads = 0
  const setup = fixture(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    if (!request.url.endsWith("/api/session/ses_unknown")) return Response.json({ data: [], cursor: {} })
    reads++
    return Response.json({ data: session("ses_unknown", 7) })
  })
  try {
    setup.emit(archiveEvent("ses_unknown", 0))
    await wait(() => reads === 1 && setup.data.session.get("ses_unknown")?.time.archived === 0)
  } finally {
    setup.dispose()
  }
})

test("does not discard an unrelated session sync when an archive event arrives", async () => {
  const delayedB = Promise.withResolvers<Response>()
  const setup = fixture(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    if (request.url.endsWith("/api/session/ses_b")) return delayedB.promise
    if (request.url.endsWith("/api/session/ses_a")) return Response.json({ data: session("ses_a", 17) })
    return Response.json({ data: [], cursor: {} })
  })
  try {
    setup.data.session.remember(session("ses_a"))
    const syncingB = setup.data.session.sync("ses_b")
    setup.emit(archiveEvent("ses_a", 0))
    delayedB.resolve(Response.json({ data: session("ses_b") }))
    await syncingB
    await wait(() => setup.data.session.get("ses_b")?.id === "ses_b")
    expect(setup.data.session.get("ses_a")?.time.archived).toBe(0)
  } finally {
    delayedB.resolve(Response.json({ data: session("ses_b") }))
    setup.dispose()
  }
})

test("does not sweep remembered metadata on the second server.connected event", async () => {
  let sessionReads = 0
  let activeReads = 0
  const setup = fixture(async (input, init) => {
    const pathname = new URL((input instanceof Request ? input : new Request(input, init)).url).pathname
    if (pathname === "/api/session/ses_remembered") sessionReads++
    if (pathname === "/api/session/active") {
      activeReads++
      return Response.json({ data: {} })
    }
    if (pathname === "/api/location") return Response.json({ directory: "/project" })
    if (pathname === "/api/project") return Response.json([])
    if (pathname === "/api/vcs") return Response.json({ location: { directory: "/project" }, data: {} })
    return Response.json({ data: session("ses_remembered") })
  })
  try {
    setup.data.session.remember(session("ses_remembered"))
    activeReads = 0
    setup.emit({ id: "evt_connected_1", created: 1, type: "server.connected", data: {} })
    await wait(() => activeReads === 1)
    activeReads = 0
    setup.emit({ id: "evt_connected_2", created: 2, type: "server.connected", data: {} })
    await wait(() => activeReads === 1)
    expect(sessionReads).toBe(0)
  } finally {
    setup.dispose()
  }
})
