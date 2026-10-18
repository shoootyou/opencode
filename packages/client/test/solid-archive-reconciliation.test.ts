/**
 * @spec-handoff
 * @interface createData(input: CreateDataInput): Data
 * @behavior
 *   - Archive events replace stale ordinary and family metadata reads through canonical hydration.
 *   - Deletion and reconnect 404s remove remembered metadata; unknown archive events do not populate the cache.
 *   - Reconnect reconciliation coalesces work and limits metadata-read concurrency.
 * @edge-cases
 *   - Epoch zero is archived and may not be overwritten by an older family response.
 *   - A deleted session cannot be recreated by an in-flight archive hydration.
 */
import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { createData, type CreateDataInput } from "../src/solid"
import { OpenCode, type OpenCodeEvent, type SessionInfo } from "../src/promise"

const session = (id: string, archived?: number): SessionInfo => ({
  id,
  projectID: "project",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0, ...(archived === undefined ? {} : { archived }) },
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

test("does not let a delayed family snapshot overwrite archive hydration", async () => {
  const oldFamily = Promise.withResolvers<Response>()
  let reads = 0
  const setup = fixture(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    if (!request.url.endsWith("/api/session/ses_root")) return Response.json({ data: [], cursor: {} })
    reads++
    if (reads === 1) return oldFamily.promise
    return Response.json({ data: session("ses_root", 0) })
  })
  try {
    setup.data.session.remember(session("ses_root"))
    const family = setup.data.session.sync("ses_root", { children: true })
    await wait(() => reads === 1)
    setup.emit(archiveEvent("ses_root", 0))
    await wait(() => reads === 2 && setup.data.session.get("ses_root")?.time.archived === 0)
    oldFamily.resolve(Response.json({ data: session("ses_root") }))
    await family
    expect(setup.data.session.get("ses_root")?.time.archived).toBe(0)
  } finally {
    oldFamily.resolve(Response.json({ data: session("ses_root") }))
    setup.dispose()
  }
})

test("does not resurrect a deleted session when archive hydration completes late", async () => {
  const delayed = Promise.withResolvers<Response>()
  let reads = 0
  const setup = fixture(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    if (!request.url.endsWith("/api/session/ses_deleted")) return Response.json({ data: [], cursor: {} })
    reads++
    return delayed.promise
  })
  try {
    setup.data.session.remember(session("ses_deleted"))
    setup.emit(archiveEvent("ses_deleted", 0))
    await wait(() => reads === 1)
    setup.emit({ id: "evt_deleted", created: 2, type: "session.deleted", data: { sessionID: "ses_deleted" } })
    delayed.resolve(Response.json({ data: session("ses_deleted", 0) }))
    await wait(() => reads === 1)
    await Bun.sleep(0)
    expect(setup.data.session.get("ses_deleted")).toBeUndefined()
  } finally {
    delayed.resolve(Response.json({ data: session("ses_deleted", 0) }))
    setup.dispose()
  }
})

test("evicts a remembered session when reconnect reconciliation receives 404", async () => {
  const errors: unknown[] = []
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const [connection, setConnection] = createStore<{ status: "connected" | "reconnecting" }>({ status: "connected" })
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const pathname = new URL((input instanceof Request ? input : new Request(input, init)).url).pathname
      if (pathname === "/api/session/ses_missing")
        return Response.json(
          {
            _tag: "SessionNotFoundError",
            sessionID: "ses_missing",
            message: "Session not found: ses_missing",
          },
          { status: 404 },
        )
      if (pathname === "/api/session/active") return Response.json({ data: {} })
      if (pathname === "/api/location") return Response.json({ directory: "/project" })
      if (pathname === "/api/project") return Response.json([])
      if (pathname === "/api/vcs") return Response.json({ location: { directory: "/project" }, data: {} })
      throw new Error(`Unexpected request: ${pathname}`)
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: { on: () => () => {}, listen: (handler) => (listeners.add(handler), () => listeners.delete(handler)) },
      connection: { status: () => connection.status },
      onError: (error) => errors.push(error),
    }),
    dispose,
  }))
  try {
    await Bun.sleep(0)
    setup.data.session.remember(session("ses_missing"))
    listeners.forEach((listener) => listener({ name: "server.connected", details: { type: "server.connected", data: {} } }))
    await Bun.sleep(0)
    setConnection("status", "reconnecting")
    await Bun.sleep(0)
    setConnection("status", "connected")
    listeners.forEach((listener) => listener({ name: "server.connected", details: { type: "server.connected", data: {} } }))
    await wait(() => setup.data.session.get("ses_missing") === undefined)
    expect(errors).toEqual([])
    expect(setup.data.session.get("ses_missing")).toBeUndefined()
  } finally {
    setup.dispose()
  }
})

