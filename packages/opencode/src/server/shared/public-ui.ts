// The static frontend (uiRoute /*) is now served publicly, so its assets —
// /login, the manifest, and the manifest icons — no longer need a public-path
// bypass here. The only consumer of authorizationRouterMiddleware is now
// docRoute (/doc), which nothing public flows through. The set is intentionally
// empty; the function stays as a declarative hook for any future public typed
// route that goes through the router middleware.
export const PUBLIC_UI_PATHS = new Set<string>([])

export function isPublicUIPath(method: string, pathname: string) {
  return method === "GET" && PUBLIC_UI_PATHS.has(pathname)
}
