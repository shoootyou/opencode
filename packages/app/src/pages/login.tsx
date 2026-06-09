import { Button } from "@opencode-ai/ui/button"
import { Logo } from "@opencode-ai/ui/logo"
import { TextField } from "@opencode-ai/ui/text-field"
import { createStore } from "solid-js/store"
import { authTokenFromCredentials, getCurrentServerUrl } from "@/utils/server"
import { buildFastPathRedirect, probeCredentials, safeRedirect } from "./login-utils"

export { safeRedirect, probeCredentials }

export default function LoginPage() {
  // If an auth_token is already present in the URL the server has already issued
  // credentials (e.g. the user navigated back to /login after a successful auth).
  // Redirect immediately so the form never renders, preventing a flash of the
  // login UI and avoiding adding /login to the browser history.
  // The token is forwarded to the target to prevent a 401 loop on back-navigation.
  const params = new URLSearchParams(location.search)
  const fastPathUrl = buildFastPathRedirect(params)
  if (fastPathUrl) {
    location.replace(fastPathUrl)
    // Return null synchronously to prevent child effects from running before navigation
    // commits. location.replace is asynchronous from the DOM's perspective.
    return null
  }

  // Read the redirect target from the URL synchronously — no router context needed.
  const redirect = safeRedirect(params.get("redirect"))

  const [store, setStore] = createStore({
    // Default to "opencode" — the server's OPENCODE_SERVER_USERNAME default.
    // opencode is a single-user tool; the username field is pre-filled for convenience.
    username: "opencode",
    password: "",
    error: "",
    busy: false,
  })

  async function handleSubmit() {
    if (store.busy) return
    if (!store.password) {
      setStore("error", "Password is required")
      return
    }

    setStore({ error: "", busy: true })

    const token = authTokenFromCredentials({ username: store.username, password: store.password })

    const outcome = await probeCredentials(getCurrentServerUrl(), token)

    if (outcome !== "ok") {
      setStore({
        busy: false,
        error: outcome === "unauthorized" ? "Invalid credentials" : "Cannot connect to server",
      })
      return
    }

    // Credentials verified — redirect with auth_token appended.
    const separator = redirect.includes("?") ? "&" : "?"
    location.href = `${redirect}${separator}auth_token=${encodeURIComponent(token)}`
  }

  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
      <div class="w-full max-w-sm flex flex-col items-center gap-6 px-6">
        <Logo class="w-40 opacity-60" />
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void handleSubmit()
          }}
          class="w-full flex flex-col gap-3"
          autocomplete="on"
        >
          <div class="w-full bg-surface-base rounded-md p-5 flex flex-col gap-3">
            <TextField
              type="text"
              label="Username"
              placeholder="opencode"
              value={store.username}
              disabled={store.busy}
              autofocus
              name="username"
              autocomplete="username"
              onChange={(value) => setStore({ username: value, error: "" })}
            />
            <TextField
              type="password"
              label="Password"
              placeholder="Password"
              value={store.password}
              disabled={store.busy}
              validationState={store.error ? "invalid" : "valid"}
              error={store.error}
              name="password"
              autocomplete="current-password"
              onChange={(value) => setStore({ password: value, error: "" })}
            />
          </div>
          <Button
            type="submit"
            size="large"
            variant="primary"
            class="w-full px-3 py-1.5"
            disabled={store.busy}
          >
            {store.busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </div>
    </div>
  )
}
