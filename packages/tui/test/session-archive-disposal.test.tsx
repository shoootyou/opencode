/**
 * @spec-handoff
 * @interface DialogSessionList(): JSX.Element
 * @behavior
 *   - Unmounting aborts owner-scoped archive PATCH and archived-pagination requests.
 *   - A disposed dialog does not refetch or publish after PATCH or shared canonical sync settles.
 *   - Restoring an archived row sends archived:false, awaits canonical refresh, then refetches the list.
 * @edge-cases
 *   - Shared createData sync may finish after unmount because it deliberately has no abort signal.
 *   - Archived visibility uses one archived:true request rather than automatic cursor pagination.
 * @see ../src/component/dialog-session-list.tsx
 */
/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { DialogSessionList } from "../src/component/dialog-session-list"
import { ConfigProvider } from "../src/config"
import { ArgsProvider } from "../src/context/args"
import { ClientProvider } from "../src/context/client"
import { DataProvider } from "../src/context/data"
import { Keymap } from "../src/context/keymap"
import { LocalProvider } from "../src/context/local"
import { LocationProvider } from "../src/context/location"
import { PermissionProvider } from "../src/context/permission"
import { RouteProvider } from "../src/context/route"
import { TuiAppProvider } from "../src/context/runtime"
import { SessionTabsProvider } from "../src/context/session-tabs"
import { StorageProvider, useStorage } from "../src/context/storage"
import { ThemeProvider } from "../src/context/theme"
import { Dialog, DialogProvider } from "../src/ui/dialog"
import { ToastProvider } from "../src/ui/toast"
import { createApi, createEventStream, createFetch, json } from "./fixture/tui-client"
import { emptyThemeSource, tmpdir } from "./fixture/fixture"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

type Phase = "initial-list" | "dialog-refetch" | "patch" | "canonical-sync" | "pagination" | "other"
type TrackedRequest = { id: number; method: string; url: URL; phase: Phase; signal: AbortSignal; body: Promise<string> }

const active = {
  id: "ses_active",
  projectID: "proj_fixture",
  title: "Active root",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  location: { directory: process.cwd() },
}

function phase(url: URL, request: Request, listCount: number): Phase {
  if (url.pathname === "/api/session/ses_active") return request.method === "PATCH" ? "patch" : "canonical-sync"
  if (url.pathname === "/api/session" && url.searchParams.get("cursor")) return "pagination"
  if (url.pathname === "/api/session") return listCount === 0 ? "initial-list" : "dialog-refetch"
  return "other"
}

async function stableDrain(pending: Set<number>) {
  let stable = 0
  for (let pass = 0; pass < 100; pass++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    await Promise.resolve()
    if (pending.size === 0) {
      stable++
      if (stable === 2) return
      continue
    }
    stable = 0
  }
  throw new Error(`requests did not drain: ${[...pending].join(", ")}`)
}

async function mount(input: {
  respond(request: TrackedRequest): Response | Promise<Response | undefined> | undefined
  keybinds?: Record<string, string>
}) {
  const events = createEventStream()
  const pending = new Set<number>()
  const requests: TrackedRequest[] = []
  let nextID = 0
  let listCount = 0
  const calls = createFetch(async (url, request) => {
    const requestPhase = phase(url, request, listCount)
    if (url.pathname === "/api/session") listCount++
    const tracked = {
      id: ++nextID,
      method: request.method,
      url,
      phase: requestPhase,
      signal: request.signal,
      body: request.clone().text(),
    }
    requests.push(tracked)
    pending.add(tracked.id)
    try {
      return await input.respond(tracked)
    } finally {
      pending.delete(tracked.id)
    }
  }, events)
  const temporary = await tmpdir()
  let storage!: ReturnType<typeof useStorage>
  let dispatch!: (id: string) => void
  const [mounted, setMounted] = createSignal(true)

  function Harness() {
    storage = useStorage()
    const keymap = Keymap.use()
    dispatch = keymap.dispatch
    onMount(() => onCleanup(keymap.mode.push("modal")))
    return (
      <Show when={mounted()}>
        <Dialog onClose={() => {}}>
          <DialogSessionList />
        </Dialog>
      </Show>
    )
  }

  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state: temporary.path }}>
        <TuiAppProvider value={{ name: "test", version: "test", channel: "test" }}>
          <StorageProvider>
            <ArgsProvider>
              <ConfigProvider config={createTuiResolvedConfig({ keybinds: input.keybinds })}>
                <Keymap.Provider>
                  <ToastProvider>
                    <RouteProvider>
                      <ClientProvider api={createApi(calls.fetch)}>
                        <PermissionProvider>
                          <DataProvider directory={process.cwd()}>
                            <LocationProvider>
                              <SessionTabsProvider>
                                <ThemeProvider mode="dark" source={emptyThemeSource}>
                                  <LocalProvider>
                                    <DialogProvider>
                                      <Harness />
                                    </DialogProvider>
                                  </LocalProvider>
                                </ThemeProvider>
                              </SessionTabsProvider>
                            </LocationProvider>
                          </DataProvider>
                        </PermissionProvider>
                      </ClientProvider>
                    </RouteProvider>
                  </ToastProvider>
                </Keymap.Provider>
              </ConfigProvider>
            </ArgsProvider>
          </StorageProvider>
        </TuiAppProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  )
  app.renderer.start()
  return {
    app,
    dispatch: (id: string) => dispatch(id),
    pending,
    requests,
    unmount: () => setMounted(false),
    async dispose() {
      app.renderer.destroy()
      await storage.flush()
      await temporary[Symbol.asyncDispose]()
    },
  }
}

