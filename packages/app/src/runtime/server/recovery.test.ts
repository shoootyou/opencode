/**
 * @spec-handoff
 * @interface classifyCloudflareAccess(response: Response, requestURL: string): Promise<boolean>
 * @interface recoverCloudflareAccess(response: Response, browser: RecoveryBrowser): Promise<boolean>
 * @behavior
 *   - Classifies Cloudflare Access redirects, followed Access destinations, and mitigation responses without consuming bodies.
 *   - Unregisters service workers best-effort, then replaces the current same-origin URL once.
 * @edge-cases
 *   - A followed redirect ending at a Cloudflare Access host or same-origin /cdn-cgi/access/ path is recovered.
 *   - Existing __cf_access_recover marker and synchronous duplicate calls are no-ops.
 *   - App authentication responses, JSON errors, and ordinary redirects are not recovered.
 */
import { describe, expect, test } from "bun:test"
import { classifyCloudflareAccess, recoverCloudflareAccess } from "./recovery"

type RecoveryBrowser = {
  document: {
    documentElement: { hasAttribute(name: string): boolean; setAttribute(name: string, value: string): void }
  }
  navigator: {
    serviceWorker?: {
      getRegistrations(): Promise<ReadonlyArray<{ unregister(): Promise<boolean> }>>
    }
  }
  location: { href: string; replace(url: string): void }
}

function response(status: number, headers?: HeadersInit, body?: BodyInit | null) {
  return new Response(body, { status, headers })
}

function followedResponse(url: string) {
  const current = response(200)
  Object.defineProperties(current, {
    redirected: { value: true },
    url: { value: url },
  })
  return current
}

function responseWithURL(url: string) {
  const current = response(200)
  Object.defineProperty(current, "url", { value: url })
  return current
}

function browser(input?: Partial<RecoveryBrowser>) {
  const attributes = new Map<string, string>()
  const replacements: string[] = []
  const value: RecoveryBrowser = {
    document: {
      documentElement: {
        hasAttribute: (name) => attributes.has(name),
        setAttribute: (name, attribute) => attributes.set(name, attribute),
      },
    },
    navigator: { serviceWorker: { getRegistrations: async () => [] } },
    location: {
      href: "https://app.example.test/project/path?tab=files&__cf_access_recover=stale#changes",
      replace: (url) => replacements.push(url),
    },
    ...input,
  }

  return { value, attributes, replacements }
}

describe("Cloudflare Access recovery", () => {
  test.each([
    ["opaque redirect", { type: "opaqueredirect", status: 0, headers: new Headers() } as unknown as Response],
    [
      "Cloudflare Access redirect",
      response(302, { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/app.example.test" }),
    ],
    ["Cloudflare mitigation header", response(403, { "cf-mitigated": "challenge" })],
    ["cloned Cloudflare Access marker", response(403, { "content-type": "text/html" }, "<title>Access denied</title>")],
  ])("classifies %s", async (_name, current) => {
    expect(await classifyCloudflareAccess(current, "https://app.example.test/api/info")).toBe(true)
  })

  test.each([
    ["a Cloudflare Access host", "https://team.cloudflareaccess.com/cdn-cgi/access/login/app.example.test"],
    ["the same-origin Access namespace", "https://app.example.test/cdn-cgi/access/login"],
  ])("classifies a followed redirect ending at %s", async (_name, url) => {
    expect(await classifyCloudflareAccess(followedResponse(url), "https://app.example.test/api/info")).toBe(true)
  })

  test.each([
    ["application 401", response(401)],
    ["JSON 403", response(403, { "content-type": "application/json" }, JSON.stringify({ error: "forbidden" }))],
    ["same-origin redirect", response(302, { location: "https://app.example.test/login" })],
    ["non-Cloudflare redirect", response(302, { location: "https://login.example.test/login" })],
    ["a lookalike hostname without a Cloudflare Access dot boundary", response(302, { location: "https://notcloudflareaccess.com/login" })],
    ["followed same-origin non-Cloudflare redirect", followedResponse("https://app.example.test/login")],
    ["followed same-origin path outside the exact Access namespace", followedResponse("https://app.example.test/cdn-cgi/accessory")],
    ["followed cross-origin path inside the Access namespace", followedResponse("https://other.example.test/cdn-cgi/access/login")],
    ["unredirected response whose URL names a Cloudflare Access host", responseWithURL("https://team.cloudflareaccess.com/login")],
  ])("does not classify %s", async (_name, current) => {
    expect(await classifyCloudflareAccess(current, "https://app.example.test/api/info")).toBe(false)
  })

  test("reads the Access HTML marker only from a clone", async () => {
    const current = response(403, { "content-type": "text/html" }, "<h1>Access denied</h1>")

    expect(await classifyCloudflareAccess(current, "https://app.example.test/api/info")).toBe(true)
    expect(await current.text()).toBe("<h1>Access denied</h1>")
  })

  test("uses a synchronous document guard and tolerates every service-worker failure", async () => {
    let release!: () => void
    let registrations = 0
    const pending = new Promise<Array<{ unregister(): Promise<boolean> }>>((resolve) => (release = () => resolve([])))
    const target = browser({
      navigator: {
        serviceWorker: {
          getRegistrations: async () => {
            registrations++
            return pending
          },
        },
      },
    })

    const first = recoverCloudflareAccess(response(403, { "cf-mitigated": "challenge" }), target.value)
    const second = recoverCloudflareAccess(response(403, { "cf-mitigated": "challenge" }), target.value)

    expect(registrations).toBe(1)
    expect(await second).toBe(false)
    release()
    expect(await first).toBe(true)
    expect(target.replacements).toEqual([
      "https://app.example.test/project/path?tab=files&__cf_access_recover=1#changes",
    ])
    expect(target.attributes.has("__cf_access_recover")).toBe(true)
  })

  test("does not recover when the document already carries the loop marker", async () => {
    const target = browser()
    target.attributes.set("__cf_access_recover", "1")

    expect(await recoverCloudflareAccess(response(403, { "cf-mitigated": "challenge" }), target.value)).toBe(false)
    expect(target.replacements).toEqual([])
  })

  test("continues to replace the clean same-origin URL when registration lookup or unregistering fails", async () => {
    const target = browser({
      navigator: {
        serviceWorker: {
          getRegistrations: async () => [{ unregister: async () => Promise.reject(new Error("unavailable")) }],
        },
      },
    })

    expect(await recoverCloudflareAccess(response(403, { "cf-mitigated": "challenge" }), target.value)).toBe(true)
    expect(target.replacements).toEqual([
      "https://app.example.test/project/path?tab=files&__cf_access_recover=1#changes",
    ])

    const lookupFailure = browser({
      navigator: { serviceWorker: { getRegistrations: async () => Promise.reject(new Error("gone")) } },
    })
    expect(await recoverCloudflareAccess(response(403, { "cf-mitigated": "challenge" }), lookupFailure.value)).toBe(
      true,
    )
    expect(lookupFailure.replacements).toHaveLength(1)
  })
})
