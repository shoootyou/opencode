/**
 * @spec-handoff
 * @interface packages/app/public/_headers: Cloudflare Pages-style header rules
 * @behavior
 *   - Contains no unresolved Git merge markers.
 *   - Caches the Vite build assets directory immutably at `/<assetsDir>/*`, never at `/assets/*`.
 *   - Revalidates generated service-worker entry files rather than caching them immutably.
 *   - Retains shared security headers from both merge parents when such headers exist.
 * @edge-cases
 *   - The asset directory is derived from vite.config.ts so a future build-directory rename stays aligned.
 * @see ./vite.config.ts
 */

import { expect, test } from "bun:test"

const headers = await Bun.file(new URL("./public/_headers", import.meta.url)).text()
const viteConfig = await Bun.file(new URL("./vite.config.ts", import.meta.url)).text()
const assetsDir = viteConfig.match(/assetsDir:\s*["']([^"']+)["']/)?.[1]

function rule(path: string) {
  const lines = headers.split("\n")
  const start = lines.findIndex((line) => line === path)
  if (start === -1) return []

  const end = lines.slice(start + 1).findIndex((line) => !line.startsWith("  "))
  return lines.slice(start + 1, end === -1 ? undefined : start + 1 + end)
}

test("Cloudflare Pages headers contain no unresolved merge markers", () => {
  expect(headers).not.toMatch(/^(?:<<<<<<<|=======|>>>>>>>)/m)
})

test("Cloudflare Pages headers cache the Vite asset directory rather than the obsolete assets directory", () => {
  expect(assetsDir).toBeDefined()
  expect(headers).not.toContain("/assets/*")

  const assetHeaders = rule(`/${assetsDir}/*`)
  expect(assetHeaders).toContain("  Cache-Control: public, max-age=31536000, immutable")
})

test("Cloudflare Pages headers revalidate generated service-worker scripts", () => {
  for (const path of ["/sw.js", "/registerSW.js"]) {
    const cacheControl = rule(path).find((line) => line.startsWith("  Cache-Control:"))
    expect(cacheControl).toMatch(/\b(?:no-cache|must-revalidate)\b/)
    expect(cacheControl).not.toContain("immutable")
  }
})