test.serial("unmounting during archive PATCH aborts it and blocks a later dialog refetch", async () => {
  const patch = Promise.withResolvers<Response>()
  const setup = await mount({
    respond(request) {
      if (request.url.pathname === "/api/location")
        return json({
          directory: process.cwd(),
          project: { id: "proj_fixture", directory: process.cwd(), canonical: process.cwd() },
        })
      if (request.phase === "initial-list") return json({ data: [active], cursor: {} })
      if (request.phase === "patch") return patch.promise
      return undefined
    },
  })
  try {
    await setup.app.waitFor(() => setup.requests.some((request) => request.phase === "initial-list"), {
      maxPasses: 100,
    })
    await stableDrain(setup.pending)
    await setup.app.waitForFrame((frame) => frame.includes("Active root"), { maxPasses: 100 })
    setup.dispatch("session.archive.toggle")
    await setup.app.waitFor(() => setup.requests.some((request) => request.phase === "patch"))
    const inFlight = setup.requests.find((request) => request.phase === "patch")!
    setup.unmount()
    expect(inFlight.signal.aborted).toBe(true)
    patch.resolve(new Response(null, { status: 204 }))
    await stableDrain(setup.pending)
    expect(setup.requests.filter((request) => request.phase === "dialog-refetch")).toEqual([])
  } finally {
    await setup.dispose()
  }
})

test.serial("a shared canonical sync may drain after unmount but cannot refetch the disposed dialog", async () => {
  const canonical = Promise.withResolvers<Response>()
  const setup = await mount({
    respond(request) {
      if (request.url.pathname === "/api/location")
        return json({
          directory: process.cwd(),
          project: { id: "proj_fixture", directory: process.cwd(), canonical: process.cwd() },
        })
      if (request.phase === "initial-list") return json({ data: [active], cursor: {} })
      if (request.phase === "patch") return new Response(null, { status: 204 })
      if (request.phase === "canonical-sync") return canonical.promise
      return undefined
    },
  })
  try {
    await setup.app.waitFor(() => setup.requests.some((request) => request.phase === "initial-list"), {
      maxPasses: 100,
    })
    await stableDrain(setup.pending)
    await setup.app.waitForFrame((frame) => frame.includes("Active root"), { maxPasses: 100 })
    setup.dispatch("session.archive.toggle")
    await setup.app.waitFor(() => setup.requests.some((request) => request.phase === "canonical-sync"))
    setup.unmount()
    canonical.resolve(json({ data: active }))
    await stableDrain(setup.pending)
    expect(setup.requests.filter((request) => request.phase === "dialog-refetch")).toEqual([])
  } finally {
    await setup.dispose()
  }
})

