/**
 * @spec-handoff
 * @interface icons(channel: string): Vite.Plugin
 * @behavior
 *   - Generates `/site.webmanifest` from `manifest.json` for every app channel.
 *   - Preserves install identity, standalone display, colors, description, screenshots, and any/maskable icons.
 *   - Rewrites only icon sources to the selected channel and keeps index.html linked to the generated manifest.
 *   - Does not retain `public/site.webmanifest` as a second manifest owner.
 * @edge-cases
 *   - The local channel uses the dev icon assets.
 * @see ./manifest.json
 */

import { existsSync } from "node:fs"
import { expect, test } from "bun:test"
import { fetch } from "bun"
import { build, createServer } from "vite"
import { icons } from "./vite.icons"
import manifest from "./manifest.json" with { type: "json" }

test("does not retain a legacy static manifest beside the generated manifest", () => {
  expect(existsSync(new URL("./public/site.webmanifest", import.meta.url))).toBe(false)
})

test.each(["dev", "beta", "prod", "local"])("bundles %s app icons", async (channel) => {
  const result = await build({
    root: import.meta.dirname,
    configFile: false,
    logLevel: "silent",
    plugins: [
      icons(channel),
      {
        name: "icons-only-fixture",
        transformIndexHtml: {
          order: "pre",
          handler: (html) => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ""),
        },
      },
    ],
    build: { write: false, copyPublicDir: false },
  })

  if (!("output" in result)) throw new Error("Expected a single build output")

  await check(channel === "local" ? "dev" : channel, async (path) => {
    const file = result.output.find((file) => `/${file.fileName}` === path)

    if (file?.type !== "asset") throw new Error(`Missing asset: ${path}`)

    return new Uint8Array(Buffer.from(file.source))
  })
})

test.each(["dev", "beta", "prod"])("serves %s app icons", async (channel) => {
  const server = await createServer({
    root: import.meta.dirname,
    configFile: false,
    logLevel: "silent",
    plugins: [icons(channel)],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: "127.0.0.1", port: 0, hmr: false, preTransformRequests: false, watch: null },
  })

  try {
    await server.listen()
    const url = server.resolvedUrls?.local[0]

    if (!url) throw new Error("Expected a local URL")

    await check(channel, async (path) => {
      const response = await fetch(new URL(path, url))
      expect(response.status).toBe(200)

      if (path.endsWith(".webmanifest")) expect(response.headers.get("content-type")).toBe("application/manifest+json")

      if (path.endsWith(".png")) expect(response.headers.get("content-type")).toBe("image/png")

      return new Uint8Array(await response.arrayBuffer())
    })
  } finally {
    await server.close()
  }
})

async function check(channel: string, read: (path: string) => Promise<Uint8Array>) {
  const html = new TextDecoder().decode(await read("/index.html"))
  const actual: typeof manifest = JSON.parse(new TextDecoder().decode(await read("/site.webmanifest")))
  expect(actual).toMatchObject({
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    theme_color: "#F8F7F7",
    background_color: "#F8F7F7",
    description: "AI coding agent for your terminal and browser",
    screenshots: [
      {
        src: "/screenshots/desktop.png",
        sizes: "1440x940",
        type: "image/png",
        form_factor: "wide",
        label: "OpenCode session view on desktop",
      },
      {
        src: "/screenshots/mobile.png",
        sizes: "390x844",
        type: "image/png",
        form_factor: "narrow",
        label: "OpenCode session view on mobile",
      },
    ],
  })
  expect(actual.icons).toEqual(
    manifest.icons.map((icon) => ({ ...icon, src: `/icons/${channel}${icon.src}` })),
  )
  expect(actual.icons.some((icon) => icon.purpose === "any")).toBe(true)
  expect(actual.icons.some((icon) => icon.purpose === "maskable")).toBe(true)
  expect(html).toContain(`href="/icons/${channel}/favicon.ico"`)
  expect(html).toContain(`href="/icons/${channel}/apple-touch-icon.png"`)
  expect(html).toContain(`href="/site.webmanifest"`)
  expect(html).not.toContain("%OPENCODE_")

  await Promise.all(
    Object.entries({
      "favicon.ico": "icon.ico",
      "apple-touch-icon.png": "ios/AppIcon-60x60@3x.png",
      "web-app-manifest-192x192.png": "android/mipmap-xxxhdpi/ic_launcher.png",
      "web-app-manifest-512x512.png": "icon.png",
    }).map(async ([name, source]) => {
      const bytes = await read(`/icons/${channel}/${name}`)
      expect(bytes).toEqual(await Bun.file(new URL(`../desktop/icons/${channel}/${source}`, import.meta.url)).bytes())

      if (!name.endsWith(".png")) return
      const size = name === "apple-touch-icon.png" ? 180 : Number(name.match(/(192|512)/)?.[0])
      expect(new DataView(bytes.buffer, bytes.byteOffset).getUint32(16)).toBe(size)
      expect(new DataView(bytes.buffer, bytes.byteOffset).getUint32(20)).toBe(size)
    }),
  )
}
