const accessMarker = /cloudflareaccess\.com|cloudflare access|cf-mitigated|__cf_chl|cdn-cgi\/access|access denied/i
const recoveryMarker = "__cf_access_recover"

export type RecoveryBrowser = {
  document: { documentElement: { hasAttribute(name: string): boolean; setAttribute(name: string, value: string): void } }
  navigator: { serviceWorker?: { getRegistrations(): Promise<ReadonlyArray<{ unregister(): Promise<boolean> }>> } }
  location: { href: string; origin?: string; replace(url: string): void }
}

let recoveryInFlight = false

export async function classifyCloudflareAccess(response: Response, requestURL: string): Promise<boolean> {
  const immediate = classifyImmediately(response, requestURL)
  if (immediate !== undefined) return immediate
  return accessMarker.test(await response.clone().text())
}

export function recoverCloudflareAccess(response: Response, browser: RecoveryBrowser): Promise<boolean> {
  if (
    browser.document.documentElement.hasAttribute(recoveryMarker) ||
    new URL(browser.location.href).searchParams.get(recoveryMarker) === "1" ||
    recoveryInFlight
  )
    return Promise.resolve(false)
  const classified = classifyImmediately(response, browser.location.href)
  if (classified === false) return Promise.resolve(false)

  recoveryInFlight = true
  if (classified === true) {
    browser.document.documentElement.setAttribute(recoveryMarker, "1")
    return completeRecovery(browser)
  }

  return classifyCloudflareAccess(response, browser.location.href)
    .then((isAccess) => {
      if (!isAccess) return false
      browser.document.documentElement.setAttribute(recoveryMarker, "1")
      return completeRecovery(browser)
    })
    .catch(() => false)
    .finally(() => {
      recoveryInFlight = false
    })
}

export function isCloudflareAccessRecoveryInFlight() {
  return recoveryInFlight
}

async function completeRecovery(browser: RecoveryBrowser): Promise<boolean> {
  try {
    const registrations = await browser.navigator.serviceWorker?.getRegistrations().catch(() => [])
    await Promise.allSettled(registrations?.map((registration) => registration.unregister()) ?? [])

    const origin = browser.location.origin ?? new URL(browser.location.href).origin
    const target = new URL(browser.location.href, origin)
    target.searchParams.set(recoveryMarker, "1")
    if (target.origin !== origin) return false
    browser.location.replace(target.href)
    return true
  } finally {
    recoveryInFlight = false
  }
}

function classifyImmediately(response: Response, requestURL: string): boolean | undefined {
  if (response.type === "opaqueredirect") return true
  if (response.status === 401) return false

  const request = new URL(requestURL)
  if (response.redirected && URL.canParse(response.url)) {
    const destination = new URL(response.url)
    if (isCloudflareAccessHost(destination.hostname)) return true
    if (destination.origin === request.origin && destination.pathname.startsWith("/cdn-cgi/access/")) return true
  }

  const redirect = response.headers.get("location")
  if (redirect) {
    const location = new URL(redirect, requestURL)
    if (location.origin !== request.origin && isCloudflareAccessHost(location.hostname)) return true
  }

  if (response.status !== 403) return false
  if (response.headers.has("cf-mitigated")) return true
  if (!response.headers.get("content-type")?.includes("text/html")) return false
}

function isCloudflareAccessHost(hostname: string) {
  return hostname === "cloudflareaccess.com" || hostname.endsWith(".cloudflareaccess.com")
}
