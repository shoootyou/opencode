/**
 * @spec-handoff
 * @interface vite.config.ts#pwaComposition: Readonly<{ plugin: Vite.PluginOption; options: VitePWAOptions }>
 * @behavior
 *   - Exports a frozen PWA composition whose plugin is the third raw config slot and whose options use the absolute app dist directory.
 *   - Exports exactly the desktop plugin group, icons plugin, PWA plugin, and optional Sentry group in that order.
 *   - Passes the selected channel to actual icon HTML transforms.
 *   - Selects the complete fixture entrypoint set only when VITE_OPENCODE_TEST_FIXTURES is "1".
 * @edge-cases
 *   - Sentry's raw slot is false unless all required Sentry environment inputs are supplied.
 *   - The config does not include a second, legacy inline PWA plugin group.
 * @see ./vite.js
 * @see ./vite.icons.ts
 * @see ./vite.pwa.ts
 */

import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

const distDirectory = fileURLToPath(new URL("./dist", import.meta.url))
const fixtureInput = [
  "index.html",
  "e2e/utils/settings-wsl.html",
  "e2e/utils/app-direction.html",
  "e2e/utils/windows-menu.html",
]
const isolatedKeys = [
  "VITE_OPENCODE_TEST_FIXTURES",
  "SENTRY_AUTH_TOKEN",
  "SENTRY_ORG",
  "SENTRY_PROJECT",
  "SENTRY_RELEASE",
  "VITE_SENTRY_RELEASE",
  "OPENCODE_CHANNEL",
]

function observe(options: { fixtures?: boolean; sentry?: boolean } = {}) {
  const env = { ...process.env }
  isolatedKeys.forEach((key) => delete env[key])
  env.OPENCODE_CHANNEL = "beta"

  if (options.fixtures) env.VITE_OPENCODE_TEST_FIXTURES = "1"
  if (options.sentry) {
    env.SENTRY_AUTH_TOKEN = "fixture-token"
    env.SENTRY_ORG = "fixture-org"
    env.SENTRY_PROJECT = "fixture-project"
  }

  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `
        import config, { pwaComposition } from "./vite.config.ts"
        import desktopPlugin from "./vite.js"

        const icons = config.plugins[1]
        const sentry = config.plugins[3]
        const iconTransform = icons.transformIndexHtml.handler(
          "%OPENCODE_FAVICON%|%OPENCODE_APPLE_TOUCH_ICON%",
        )
        const sentryGroup = sentry === false ? false : (Array.isArray(sentry) ? sentry : [sentry]).map((plugin) => plugin.name)

        console.log(JSON.stringify({
          pluginSlots: config.plugins.length,
          slot0IsDesktopPlugin: config.plugins[0] === desktopPlugin,
          slot1: { name: icons.name, iconTransform },
          slot2IsPwaCompositionPlugin: config.plugins[2] === pwaComposition.plugin,
          pwaCompositionIsFrozen: Object.isFrozen(pwaComposition),
          pwaOptionsAreFrozen: Object.isFrozen(pwaComposition.options),
          pwa: { name: pwaComposition.plugin.name, globDirectory: pwaComposition.options.globDirectory },
          slot3: sentryGroup,
          build: config.build,
        }))
      `,
    ],
    cwd: import.meta.dir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })

  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0)
  return JSON.parse(new TextDecoder().decode(result.stdout))
}

test("exports only the ordered desktop, icons, PWA, and disabled Sentry raw slots", () => {
  const observation = observe()

  expect(observation.pluginSlots).toBe(4)
  expect(observation.slot0IsDesktopPlugin).toBe(true)
  expect(observation.slot1.name).toBe("opencode-app:icons")
  expect(observation.slot2IsPwaCompositionPlugin).toBe(true)
  expect(observation.slot3).toBe(false)
})

test("uses the channel-selected actual icons plugin transform", () => {
  const observation = observe()

  expect(observation.slot1.iconTransform).toBe("/icons/beta/favicon.ico|/icons/beta/apple-touch-icon.png")
})

test("exports a frozen PWA composition with the exact app dist directory and selects raw fixture inputs", () => {
  const observation = observe({ fixtures: true })

  expect(observation.pwaCompositionIsFrozen).toBe(true)
  expect(observation.pwaOptionsAreFrozen).toBe(true)
  expect(observation.pwa.globDirectory).toBe(distDirectory)
  expect(observation.build.rolldownOptions.input).toEqual(fixtureInput)
})

test("replaces the false Sentry slot with its present raw group only when configured", () => {
  const withoutSentry = observe()
  const withSentry = observe({ sentry: true })

  expect(withoutSentry.slot3).toBe(false)
  expect(withSentry.slot3).toEqual(expect.arrayContaining([expect.stringContaining("sentry")]))
})