test.serial("archived visibility makes one archived-only request without following its cursor", async () => {
  const setup = await mount({
    keybinds: { "session.archived.toggle_visibility": "ctrl+v" },
    respond(request) {
      if (request.url.pathname === "/api/location")
        return json({
          directory: process.cwd(),
          project: { id: "proj_fixture", directory: process.cwd(), canonical: process.cwd() },
        })
      if (request.phase === "initial-list") return json({ data: [], cursor: {} })
      if (request.url.pathname === "/api/session" && request.url.searchParams.get("archived"))
        return json({ data: [], cursor: { next: "older" } })
      return undefined
    },
  })
  try {
    await setup.app.waitFor(() => setup.requests.some((request) => request.phase === "initial-list"), {
      maxPasses: 100,
    })
    await stableDrain(setup.pending)
    await setup.app.waitForFrame((frame) => frame.includes("No sessions available"), { maxPasses: 100 })
    setup.dispatch("session.archived.toggle_visibility")
    await setup.app.waitFor(() => setup.requests.some((request) => request.url.searchParams.get("archived")))
    await stableDrain(setup.pending)
    expect(setup.requests.filter((request) => request.url.searchParams.get("archived") === "true")).toHaveLength(1)
    expect(setup.requests.filter((request) => request.phase === "pagination")).toEqual([])
  } finally {
    await setup.dispose()
  }
})

test.serial("selected archived row sends null, awaits sync, then refetches with pending released", async () => {
  const sync = Promise.withResolvers<Response>()
  const archived = { ...active, id: "ses_archived", title: "Archived root", time: { ...active.time, archived: 0 } }
  let archivedPageRequests = 0
  const setup = await mount({
    keybinds: { "session.archived.toggle_visibility": "ctrl+v" },
    respond: async (request) => {
      if (request.url.pathname === "/api/location")
        return json({
          directory: process.cwd(),
          project: { id: "proj_fixture", directory: process.cwd(), canonical: process.cwd() },
        })
      if (request.phase === "initial-list") return json({ data: [archived], cursor: {} })
      if (request.url.pathname === "/api/session" && request.url.searchParams.get("archived")) {
        archivedPageRequests++
        return json({ data: archivedPageRequests === 1 ? [archived] : [active], cursor: {} })
      }
      if (request.url.pathname === "/api/session/ses_archived" && request.method === "PATCH")
        return new Response(null, { status: 204 })
      if (request.url.pathname === "/api/session/ses_archived") return sync.promise
      if (request.phase === "dialog-refetch") return json({ data: [active], cursor: {} })
      return undefined
    },
  })
  try {
    await setup.app.waitForFrame((frame) => frame.includes("No sessions available"), { maxPasses: 100 })
    setup.dispatch("session.archived.toggle_visibility")
    await setup.app.waitForFrame((frame) => frame.includes("Archived root"), { maxPasses: 100 })
    setup.dispatch("session.archive.toggle")
    await setup.app.waitFor(() =>
      setup.requests.some(
        (request) => request.url.pathname === "/api/session/ses_archived" && request.method === "PATCH",
      ),
    )
    const patch = setup.requests.find(
      (request) => request.url.pathname === "/api/session/ses_archived" && request.method === "PATCH",
    )!
    expect(JSON.parse(await patch.body)).toEqual({ archived: false })
    await setup.app.waitFor(() =>
      setup.requests.some(
        (request) => request.url.pathname === "/api/session/ses_archived" && request.method === "GET",
      ),
    )
    expect(setup.requests.filter((request) => request.url.searchParams.get("archived") === "true")).toHaveLength(1)
    sync.resolve(json({ data: active }))
    await setup.app.waitFor(
      () => setup.requests.filter((request) => request.url.searchParams.get("archived") === "true").length === 2,
    )
    await stableDrain(setup.pending)
    await setup.app.waitForFrame((frame) => !frame.includes("Archived root"), { maxPasses: 100 })
    setup.dispatch("session.archived.toggle_visibility")
    await setup.app.waitForFrame((frame) => frame.includes("Active root"), { maxPasses: 100 })
    setup.dispatch("session.archive.toggle")
    await setup.app.waitFor(
      () =>
        setup.requests.filter(
          (request) => request.url.pathname === "/api/session/ses_active" && request.method === "PATCH",
        ).length === 1,
    )
  } finally {
    await setup.dispose()
  }
})

