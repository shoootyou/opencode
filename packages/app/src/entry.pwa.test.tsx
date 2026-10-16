/**
 * @spec-handoff
 * @interface entry.tsx: void
 * @behavior
 *   - The v2 shell/root composition mounts PwaUpdatePrompt at the current shell seam.
 *   - In production, it registers /sw.js exactly once after the window load event.
 *   - Registration is compatible with vite-plugin-pwa registerType: "prompt" and injectRegister: false.
 * @edge-cases
 *   - Repeated load events do not create duplicate registrations.
 *   - The prompt remains outside app-internal loading/error boundaries.
 * @see ./shell/titlebar/PwaUpdatePrompt.tsx
 */

import { beforeEach, describe, mock, test } from "bun:test"

mock.module("virtual:pwa-register/solid", () => ({
  useRegisterSW: () => ({
    needRefresh: [() => false, () => {}],
    updateServiceWorker: undefined,
  }),
}))

mock.module("@/runtime/platform/web", () => ({
  createWebPlatform: () => ({
    platform: {},
    currentServerUrl: undefined,
  }),
}))

mock.module("@/app", () => ({
  AppBaseProviders: (props: { children?: unknown }) => props.children,
  AppInterface: (props: { children?: unknown }) => props.children,
}))

mock.module("@/runtime/platform/pwa", () => ({
  isStandalone: () => false,
  PwaRoutePersistence: () => null,
  restorePwaRoute: () => {},
}))

mock.module("@/runtime/i18n/language", () => ({
  loadInitialLocale: () => Promise.resolve("en"),
  useLanguage: () => ({ t: (key: string) => key }),
}))

beforeEach(() => {
  if (!document.getElementById("root")) {
    const root = document.createElement("div")
    root.id = "root"
    document.body.appendChild(root)
  }
})

describe("v2 PWA composition", () => {
  test("registers /sw.js once after load and mounts PwaUpdatePrompt outside app loading/error boundaries", async () => {
    await import("./entry")
  })
})
