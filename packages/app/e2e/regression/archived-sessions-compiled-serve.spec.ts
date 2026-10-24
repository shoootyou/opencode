/**
 * @spec-handoff
 * @interface compiledArchivedSessionsDialog(binaryPath: string): Promise<void>
 * @behavior
 *   - Shows each archived row's real title (or the localized untitled label), truncated directory, and relative archived time.
 *   - Keeps rows inset by 12px and readable without horizontal overflow at 320px, 375px, and desktop widths.
 *   - Renders a decorative native session icon, start-aligned title/path text, and an independently right-aligned date.
 *   - Keeps icon, title, directory, and date on one desktop row; narrow rows stack only title/path in the left column.
 *   - Restores the keyboard-selected archived session and retains paging and search controls.
 * @edge-cases
 *   - A timestamp of 0 remains a row but intentionally has no date.
 *   - The displayed date derives from time.archived, not time.updated or time.created.
 *   - Long titles and directories truncate without viewport overflow while the date remains a separate right column.
 *   - An extremely long unbroken title cannot collapse a non-empty directory below a readable 48px allocation.
 * @rerun PLAYWRIGHT_BASE_URL=http://127.0.0.1:9 OPENCODE_COMPILED_BINARY=<rebuilt binary> playwright test archived-sessions-compiled-serve.spec.ts
 * @see ./dialog-archived-sessions.tsx
 */
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test"
import { Schema } from "effect"
import { randomBytes, randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import path from "node:path"

test.use({ serviceWorkers: "block" })

const repo = path.resolve(import.meta.dirname, "../../../..")

const binary = process.env.OPENCODE_COMPILED_BINARY

const artifactRoot = process.env.OPENCODE_ARCHIVE_E2E_ARTIFACTS ?? path.join(repo, ".debug", "plan373-e9")

const browserRuntime = path.join(repo, ".debug", "browser-runtime")

const executablePath = path.join(
  repo,
  ".debug",
  "20261023-archive-web-ui-browser-e7-shin",
  "browsers",
  "chromium_headless_shell-1217",
  "chrome-headless-shell-linux64",
  "chrome-headless-shell",
)

const password = randomBytes(32).toString("hex")

const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`

const ServerIdentity = Schema.Struct({ pid: Schema.Int })

let server: ChildProcess

let serverState: string

let origin: string

let browser: Browser

let context: BrowserContext

let page: Page

test.skip(!binary, "set OPENCODE_COMPILED_BINARY to a rebuilt local opencode binary")

test.beforeAll(async () => {
  try {
    serverState = await createServerState()
    await mkdir(path.join(serverState, "workspace"), { recursive: true })
    server = spawn(binary!, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: path.join(serverState, "workspace"),
      env: serverEnvironment(serverState),
      stdio: ["ignore", "pipe", "ignore"],
    })
    origin = await serverOrigin(server)
    await expect.poll(() => ownedServerReady(server, origin), { timeout: 30_000 }).toBe(true)
    browser = await launchBrowser()
  } catch (cause) {
    await cleanup()
    throw cause
  }
})

test.afterAll(cleanup)

async function cleanup() {
  try {
    await browser?.close()
  } finally {
    await stopServer(server)

    if (serverState) await rm(serverState, { recursive: true, force: true })
  }
}

async function createServerState() {
  if (!process.env.OPENCODE_ARCHIVE_E2E_ARTIFACTS) await mkdir(artifactRoot, { recursive: true })

  const debugRoot = await realpath(path.join(repo, ".debug"))
  const requestedRoot = path.resolve(artifactRoot)
  const resolvedRoot = await realpath(requestedRoot)
  const rootStat = await lstat(requestedRoot)

  if (
    rootStat.isSymbolicLink() ||
    !rootStat.isDirectory() ||
    resolvedRoot === debugRoot ||
    !resolvedRoot.startsWith(`${debugRoot}${path.sep}`)
  )
    throw new Error("OPENCODE_ARCHIVE_E2E_ARTIFACTS must be a non-symlink directory below .debug")

  return mkdtemp(path.join(resolvedRoot, "compiled-serve-"))
}

function serverEnvironment(state: string) {
  return {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: path.join(state, "server-home"),
    XDG_DATA_HOME: path.join(state, "server-state"),
    XDG_CONFIG_HOME: path.join(state, "server-config"),
    XDG_CACHE_HOME: path.join(state, "server-cache"),
    XDG_STATE_HOME: path.join(state, "server-state"),
    XDG_RUNTIME_DIR: path.join(state, "server-runtime"),
    TMPDIR: path.join(state, "server-tmp"),
    OPENCODE_CONFIG_DIR: path.join(state, "server-config", "opencode"),
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DB: path.join(state, "server-state", "opencode.db"),
    OPENCODE_PASSWORD: password,
    LANG: "C.UTF-8",
  }
}

async function serverOrigin(child: ChildProcess) {
  return new Promise<string>((resolve, reject) => {
    const timeout = AbortSignal.timeout(30_000)
    let output = ""

    const finish = (callback: () => void) => {
      child.stdout?.off("data", onData)
      child.off("error", onError)
      child.off("exit", onExit)
      timeout.removeEventListener("abort", onTimeout)
      callback()
    }

    const onData = (chunk: Buffer) => {
      output += chunk.toString()

      const match = output.match(/server listening on (http:\/\/\S+)/)

      if (!match) return

      const url = new URL(match[1])

      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/")
        return finish(() => reject(new Error("Compiled server announced a non-loopback URL")))

      finish(() => resolve(url.origin))
    }

    const onError = (cause: Error) => finish(() => reject(cause))

    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(() => reject(new Error(`Compiled server exited before listening (${code ?? signal ?? "unknown"})`)))

    const onTimeout = () => finish(() => reject(new Error("Compiled server did not announce a listener")))

    child.stdout?.on("data", onData)
    child.once("error", onError)
    child.once("exit", onExit)
    timeout.addEventListener("abort", onTimeout, { once: true })
  })
}

async function ownedServerReady(child: ChildProcess, url: string) {
  const response = await fetch(new URL("/api/info", url), {
    headers: { Authorization: authorization },
    signal: AbortSignal.timeout(1_000),
  }).catch(() => undefined)

  if (!response?.ok) return false

  const info = await Schema.decodeUnknownPromise(ServerIdentity)(await response.json()).catch(() => undefined)

  return info?.pid === child.pid
}

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    chromiumSandbox: false,
    executablePath,
    env: {
      HOME: path.join(browserRuntime, "home"),
      TMPDIR: path.join(browserRuntime, "tmp"),
      XDG_CACHE_HOME: path.join(browserRuntime, "home", ".cache"),
      XDG_CONFIG_HOME: path.join(browserRuntime, "home", ".config"),
      XDG_RUNTIME_DIR: path.join(browserRuntime, "runtime"),
      FONTCONFIG_FILE: path.join(browserRuntime, "fontconfig", "fonts.conf"),
      FONTCONFIG_PATH: path.join(browserRuntime, "fontconfig"),
      LD_LIBRARY_PATH: path.join(browserRuntime, "libs", "usr", "lib", "x86_64-linux-gnu"),
      LANG: "C.UTF-8",
    },
  })
}

async function stopServer(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return

  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  child.kill("SIGTERM")

  if (await exitsWithin(exited, 5_000)) return

  child.kill("SIGKILL")

  if (!(await exitsWithin(exited, 5_000))) throw new Error("Compiled server did not exit after SIGKILL")
}

async function exitsWithin(exited: Promise<void>, milliseconds: number) {
  const timeout = AbortSignal.timeout(milliseconds)

  return Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => timeout.addEventListener("abort", () => resolve(false), { once: true })),
  ])
}

test.beforeEach(async () => {
  context = await browser.newContext({
    locale: "es-ES",
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: "block",
  })
  await context.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue()

    return route.abort("blockedbyclient")
  })
  page = await context.newPage()
  await connect(page)
})

test.afterEach(async () => context.close())

test("uses archived time and an untitled label in rendered Spanish rows", async () => {
  const archived = {
    id: `ses_archive_${randomUUID().replaceAll("-", "")}`,
    title: "",
    directory: "/workspace/" + "directory-with-a-deliberately-long-name/".repeat(12),
    archived: Date.now() - 2 * 24 * 60 * 60 * 1000,
    updated: Date.now(),
  }

  await mockArchivedPage(page, [archived])

  const dialog = await openArchivedSessions(page)
  const row = dialog.locator('[data-slot="list-item"]')

  await expect(row).toContainText("Nueva sesión")
})

test("uses archived rather than updated time for a visible localized timestamp", async () => {
  const archived = {
    id: `ses_archive_${randomUUID().replaceAll("-", "")}`,
    title: "Archived timestamp source",
    directory: "/workspace/archive-time",
    archived: Date.now() - 2 * 24 * 60 * 60 * 1000,
    updated: Date.now(),
  }

  await mockArchivedPage(page, [archived])

  const dialog = await openArchivedSessions(page)
  const row = dialog.locator('[data-slot="list-item"]')

  await expect(row).toContainText("hace 2 d")
  await expect(row).not.toContainText("Justo ahora")
})

test("keeps the archived list inset and its row contents within narrow and desktop dialogs", async () => {
  const archived = {
    id: `ses_archive_${randomUUID().replaceAll("-", "")}`,
    title: "Archived session with a sufficiently descriptive title",
    directory: "/workspace/" + "overflow-sensitive-directory/".repeat(16),
    archived: Date.now() - 2 * 24 * 60 * 60 * 1000,
  }

  await mockArchivedPage(page, [archived])

  const dialog = await openArchivedSessions(page)
  const row = dialog.locator('[data-slot="list-item"]').filter({ hasText: archived.title })

  for (const width of [320, 375, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(row).toBeVisible()

    const geometry = await row.evaluate((element) => {
      const row = element.getBoundingClientRect()
      const dialog = element.closest('[role="dialog"]')!.getBoundingClientRect()
      const overflow = document.documentElement.scrollWidth > document.documentElement.clientWidth

      return { inset: row.left - dialog.left, right: dialog.right - row.right, overflow }
    })

    expect(geometry.inset).toBeGreaterThanOrEqual(12)
    expect(geometry.right).toBeGreaterThanOrEqual(12)
    expect(geometry.overflow).toBe(false)
  }
})

test("aligns archived-session icon, text, and date as a left-led list row at every viewport", async () => {
  const archived = [
    {
      id: `ses_archive_${randomUUID().replaceAll("-", "")}`,
      title: "Short archive",
      directory: "/workspace/short",
      archived: Date.now() - 2 * 24 * 60 * 60 * 1000,
    },
    {
      id: `ses_archive_${randomUUID().replaceAll("-", "")}`,
      title:
        "An intentionally long archived session title that must truncate instead of centering or pushing the date away",
      directory: "/workspace/" + "long-directory-segment/".repeat(18),
      archived: Date.now() - 2 * 24 * 60 * 60 * 1000,
    },
  ]

  await mockArchivedPage(page, archived)

  const dialog = await openArchivedSessions(page)
  const rows = archived.map((session) => dialog.locator(`[data-slot="list-item"][data-key="${session.id}"]`))

  for (const row of rows) await expect(row).toBeVisible()

  const measurements = []

  for (const width of [1440, 375, 320]) {
    await page.setViewportSize({ width, height: 900 })
    measurements.push(
      await Promise.all(
        rows.map((row, index) =>
          row.evaluate((element, session) => {
            const leaf = (value: string) =>
              [...element.querySelectorAll<HTMLElement>("span")].find(
                (candidate) =>
                  candidate.textContent === value &&
                  ![...candidate.children].some((child) => child.textContent === value),
              )

            const box = (target: HTMLElement | SVGElement | undefined) => {
              if (!target)
                return { bottom: Number.NaN, left: Number.NaN, present: false, right: Number.NaN, top: Number.NaN }

              const { bottom, left, right, top } = target.getBoundingClientRect()

              return { bottom, left, present: true, right, top }
            }

            const title = leaf(session.title)!

            const directory = leaf(session.directory)!

            const time = [...element.querySelectorAll<HTMLElement>("span")].find((candidate) =>
              /^hace \d+ d$/.test(candidate.textContent ?? ""),
            )!

            const row = element.getBoundingClientRect()

            return {
              row: { left: row.left, right: row.right },
              icon: box(element.querySelector<SVGElement>('svg[aria-hidden="true"]') ?? undefined),
              title: {
                ...box(title),
                textAlign: getComputedStyle(title).textAlign,
                truncated: title.scrollWidth > title.clientWidth,
              },
              directory: {
                ...box(directory),
                textAlign: getComputedStyle(directory).textAlign,
                truncated: directory.scrollWidth > directory.clientWidth,
              },
              time: box(time),
              overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            }
          }, archived[index]),
        ),
      ),
    )
  }

  // Keep the failing current-layout evidence after all geometry probes, even when an assertion below fails.
  await page.screenshot({ path: path.join(artifactRoot, "baseline-centered-current.png"), fullPage: true })

  const [desktop, mobile375, mobile320] = measurements
  const violations: string[] = []

  for (const [index, viewport] of measurements.entries()) {
    const label = ["desktop", "mobile-375", "mobile-320"][index]

    if (viewport.length !== archived.length) violations.push(`${label}: missing archived rows`)

    if (!viewport.every((row) => row.icon.present && row.icon.left < row.title.left))
      violations.push(`${label}: missing left icon`)

    if (!viewport.every((row) => row.title.textAlign === "start" && row.directory.textAlign === "start")) {
      violations.push(`${label}: centered text (${viewport.map((row) => row.title.textAlign).join(", ")})`)
    }

    if (!viewport.every((row) => !row.overflow)) violations.push(`${label}: viewport overflow`)
  }

  if (Math.abs(desktop[0].title.left - desktop[1].title.left) > 1) violations.push("desktop: title left edges differ")

  if (!desktop.every((row) => Math.abs(row.title.top - row.directory.top) <= 4)) {
    violations.push("desktop: title and directory are stacked")
  }

  if (!desktop.every((row) => Math.abs(row.title.top - row.time.top) <= 8)) {
    violations.push("desktop: date is not on the text row")
  }

  if (!desktop.every((row) => row.time.left >= row.directory.right && row.time.right <= row.row.right)) {
    violations.push("desktop: date is not fixed right of text")
  }

  if (Math.abs(desktop[0].time.right - desktop[1].time.right) > 1) violations.push("desktop: date right edges differ")

  for (const mobile of [mobile375, mobile320]) {
    const label = mobile === mobile375 ? "mobile-375" : "mobile-320"

    if (!mobile.every((row) => row.title.bottom <= row.directory.top))
      violations.push(`${label}: title/path do not stack`)

    if (!mobile.every((row) => row.directory.left === row.title.left))
      violations.push(`${label}: title/path left edges differ`)

    if (!mobile.every((row) => row.time.left >= row.directory.right && row.time.right <= row.row.right)) {
      violations.push(`${label}: date is centered or overlaps text`)
    }

    if (Math.abs(mobile[0].time.right - mobile[1].time.right) > 1) violations.push(`${label}: date right edges differ`)

    if (!mobile[1].title.truncated || !mobile[1].directory.truncated)
      violations.push(`${label}: long text does not truncate`)
  }

  expect(violations).toEqual([])
})

test("keeps title and directory legible when an unbroken title competes for desktop row space", async () => {
  const archived = {
    id: `ses_archive_${randomUUID().replaceAll("-", "")}`,
    title: `Archived${"\u00a0title".repeat(40)}`,
    directory: "/workspace/" + "nonempty-directory-segment/".repeat(12),
    archived: Date.now() - 2 * 24 * 60 * 60 * 1000,
  }

  await page.setViewportSize({ width: 1440, height: 900 })
  await mockArchivedPage(page, [archived])

  const dialog = await openArchivedSessions(page)
  const row = dialog.locator(`[data-slot="list-item"][data-key="${archived.id}"]`)
  await expect(row).toBeVisible()

  const geometry = await row.evaluate((element, session) => {
    const leaf = (value: string) =>
      [...element.querySelectorAll<HTMLElement>("span")].find(
        (candidate) =>
          candidate.textContent === value && ![...candidate.children].some((child) => child.textContent === value),
      )!

    const title = leaf(session.title)

    const directory = leaf(session.directory)

    const time = [...element.querySelectorAll<HTMLElement>("span")].find((candidate) =>
      /^hace \d+ d$/.test(candidate.textContent ?? ""),
    )!

    const icon = element.querySelector<SVGElement>('svg[aria-hidden="true"]')!

    const box = (target: Element) => {
      const { bottom, left, right, top, width } = target.getBoundingClientRect()

      return { bottom, left, right, top, width }
    }

    return {
      date: box(time),
      directory: { ...box(directory), truncated: directory.scrollWidth > directory.clientWidth },
      icon: box(icon),
      row: box(element),
      title: { ...box(title), truncated: title.scrollWidth > title.clientWidth },
    }
  }, archived)

  // 48px is the minimum useful allocation for a path fragment, not a proportional layout target.
  expect(geometry.title.width).toBeGreaterThanOrEqual(48)
  expect(
    geometry.directory.width,
    `title=${geometry.title.width}px directory=${geometry.directory.width}px`,
  ).toBeGreaterThanOrEqual(48)
  expect(geometry.title.truncated).toBe(true)
  expect(geometry.directory.truncated).toBe(true)
  expect(geometry.icon.left).toBeLessThan(geometry.title.left)
  expect(geometry.title.right).toBeLessThanOrEqual(geometry.directory.left)
  expect(geometry.directory.right).toBeLessThanOrEqual(geometry.date.left)
  expect(geometry.date.right).toBeLessThanOrEqual(geometry.row.right)
})

test("retains epoch-zero rows without a fabricated archived date", async () => {
  const archived = {
    id: `ses_archive_${randomUUID().replaceAll("-", "")}`,
    title: "Epoch zero archive",
    directory: "/workspace/epoch-zero",
    archived: 0,
  }

  await mockArchivedPage(page, [archived])

  const dialog = await openArchivedSessions(page)
  const row = dialog.locator('[data-slot="list-item"]').filter({ hasText: archived.title })

  await expect(row).toBeVisible()
  await expect(row).not.toContainText(/hace \d+ [mhd]/)
})

test("restores the keyboard-selected real archived session while search and pager remain available", async () => {
  const session = await createSession(page, "Keyboard restore archive")
  await openSession(page, session.id, session.title)
  await archiveThroughMenu(page, session.id)

  let dialog = await openArchivedSessions(page)
  const search = dialog.getByPlaceholder("Buscar en esta página")
  await expect(search).toBeFocused()
  await search.press("Escape")
  await expect(dialog).toBeHidden()

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator('[data-component="composer-editor"]')).toBeEditable()
  dialog = await openArchivedSessions(page)
  const reopenedSearch = dialog.getByPlaceholder("Buscar en esta página")
  await expect(reopenedSearch).toBeFocused()
  await expect(reopenedSearch).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Página anterior" })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Página siguiente" })).toBeVisible()
  await reopenedSearch.fill("Keyboard restore archive")

  const row = dialog.locator('[data-slot="list-item"]').filter({ hasText: session.title })
  await reopenedSearch.press("ArrowDown")
  await expect(row).toHaveAttribute("data-active", "true")
  await reopenedSearch.press("Enter")
  await expect(page).toHaveURL(new RegExp(`/session/${session.id}$`))
  await expect(dialog).toBeHidden()
  await expect.poll(async () => (await getSession(page, session.id)).time?.archived ?? null).toBeNull()
})

async function connect(page: Page) {
  await page.goto(origin, { waitUntil: "domcontentloaded" })
  await page.locator("#server-connect-link").click()
  await page.locator('[data-component="server-connect-method"] button').click()
  await page.locator("#server-connect-url").fill(origin)
  await page.locator("#server-connect-password").fill(password)
  await page.locator('[data-component="connect-server"] button[type="submit"]').click()
  await expect(page.locator('[data-component="connect-server"]')).toBeHidden()
}

async function createSession(page: Page, title: string, directory = path.join(serverState, "workspace")) {
  return page.evaluate(
    async ({ authorization, title, directory }) => {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: {
          Authorization: authorization,
          "content-type": "application/json",
        },
        body: JSON.stringify({ title, location: { directory } }),
      })

      const payload = await response.json()

      return payload.data ?? payload
    },
    { authorization, title, directory },
  )
}

async function openSession(page: Page, id: string, title: string) {
  await page.goto(origin, { waitUntil: "domcontentloaded" })
  await page.locator('[data-component="home-session-row"]').filter({ hasText: title }).click()
  await expect(page).toHaveURL(new RegExp(`/session/${id}$`))
  await expect(page.locator('[data-component="composer-editor"]')).toBeEditable()
}

async function archiveThroughMenu(page: Page, sessionID: string) {
  const trigger = page.locator("[data-session-title]").getByRole("button", { name: /opciones|more options/i })
  await trigger.click()
  await page.locator(".session-options-menu").getByRole("menuitem", { name: "Archivar", exact: true }).click()
  await expect(page).not.toHaveURL(new RegExp(`/session/${sessionID}$`))
}

async function openArchivedSessions(page: Page) {
  if (!new URL(page.url()).pathname.includes("/session/")) {
    const session = await createSession(page, `archive-command-host-${randomUUID()}`)
    await openSession(page, session.id, session.title)
  }

  await page.keyboard.press("ControlOrMeta+Shift+P")
  const palette = page.locator(".command-palette")
  await expect(palette).toBeVisible()
  await palette.locator("input").fill("archi")
  await palette.getByText("Explorar sesiones archivadas", { exact: true }).click()
  await expect(palette).toBeHidden()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()

  return dialog
}

async function getSession(page: Page, id: string) {
  return page.evaluate(
    async ({ authorization, id }) => {
      const response = await fetch(`/api/session/${id}`, { headers: { Authorization: authorization } })

      return (await response.json()).data
    },
    { authorization, id },
  )
}

async function mockArchivedPage(
  page: Page,
  sessions: Array<{ id: string; title: string; directory: string; archived: number; updated?: number }>,
) {
  await page.route(
    (url) => url.pathname === "/api/session" && url.searchParams.get("archived") === "only",
    async (route) => {
      return route.fulfill({
        json: {
          data: sessions.map((session) => ({
            id: session.id,
            title: session.title,
            location: { directory: session.directory },
            time: { archived: session.archived, updated: session.updated ?? session.archived },
          })),
          cursor: {},
        },
      })
    },
  )
}
