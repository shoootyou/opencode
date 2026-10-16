/**
 * @spec-handoff
 * @interface createWebPlatform(version: string): { platform: Platform; currentServerUrl?: string }
 * @behavior
 *   - Supplies one guarded Platform.fetch seam used by health checks, queued API calls, and event streams.
 *   - Confirms a same-origin TypeError in a background same-origin GET probe before recovering, then rethrows the original failure.
 *   - Forwards request method, body, signal, headers, and fetch preconnect calls unchanged to browser fetch.
 * @edge-cases
 *   - The probe is GET / with redirect: "manual", cache: "no-store", and same-origin credentials; it never re-enters the wrapper.
 *   - AbortError, cross-origin failures, non-TypeError failures, loop/in-flight guards, and non-Cloudflare probe outcomes do not trigger recovery.
 *   - A recovery target carries the loop marker, remains same-origin, and service-worker teardown is best-effort.
 *   - The original TypeError rejects without waiting for a pending probe.
 *   - The event stream remains observable and bypasses request-queue accounting, not the guarded seam.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { checkServerHealth } from "@/runtime/server/health"
import { createRequestQueue } from "@/runtime/server/request-queue"
import { createWebPlatform } from "./web"

const originalFetch = globalThis.fetch
type BrowserFetch = typeof globalThis.fetch
type BrowserFetchInput = Parameters<BrowserFetch>[0]
type BrowserFetchInit = Parameters<BrowserFetch>[1]
type BrowserFetchPreconnect = BrowserFetch["preconnect"]
type BrowserFetchPreconnectInput = Parameters<BrowserFetchPreconnect>[0]
type BrowserFetchPreconnectOptions = Parameters<BrowserFetchPreconnect>[1]
const indexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB")
const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document")
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator")
const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location")

afterEach(() => {
  globalThis.fetch = originalFetch
  if (indexedDB) Object.defineProperty(globalThis, "indexedDB", indexedDB)
  if (!indexedDB) delete (globalThis as Partial<typeof globalThis>).indexedDB
  restoreGlobal("document", documentDescriptor)
  restoreGlobal("navigator", navigatorDescriptor)
  restoreGlobal("location", locationDescriptor)
})

function restoreGlobal(name: "document" | "navigator" | "location", descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor)
  if (!descriptor) delete (globalThis as Partial<typeof globalThis>)[name]
}

function mockBrowserFetch(
  callback: (resource: BrowserFetchInput, init?: BrowserFetchInit) => ReturnType<BrowserFetch>,
  preconnect: BrowserFetchPreconnect = () => {},
): BrowserFetch {
  return Object.assign(callback, { preconnect })
}

function installRecoveryBrowser(input?: { getRegistrations?: () => Promise<Array<{ unregister(): Promise<boolean> }>> }) {
  const attributes = new Map<string, string>()
  const replacements: string[] = []
  let registrations = 0

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      documentElement: {
        hasAttribute: (name: string) => attributes.has(name),
        setAttribute: (name: string, value: string) => attributes.set(name, value),
      },
    },
  })
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      serviceWorker: {
        getRegistrations: async () => {
          registrations++
          return input?.getRegistrations?.() ?? []
        },
      },
    },
  })
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: {
      href: "https://app.example.test/project/path?tab=files#changes",
      replace: (url: string) => replacements.push(url),
    },
  })
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open: () => ({ addEventListener() {} }) },
  })

  return { attributes, replacements, registrations: () => registrations }
}

async function flushRecovery() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe("createWebPlatform", () => {
  test("routes health, queued API requests, and SSE through one guarded fetch seam without changing request shape", async () => {
    const requests: Request[] = []
    const preconnects: Array<[BrowserFetchPreconnectInput, BrowserFetchPreconnectOptions | undefined]> = []
    const controller = new AbortController()
    const browserFetch = mockBrowserFetch(
      async (resource: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(resource, init)
        requests.push(request)

        if (new URL(request.url).pathname === "/api/info") {
          return Response.json({ version: "2.0.28", pid: 1, urls: [], paths: { tmp: "/tmp" } })
        }

        return new Response("ok")
      },
      (url, options) => {
        preconnects.push([url, options])
      },
    )
    globalThis.fetch = browserFetch
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: { open: () => ({ addEventListener() {} }) },
    })

    const web = createWebPlatform("2.0.28")
    const seam = web.platform.fetch
    expect(seam).toBeDefined()
    const guarded = seam!

    expect(
      await checkServerHealth({ url: "https://app.example.test", password: "password" }, guarded, { retryCount: 0 }),
    ).toEqual({
      healthy: true,
      version: "2.0.28",
    })

    const queue = createRequestQueue({ fetch: guarded })
    await queue.fetch("https://app.example.test/api/session", {
      method: "POST",
      body: "payload",
      headers: { "x-request-id": "request-1" },
      signal: controller.signal,
    })
    await queue.fetch("https://app.example.test/api/event?directory=%2Fworkspace", {
      headers: { accept: "text/event-stream" },
    })
    guarded.preconnect("https://app.example.test", { dns: true })

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/info",
      "/api/session",
      "/api/event",
    ])
    expect(requests[1]!.method).toBe("POST")
    expect(await requests[1]!.text()).toBe("payload")
    expect(requests[1]!.headers.get("x-request-id")).toBe("request-1")
    expect(requests[1]!.signal.aborted).toBe(false)
    expect(requests[2]!.headers.get("accept")).toBe("text/event-stream")
    expect(preconnects).toEqual([["https://app.example.test", { dns: true }]])
  })

  test("recovers after a background root probe confirms Cloudflare Access, then rethrows the original TypeError", async () => {
    const browser = installRecoveryBrowser()
    const failure = new TypeError("Failed to fetch")
    const requests: Array<[RequestInfo | URL, RequestInit | undefined]> = []
    globalThis.fetch = mockBrowserFetch(async (resource, init) => {
      requests.push([resource, init])
      if (requests.length === 1) return Promise.reject(failure)
      return new Response(null, {
        status: 302,
        headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/app.example.test" },
      })
    })

    const guarded = createWebPlatform("2.0.28").platform.fetch!

    await expect(guarded("https://app.example.test/api/info")).rejects.toBe(failure)
    await flushRecovery()
    expect(requests).toEqual([
      ["https://app.example.test/api/info", undefined],
      ["https://app.example.test/", { redirect: "manual", cache: "no-store", credentials: "same-origin" }],
    ])
    expect(browser.registrations()).toBe(1)
    expect(browser.replacements).toEqual([
      "https://app.example.test/project/path?tab=files&__cf_access_recover=1#changes",
    ])
  })

  test("rethrows the original same-origin TypeError without waiting for its pending background probe", async () => {
    const browser = installRecoveryBrowser()
    const failure = new TypeError("Failed to fetch")
    let probeStarted = false
    globalThis.fetch = mockBrowserFetch(async (_resource, init) => {
      if (!init) return Promise.reject(failure)
      probeStarted = true
      return new Promise<Response>(() => {})
    })

    const guarded = createWebPlatform("2.0.28").platform.fetch!

    await expect(guarded("https://app.example.test/api/info")).rejects.toBe(failure)
    expect(probeStarted).toBe(true)
    expect(browser.registrations()).toBe(0)
    expect(browser.replacements).toEqual([])
  })

  test.each([
    ["rejects", async () => Promise.reject(new TypeError("probe offline"))],
    ["returns an application 200", async () => Response.json({ ok: true })],
    ["returns a JSON 401", async () => Response.json({ error: "unauthorized" }, { status: 401 })],
    ["returns a 5xx", async () => new Response("unavailable", { status: 503 })],
  ])("does not recover when the confirmation probe %s", async (_name, probe) => {
    const browser = installRecoveryBrowser()
    const failure = new TypeError("Failed to fetch")
    let probes = 0
    globalThis.fetch = mockBrowserFetch(async (_resource, init) => {
      if (!init) return Promise.reject(failure)
      probes++
      return probe()
    })

    const guarded = createWebPlatform("2.0.28").platform.fetch!

    await expect(guarded("https://app.example.test/api/info")).rejects.toBe(failure)
    await flushRecovery()

    expect(probes).toBe(1)
    expect(browser.registrations()).toBe(0)
    expect(browser.replacements).toEqual([])
  })

  test.each([
    [
      "an AbortError",
      async () => Promise.reject(new DOMException("aborted", "AbortError")),
      "https://app.example.test/api/info",
      true,
    ],
    [
      "a TypeError labelled AbortError",
      async () => Promise.reject(Object.assign(new TypeError("aborted"), { name: "AbortError" })),
      "https://app.example.test/api/info",
      true,
    ],
    [
      "a cross-origin TypeError",
      async () => Promise.reject(new TypeError("Failed to fetch")),
      "https://other.example.test/api/info",
      true,
    ],
    [
      "a non-TypeError rejection",
      async () => Promise.reject(new Error("connection refused")),
      "https://app.example.test/api/info",
      true,
    ],
    [
      "an ordinary JSON 401",
      async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
      "https://app.example.test/api/info",
      false,
    ],
    [
      "a non-HTML 403 without cf-mitigated",
      async () =>
        new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      "https://app.example.test/api/info",
      false,
    ],
  ])("does not recover or probe for %s", async (_name, browserFetch, url, rejects) => {
    const browser = installRecoveryBrowser()
    let calls = 0
    const original = browserFetch
    globalThis.fetch = mockBrowserFetch((resource, init) => {
      calls++
      void resource
      void init
      return original()
    })
    const guarded = createWebPlatform("2.0.28").platform.fetch!

    if (rejects) await expect(guarded(url)).rejects.toBeInstanceOf(Error)
    if (!rejects) await guarded(url)
    await flushRecovery()

    expect(browser.registrations()).toBe(0)
    expect(browser.replacements).toEqual([])
    expect(calls).toBe(1)
  })

  test("does not probe a same-origin TypeError after the recovery loop marker is set", async () => {
    const browser = installRecoveryBrowser()
    browser.attributes.set("__cf_access_recover", "1")
    const failure = new TypeError("Failed to fetch")
    let calls = 0
    globalThis.fetch = mockBrowserFetch(async () => {
      calls++
      return Promise.reject(failure)
    })

    const guarded = createWebPlatform("2.0.28").platform.fetch!

    await expect(guarded("https://app.example.test/api/info")).rejects.toBe(failure)
    await flushRecovery()

    expect(calls).toBe(1)
    expect(browser.registrations()).toBe(0)
    expect(browser.replacements).toEqual([])
  })

  test("does not probe a same-origin TypeError while a response-triggered recovery is in flight", async () => {
    let release!: () => void
    installRecoveryBrowser({
      getRegistrations: () => new Promise((resolve) => (release = () => resolve([]))),
    })
    const failure = new TypeError("Failed to fetch")
    let calls = 0
    globalThis.fetch = mockBrowserFetch(async () => {
      calls++
      if (calls === 1) return new Response(null, { status: 403, headers: { "cf-mitigated": "challenge" } })
      return Promise.reject(failure)
    })

    const guarded = createWebPlatform("2.0.28").platform.fetch!

    await guarded("https://app.example.test/api/info")
    await expect(guarded("https://app.example.test/api/info")).rejects.toBe(failure)
    await flushRecovery()

    expect(calls).toBe(2)
    release()
    await flushRecovery()
  })

  test("starts only one background probe while an earlier same-origin probe is pending", async () => {
    const browser = installRecoveryBrowser()
    const failure = new TypeError("Failed to fetch")
    let release!: (response: Response) => void
    let probes = 0
    globalThis.fetch = mockBrowserFetch(async (_resource, init) => {
      if (!init) return Promise.reject(failure)
      probes++
      return new Promise<Response>((resolve) => (release = resolve))
    })

    const guarded = createWebPlatform("2.0.28").platform.fetch!

    await expect(guarded("https://app.example.test/api/info")).rejects.toBe(failure)
    await expect(guarded("https://app.example.test/api/session")).rejects.toBe(failure)
    expect(probes).toBe(1)
    release(Response.json({ ok: true }))
    await flushRecovery()
    expect(browser.replacements).toEqual([])
  })

  test("classifies a probe once without re-entering the guarded fetch seam", async () => {
    const browser = installRecoveryBrowser()
    const failure = new TypeError("Failed to fetch")
    const probe = new Response("<h1>offline</h1>", { status: 403, headers: { "content-type": "text/html" } })
    let clones = 0
    const clone = probe.clone.bind(probe)
    Object.defineProperty(probe, "clone", { value: () => (clones++, clone()) })
    globalThis.fetch = mockBrowserFetch(async (_resource, init) => (init ? probe : Promise.reject(failure)))

    const guarded = createWebPlatform("2.0.28").platform.fetch!

    await expect(guarded("https://app.example.test/api/info")).rejects.toBe(failure)
    await flushRecovery()
    expect(clones).toBe(1)
    expect(browser.replacements).toEqual([])
  })
})