test("keeps remembered metadata when reconnect reconciliation receives a non-not-found protocol error", async () => {
  const errors: unknown[] = []
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const [connection, setConnection] = createStore<{ status: "connected" | "reconnecting" }>({ status: "connected" })
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const pathname = new URL((input instanceof Request ? input : new Request(input, init)).url).pathname
      if (pathname === "/api/session/ses_server_failure")
        return Response.json({ _tag: "UnknownError", message: "internal failure" }, { status: 500 })
      if (pathname === "/api/session/active") return Response.json({ data: {} })
      if (pathname === "/api/location") return Response.json({ directory: "/project" })
      if (pathname === "/api/project") return Response.json([])
      if (pathname === "/api/vcs") return Response.json({ location: { directory: "/project" }, data: {} })
      throw new Error(`Unexpected request: ${pathname}`)
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: { on: () => () => {}, listen: (handler) => (listeners.add(handler), () => listeners.delete(handler)) },
      connection: { status: () => connection.status },
      onError: (error) => errors.push(error),
    }),
    dispose,
  }))
  try {
    await Bun.sleep(0)
    setup.data.session.remember(session("ses_server_failure"))
    listeners.forEach((listener) => listener({ name: "server.connected", details: { type: "server.connected", data: {} } }))
    await Bun.sleep(0)
    setConnection("status", "reconnecting")
    await Bun.sleep(0)
    setConnection("status", "connected")
    listeners.forEach((listener) => listener({ name: "server.connected", details: { type: "server.connected", data: {} } }))
    await wait(() => errors.length === 1)
    expect(setup.data.session.get("ses_server_failure")).toMatchObject({ id: "ses_server_failure" })
  } finally {
    setup.dispose()
  }
})

test("ignores archive events for unknown sessions without retaining IDs or fetching metadata", async () => {
  let requests = 0
  const setup = fixture(async () => {
    requests++
    return Response.json({ data: session("ses_unknown", 0) })
  })
  try {
    setup.emit(archiveEvent("ses_unknown", 0))
    setup.emit(archiveEvent("ses_unknown", null))
    await Bun.sleep(20)
    expect(requests).toBe(0)
    expect(setup.data.session.get("ses_unknown")).toBeUndefined()
  } finally {
    setup.dispose()
  }
})

test("does not reconcile remembered session metadata on the initial connection", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const [connection] = createSignal<"connected">("connected")
  let sessionReads = 0
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const pathname = new URL((input instanceof Request ? input : new Request(input, init)).url).pathname
      if (pathname === "/api/session/ses_initial") {
        sessionReads++
        return Response.json({ data: session("ses_initial") })
      }
      if (pathname === "/api/session/active") return Response.json({ data: {} })
      if (pathname === "/api/location") return Response.json({ directory: "/project" })
      if (pathname === "/api/project") return Response.json([])
      return Response.json({ location: { directory: "/project" }, data: {} })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      connection: { status: connection },
      event: { on: () => () => {}, listen: (handler) => (listeners.add(handler), () => listeners.delete(handler)) },
    }),
    dispose,
  }))
  try {
    setup.data.session.remember(session("ses_initial"))
    listeners.forEach((listener) => listener({ name: "server.connected", details: { type: "server.connected", data: {} } }))
    await Bun.sleep(20)
    expect(sessionReads).toBe(0)
  } finally {
    setup.dispose()
  }
})

test("bounds concurrent reconnect metadata reads under a flapping connection", async () => {
  const reads: PromiseWithResolvers<Response>[] = []
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const [connection, setConnection] = createStore<{ status: "connected" | "reconnecting" }>({ status: "connected" })
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: (input, init) => {
      const pathname = new URL((input instanceof Request ? input : new Request(input, init)).url).pathname
      if (pathname.startsWith("/api/session/ses_")) {
        const deferred = Promise.withResolvers<Response>()
        reads.push(deferred)
        return deferred.promise
      }
      if (pathname === "/api/session/active") return Promise.resolve(Response.json({ data: {} }))
      if (pathname === "/api/location") return Promise.resolve(Response.json({ directory: "/project" }))
      if (pathname === "/api/project") return Promise.resolve(Response.json([]))
      return Promise.resolve(Response.json({ location: { directory: "/project" }, data: {} }))
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      connection: { status: () => connection.status },
      event: { on: () => () => {}, listen: (handler) => (listeners.add(handler), () => listeners.delete(handler)) },
    }),
    dispose,
  }))
  try {
    await Bun.sleep(0)
    for (let index = 0; index < 5; index++) setup.data.session.remember(session(`ses_${index}`))
    listeners.forEach((listener) => listener({ name: "server.connected", details: { type: "server.connected", data: {} } }))
    await Bun.sleep(0)
    setConnection("status", "reconnecting")
    await Bun.sleep(0)
    setConnection("status", "connected")
    listeners.forEach((listener) => listener({ name: "server.connected", details: { type: "server.connected", data: {} } }))
    setConnection("status", "reconnecting")
    await Bun.sleep(0)
    setConnection("status", "connected")
    listeners.forEach((listener) => listener({ name: "server.connected", details: { type: "server.connected", data: {} } }))
    await Bun.sleep(20)
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.length).toBeLessThanOrEqual(4)
  } finally {
    reads.forEach((read) => read.resolve(Response.json({ data: session("ses_0") })))
    setup.dispose()
  }
})