test.serial("selected archive sends one native PATCH, awaits sync, then refetches the archived row", async () => {
  const patch = Promise.withResolvers<Response>()
  const sync = Promise.withResolvers<Response>()
  let archived: number | undefined
  const setup = await mount({
    respond: async (request) => {
      if (request.url.pathname === "/api/location")
        return json({
          directory: process.cwd(),
          project: { id: "proj_fixture", directory: process.cwd(), canonical: process.cwd() },
        })
      if (request.phase === "initial-list") return json({ data: [active], cursor: {} })
      if (request.phase === "patch") {
        return patch.promise
      }
      if (request.phase === "canonical-sync") return sync.promise
      if (request.phase === "dialog-refetch")
        return json({ data: [{ ...active, time: { ...active.time, archived } }], cursor: {} })
      return undefined
    },
  })
  try {
    await setup.app.waitForFrame((frame) => frame.includes("Active root"), { maxPasses: 100 })
    setup.dispatch("session.archive.toggle")
    setup.dispatch("session.archive.toggle")
    await setup.app.waitFor(() => setup.requests.filter((request) => request.phase === "patch").length === 1)
    const patchRequest = setup.requests.find((request) => request.phase === "patch")!
    expect(setup.requests.filter((request) => request.phase === "patch")).toHaveLength(1)
    expect(JSON.parse(await patchRequest.body)).toEqual({ archived: true })
    patch.resolve(new Response(null, { status: 204 }))
    await setup.app.waitFor(() => setup.requests.some((request) => request.phase === "canonical-sync"))
    expect(setup.requests.some((request) => request.phase === "dialog-refetch")).toBe(false)
    archived = Date.now()
    sync.resolve(json({ data: { ...active, time: { ...active.time, archived } } }))
    await setup.app.waitFor(() => setup.requests.some((request) => request.phase === "dialog-refetch"))
    const trace = setup.requests.map((request) => request.phase)
    expect(trace.indexOf("canonical-sync")).toBeLessThan(trace.indexOf("dialog-refetch"))
  } finally {
    await stableDrain(setup.pending)
    await setup.dispose()
  }
})

test.serial("failed selected archive keeps the row and skips refetch", async () => {
  const setup = await mount({
    respond(request) {
      if (request.url.pathname === "/api/location")
        return json({
          directory: process.cwd(),
          project: { id: "proj_fixture", directory: process.cwd(), canonical: process.cwd() },
        })
      if (request.phase === "initial-list") return json({ data: [active], cursor: {} })
      if (request.phase === "patch") return new Response(null, { status: 500 })
      return undefined
    },
  })
  try {
    await setup.app.waitForFrame((frame) => frame.includes("Active root"), { maxPasses: 100 })
    setup.dispatch("session.archive.toggle")
    await stableDrain(setup.pending)
    expect(setup.requests.filter((request) => request.phase === "dialog-refetch")).toEqual([])
  } finally {
    await setup.dispose()
  }
})

test.serial("selection-free show and hide archived uses archived-only mode", async () => {
  const setup = await mount({
    keybinds: { "session.archived.toggle_visibility": "ctrl+v" },
    respond(request) {
      if (request.url.pathname === "/api/location")
        return json({
          directory: process.cwd(),
          project: { id: "proj_fixture", directory: process.cwd(), canonical: process.cwd() },
        })
      if (request.url.pathname === "/api/session") return json({ data: [], cursor: {} })
      return undefined
    },
  })
  try {
    await setup.app.waitForFrame((frame) => frame.includes("No sessions available"), { maxPasses: 100 })
    setup.dispatch("session.archived.toggle_visibility")
    await setup.app.waitFor(() => setup.requests.some((request) => request.url.searchParams.get("archived")))
    expect(setup.requests.filter((request) => request.url.searchParams.get("archived") === "true")).toHaveLength(1)
    setup.dispatch("session.archived.toggle_visibility")
    await setup.app.waitFor(() => setup.requests.filter((request) => request.phase === "dialog-refetch").length >= 2)
  } finally {
    await stableDrain(setup.pending)
    await setup.dispose()
  }
})

test.serial("initial list hides epoch-zero archived roots", async () => {
  const setup = await mount({
    respond(request) {
      if (request.url.pathname === "/api/location")
        return json({
          directory: process.cwd(),
          project: { id: "proj_fixture", directory: process.cwd(), canonical: process.cwd() },
        })
      if (request.phase === "initial-list")
        return json({
          data: [
            active,
            { ...active, id: "ses_archived", title: "Archived epoch root", time: { ...active.time, archived: 0 } },
          ],
          cursor: {},
        })
      return undefined
    },
  })
  try {
    const frame = await setup.app.waitForFrame((value) => value.includes("Active root"), { maxPasses: 100 })
    expect(frame).not.toContain("Archived epoch root")
  } finally {
    await stableDrain(setup.pending)
    await setup.dispose()
  }
})
