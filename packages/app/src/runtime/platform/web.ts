import { createBrowserDraftStore } from "@/runtime/persistence/drafts"
import {
  classifyCloudflareAccess,
  isCloudflareAccessRecoveryInFlight,
  recoverCloudflareAccess,
} from "@/runtime/server/recovery"
import type { Platform } from "./platform"

export function createWebPlatform(version: string) {
  let accessProbeInFlight = false
  const fetch: typeof globalThis.fetch = Object.assign(
    async (resource: RequestInfo | URL, init?: RequestInit) => {
      try {
        const response = await globalThis.fetch(resource, init)
        void recoverCloudflareAccess(response, { document, navigator, location })
        return response
      } catch (error) {
        if (shouldProbeCloudflareAccess(error, resource, accessProbeInFlight)) {
          accessProbeInFlight = true
          // The probe uses native fetch so a failed probe never re-enters this guarded wrapper.
          const origin = getLocationOrigin()
          void globalThis
            .fetch(new URL("/", origin).href, {
              redirect: "manual",
              cache: "no-store",
              credentials: "same-origin",
            })
            .then(async (response) => ({ response, isAccess: await classifyCloudflareAccess(response, location.href) }))
            .then(({ response, isAccess }) => {
              if (isAccess) {
                void recoverCloudflareAccess(response, { document, navigator, location })
              }
            })
            .catch(() => {})
            .finally(() => {
              accessProbeInFlight = false
            })
        }
        throw error
      }
    },
    { preconnect: globalThis.fetch.preconnect },
  )

  const platform: Platform = {
    platform: "web",
    draftStore: createBrowserDraftStore(),
    fetch,
    version,
    openExternal(value) {
      if (!URL.canParse(value)) return
      const url = new URL(value)

      if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") return
      window.open(url.href, "_blank", "noopener,noreferrer")
    },
    restart: async () => window.location.reload(),
    async notify(title, description, onClick) {
      if (!("Notification" in window)) return

      const permission =
        Notification.permission === "default"
          ? await Notification.requestPermission().catch(() => "denied")
          : Notification.permission

      if (permission !== "granted") return

      if (document.visibilityState === "visible" && document.hasFocus()) return

      const notification = new Notification(title, {
        body: description ?? "",
        icon: "https://opencode.ai/favicon-96x96-v3.png",
      })

      notification.onclick = () => {
        window.focus()
        onClick?.()
        notification.close()
      }
    },
  }

  return {
    platform,
    currentServerUrl: getCurrentServerUrl(),
  }
}

function shouldProbeCloudflareAccess(error: unknown, resource: RequestInfo | URL, probeInFlight: boolean) {
  if (!(error instanceof TypeError) || error.name === "AbortError") return false
  if (probeInFlight || isCloudflareAccessRecoveryInFlight()) return false
  if (document.documentElement.hasAttribute("__cf_access_recover")) return false
  if (new URL(location.href).searchParams.has("__cf_access_recover")) return false
  return new URL(resource instanceof Request ? resource.url : resource, location.href).origin === getLocationOrigin()
}

function getLocationOrigin() {
  return location.origin || new URL(location.href).origin
}

function getCurrentServerUrl() {
  if (import.meta.env.VITE_OPENCODE_SERVER_MODE === "none") return undefined

  if (import.meta.env.DEV) {
    const loopback =
      location.hostname === "localhost" || location.hostname === "[::1]" || location.hostname.startsWith("127.")

    const host = import.meta.env.VITE_OPENCODE_SERVER_HOST ?? (loopback ? location.hostname : "localhost")

    return `http://${host}:${import.meta.env.VITE_OPENCODE_SERVER_PORT ?? "4096"}`
  }

  return location.origin
}
