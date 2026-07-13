import { readFileSync } from "node:fs"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "url"

const theme = fileURLToPath(new URL("./public/oc-theme-preload.js", import.meta.url))
const viewport = fileURLToPath(new URL("./public/oc-viewport-preload.js", import.meta.url))

function inlinePreloadScript(name, scriptId, filePath) {
  const tag = `<script id="${scriptId}" src="/${scriptId.replace(/-script$/, "")}.js"></script>`
  return {
    name,
    transformIndexHtml(html) {
      return html.replace(tag, `<script id="${scriptId}">${readFileSync(filePath, "utf8")}</script>`)
    },
  }
}

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (process.env.OPENCODE_CHANNEL === "latest") return "prod"
  return "dev"
})()

/**
 * @type {import("vite").PluginOption}
 */
export default [
  {
    name: "opencode-desktop:config",
    config() {
      return {
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
          },
        },
        define: {
          "import.meta.env.VITE_OPENCODE_CHANNEL": JSON.stringify(channel),
        },
        worker: {
          format: "es",
        },
      }
    },
  },
  inlinePreloadScript("opencode-desktop:theme-preload", "oc-theme-preload-script", theme),
  inlinePreloadScript("opencode-desktop:viewport-preload", "oc-viewport-preload-script", viewport),
  tailwindcss(),
  solidPlugin(),
]
