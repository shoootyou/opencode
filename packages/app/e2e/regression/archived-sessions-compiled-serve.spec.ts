/**
 * @spec-handoff
 * @interface compiledArchivedSessionsDialog(binaryPath: string): Promise<void>
 * @behavior
 *   - Shows each archived row's real title (or the localized untitled label), truncated directory, and relative archived time.
 *   - Keeps rows inset by 12px and readable without horizontal overflow at 320px, 375px, and desktop widths.
 *   - Renders a decorative native session icon, start-aligned title/path text, and an independently right-aligned date.
 *   - Keeps icon, title, directory, and date on one desktop row; narrow rows stack only title/path in the left column.
 *   - Restores the keyboard-selected archived session from a continuous loaded-only list.
 *   - Keeps the actual list scroller and bottom Load more/Retry actions keyboard reachable.
 * @edge-cases
 *   - A timestamp of 0 remains a row but intentionally has no date.
 *   - The displayed date derives from time.archived, not time.updated or time.created.
 *   - Long titles and directories truncate without viewport overflow while the date remains a separate right column.
 *   - An extremely long unbroken title cannot collapse a non-empty directory below a readable 48px allocation.
 * @edge-cases
 *   - Programmatic scroll alone never requests continuation; one native downward wheel at threshold requests one cursor.
 *   - A non-scrolling ArrowDown expires its keyboard demand, so later programmatic movement cannot load more.
 *   - Upward wrapping preserves list navigation but cannot spend stale keyboard demand to load more.
 *   - A stale far-from-bottom wheel demand, deferred underfill, and stale continuation focus cannot affect later actions.
 *   - Appending preserves connected row nodes, native row focus, active selection, and scroll position.
 * @rerun OPENCODE_COMPILED_BINARY=packages/cli/dist/cli-linux-x64/bin/opencode bun run test:e2e -- e2e/regression/archived-sessions-compiled-serve.spec.ts
 * @see ./dialog-archived-sessions.tsx
 */
// oxlint-disable anti-slop/require-readable-spacing -- SAFETY: the deterministic multi-batch fixture keeps each network-response branch adjacent to its request-count assertion.
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
  await expect(
    dialog.getByText(
      "Selecciona una sesión para restaurarla y abrir su pestaña. La búsqueda solo incluye las sesiones cargadas; desplázate hacia abajo o carga más para explorar sesiones anteriores.",
      { exact: true },
    ),
  ).toBeVisible()
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

test("restores the keyboard-selected real archived session while loaded-only search remains available", async () => {
  const session = await createSession(page, "Keyboard restore archive")
  await openSession(page, session.id, session.title)
  await archiveThroughMenu(page, session.id)

  let dialog = await openArchivedSessions(page)
  const search = dialog.getByPlaceholder("Buscar")
  await expect(search).toBeFocused()
  await search.press("Escape")
  await expect(dialog).toBeHidden()

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator('[data-component="composer-editor"]')).toBeEditable()
  dialog = await openArchivedSessions(page)
  const reopenedSearch = dialog.getByPlaceholder("Buscar")
  await expect(reopenedSearch).toBeFocused()
  await expect(reopenedSearch).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Página anterior" })).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: "Página siguiente" })).toHaveCount(0)
  await reopenedSearch.fill("Keyboard restore archive")

  const row = dialog.locator('[data-slot="list-item"]').filter({ hasText: session.title })
  await reopenedSearch.press("ArrowDown")
  await expect(row).toHaveAttribute("data-active", "true")
  await reopenedSearch.press("Enter")
  await expect(page).toHaveURL(new RegExp(`/session/${session.id}$`))
  await expect(dialog).toBeHidden()
  await expect.poll(async () => (await getSession(page, session.id)).time?.archived ?? null).toBeNull()
})

test("keeps a bounded continuous archive list: programmatic movement cannot demand but one native wheel appends exactly one cursor", async () => {
  const archives = Array.from({ length: 52 }, (_, index) => ({
    id: `ses_archive_${String(index).padStart(3, "0")}`,
    title: `Archived ${index}`,
    directory: `/workspace/archive-${index}`,
    archived: Date.now() - index * 1_000,
  }))
  const firstContinuation = Promise.withResolvers<void>()
  const secondContinuation = Promise.withResolvers<void>()
  const cursors: Array<string | null> = []

  await page.route(
    (url) => url.pathname === "/api/session" && url.searchParams.get("archived") === "true",
    async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor")
      cursors.push(cursor)
      if (!cursor)
        return route.fulfill({
          json: { data: archives.slice(0, 50).map(toArchivedApiRow), cursor: { next: "cursor-2" } },
        })
      if (cursor === "cursor-2") {
        await firstContinuation.promise
        return route.fulfill({
          json: { data: archives.slice(50, 51).map(toArchivedApiRow), cursor: { next: "cursor-3" } },
        })
      }
      await secondContinuation.promise
      return route.fulfill({ json: { data: archives.slice(51).map(toArchivedApiRow), cursor: {} } })
    },
  )

  const dialog = await openArchivedSessions(page)
  const scroller = dialog.locator('[data-slot="list-scroll"]')
  await expect(scroller).toBeVisible()
  await expect(dialog.getByRole("button", { name: /cargar más/i })).toBeVisible()
  expect(cursors).toEqual([null])

  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight
    element.dispatchEvent(new Event("scroll", { bubbles: true }))
  })
  await expect.poll(() => cursors).toEqual([null])
  await page.evaluate(() => window.dispatchEvent(new Event("resize")))
  await dialog.getByPlaceholder("Buscar").fill("not-loaded")
  await dialog.getByPlaceholder("Buscar").fill("")
  await expect.poll(() => cursors).toEqual([null])

  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight
    element.dispatchEvent(new Event("scroll", { bubbles: true }))
  })
  await expect.poll(() => cursors).toEqual([null])

  await scroller.hover()
  await page.mouse.wheel(0, 800)
  await expect.poll(() => cursors).toEqual([null, "cursor-2"])
  await page.mouse.wheel(0, 800)
  await expect.poll(() => cursors).toEqual([null, "cursor-2"])
  firstContinuation.resolve()
  await expect(dialog.locator('[data-slot="list-item"][data-key="ses_archive_050"]')).toBeVisible()
  await expect.poll(() => cursors).toEqual([null, "cursor-2"])
  await page.mouse.wheel(0, 800)
  await expect.poll(() => cursors).toEqual([null, "cursor-2", "cursor-3"])
  secondContinuation.resolve()
  await expect(dialog.locator('[data-slot="list-item"][data-key="ses_archive_051"]')).toBeVisible()
  await expect.poll(() => cursors).toEqual([null, "cursor-2", "cursor-3"])
})

test("does not spend a far-from-bottom native wheel demand after later programmatic movement", async () => {
  const archives = Array.from({ length: 51 }, (_, index) => ({
    id: `ses_archive_stale_wheel_${String(index).padStart(3, "0")}`,
    title: `Stale wheel ${index}`,
    directory: `/workspace/stale-wheel-${index}`,
    archived: Date.now() - index,
  }))
  const cursors: Array<string | null> = []
  await page.route(
    (url) => url.pathname === "/api/session" && url.searchParams.get("archived") === "true",
    async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor")
      cursors.push(cursor)
      return route.fulfill({
        json: {
          data: (cursor ? archives.slice(50) : archives.slice(0, 50)).map(toArchivedApiRow),
          cursor: cursor ? {} : { next: "cursor-2" },
        },
      })
    },
  )

  const dialog = await openArchivedSessions(page)
  const scroller = dialog.locator('[data-slot="list-scroll"]')
  await expect(scroller).toBeVisible()
  await scroller.hover()
  await page.mouse.wheel(0, 1)
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
    .toBeGreaterThan(96)
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight
    element.dispatchEvent(new Event("scroll", { bubbles: true }))
  })
  await expect.poll(() => cursors).toEqual([null])
})

test("does not let upward wrapping spend stale keyboard demand after non-scrolling list navigation", async () => {
  const archives = Array.from({ length: 51 }, (_, index) => ({
    id: `ses_archive_keyboard_wrap_${String(index).padStart(3, "0")}`,
    title: `Keyboard wrap ${index}`,
    directory: `/workspace/keyboard-wrap-${index}`,
    archived: Date.now() - index,
  }))
  const cursors: Array<string | null> = []
  await page.route(
    (url) => url.pathname === "/api/session" && url.searchParams.get("archived") === "true",
    async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor")
      cursors.push(cursor)
      return route.fulfill({
        json: {
          data: (cursor ? archives.slice(50) : archives.slice(0, 50)).map(toArchivedApiRow),
          cursor: cursor ? {} : { next: "keyboard-wrap-next" },
        },
      })
    },
  )

  const dialog = await openArchivedSessions(page)
  const search = dialog.getByPlaceholder("Buscar")
  const scroller = dialog.locator('[data-slot="list-scroll"]')
  await expect(search).toBeFocused()
  await expect(dialog.locator('[data-slot="list-item"]')).toHaveCount(50)
  await expect(scroller).toHaveJSProperty("scrollTop", 0)
  const activeKey = await dialog.locator('[data-slot="list-item"][data-active="true"]').getAttribute("data-key")
  if (!activeKey) throw new Error("Expected the initial archived row to be active")
  const initial = dialog.locator(`[data-slot="list-item"][data-key="${activeKey}"]`)
  await expect(initial).toHaveAttribute("data-active", "true")

  await page.keyboard.press("ArrowDown")
  await expect(dialog.locator('[data-slot="list-item"][data-key="ses_archive_keyboard_wrap_001"]')).toHaveAttribute(
    "data-active",
    "true",
  )
  await expect(scroller).toHaveJSProperty("scrollTop", 0)
  await page.keyboard.press("ArrowUp")
  await expect(initial).toHaveAttribute("data-active", "true")
  await expect(scroller).toHaveJSProperty("scrollTop", 0)
  expect(cursors).toEqual([null])
  await page.keyboard.press("ArrowUp")
  await expect(dialog.locator('[data-slot="list-item"][data-key="ses_archive_keyboard_wrap_049"]')).toHaveAttribute(
    "data-active",
    "true",
  )
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )
  await expect.poll(() => cursors).toEqual([null])
})

test("expires non-scrolling ArrowDown demand before a later programmatic bottom scroll", async () => {
  const archives = Array.from({ length: 51 }, (_, index) => ({
    id: `ses_archive_keyboard_expiry_${String(index).padStart(3, "0")}`,
    title: `Keyboard expiry ${index}`,
    directory: `/workspace/keyboard-expiry-${index}`,
    archived: Date.now() - index,
  }))
  const cursors: Array<string | null> = []
  await page.route(
    (url) => url.pathname === "/api/session" && url.searchParams.get("archived") === "true",
    async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor")
      cursors.push(cursor)
      return route.fulfill({
        json: {
          data: (cursor ? archives.slice(50) : archives.slice(0, 50)).map(toArchivedApiRow),
          cursor: cursor ? {} : { next: "keyboard-expiry-next" },
        },
      })
    },
  )

  const dialog = await openArchivedSessions(page)
  const search = dialog.getByPlaceholder("Buscar")
  const scroller = dialog.locator('[data-slot="list-scroll"]')
  await expect(search).toBeFocused()
  await expect(dialog.locator('[data-slot="list-item"]')).toHaveCount(50)
  await page.keyboard.press("ArrowDown")
  await expect(dialog.locator('[data-slot="list-item"][data-key="ses_archive_keyboard_expiry_001"]')).toHaveAttribute(
    "data-active",
    "true",
  )
  await expect(scroller).toHaveJSProperty("scrollTop", 0)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight
    element.dispatchEvent(new Event("scroll", { bubbles: true }))
  })
  await expect.poll(() => cursors).toEqual([null])
})

test("opens a 300-session history without draining cursor pages", async () => {
  const archives = Array.from({ length: 300 }, (_, index) => ({
    id: `ses_archive_bound_${String(index).padStart(3, "0")}`,
    title: `Bound ${index}`,
    directory: `/workspace/bound-${index}`,
    archived: Date.now() - index,
  }))
  const cursors: Array<string | null> = []
  await page.route(
    (url) => url.pathname === "/api/session" && url.searchParams.get("archived") === "true",
    async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor")
      cursors.push(cursor)
      const offset = cursor ? Number(cursor) : 0
      return route.fulfill({
        json: {
          data: archives.slice(offset, offset + 50).map(toArchivedApiRow),
          cursor: offset + 50 < archives.length ? { next: String(offset + 50) } : {},
        },
      })
    },
  )

  const dialog = await openArchivedSessions(page)
  await expect(dialog.locator('[data-slot="list-item"][data-key="ses_archive_bound_049"]')).toBeVisible()
  await expect.poll(() => cursors).toEqual([null])
})

test("uses one initial underfill probe, keeps a short cursor-bearing batch continuable, and never chains a third request", async () => {
  const short = [
    { id: "ses_archive_short_1", title: "Short first", directory: "/workspace/short-1", archived: Date.now() },
    { id: "ses_archive_short_2", title: "Short second", directory: "/workspace/short-2", archived: Date.now() - 1 },
  ]
  const cursors: Array<string | null> = []
  await page.route(
    (url) => url.pathname === "/api/session" && url.searchParams.get("archived") === "true",
    async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor")
      cursors.push(cursor)
      if (cursors.length === 1)
        return route.fulfill({ json: { data: short.map(toArchivedApiRow), cursor: { next: "cursor-2" } } })
      if (cursors.length === 2)
        return route.fulfill({
          json: {
            data: [
              toArchivedApiRow({
                id: "ses_archive_third",
                title: "Third",
                directory: "/workspace/third",
                archived: Date.now() - 2,
              }),
            ],
            cursor: { next: "cursor-3" },
          },
        })
      return route.fulfill({ json: { data: [], cursor: {} } })
    },
  )

  const dialog = await openArchivedSessions(page)
  await expect(dialog.getByText("Short first", { exact: true })).toBeVisible()
  await expect.poll(() => cursors).toEqual([null, "cursor-2"])
  await expect(dialog.getByText("Short second", { exact: true })).toBeVisible()
  await expect(dialog.getByRole("button", { name: /cargar más/i })).toBeVisible()
  await expect.poll(() => cursors).toEqual([null, "cursor-2"])
  await dialog.getByRole("button", { name: /cargar más/i }).press("Enter")
  await expect(dialog.getByText("Third", { exact: true })).toBeVisible()
  await expect.poll(() => cursors).toEqual([null, "cursor-2", "cursor-3"])
})

test("does not defer initial underfill when a query is active before the first short batch commits", async () => {
  const initial = Promise.withResolvers<void>()
  const cursors: Array<string | null> = []
  await page.route(
    (url) => url.pathname === "/api/session" && url.searchParams.get("archived") === "true",
    async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor")
      cursors.push(cursor)
      if (!cursor) {
        await initial.promise
        return route.fulfill({
          json: {
            data: [
              toArchivedApiRow({
                id: "ses_archive_query_first",
                title: "Matching first",
                directory: "/workspace/first",
                archived: Date.now(),
              }),
              toArchivedApiRow({
                id: "ses_archive_query_second",
                title: "Matching second",
                directory: "/workspace/second",
                archived: Date.now() - 1,
              }),
            ],
            cursor: { next: "cursor-2" },
          },
        })
      }
      return route.fulfill({ json: { data: [], cursor: {} } })
    },
  )

  const dialog = await openArchivedSessions(page)
  const search = dialog.getByPlaceholder("Buscar")
  await search.fill("Matching")
  initial.resolve()
  await expect(dialog.getByText("Matching first", { exact: true })).toBeVisible()
  expect(cursors).toEqual([null])
  await search.fill("")
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  expect(cursors).toEqual([null])
})

test("preserves connected archive group and row nodes, native focus, active selection, and scroll across failure and retry", async () => {
  const archives = Array.from({ length: 51 }, (_, index) => ({
    id: `ses_archive_identity_${index}`,
    title: `Identity ${index}`,
    directory: `/workspace/identity-${index}`,
    archived: Date.now() - index,
  }))
  let continuationRequests = 0
  await page.route(
    (url) => url.pathname === "/api/session" && url.searchParams.get("archived") === "true",
    async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor")
      if (cursor) continuationRequests++
      if (continuationRequests === 1) return route.abort("failed")
      return route.fulfill({
        json: {
          data: (cursor ? archives.slice(50) : archives.slice(0, 50)).map(toArchivedApiRow),
          cursor: cursor ? {} : { next: "identity-next" },
        },
      })
    },
  )

  const dialog = await openArchivedSessions(page)
  const row = dialog.locator('[data-slot="list-item"][data-key="ses_archive_identity_49"]')
  const scroller = dialog.locator('[data-slot="list-scroll"]')
  await row.focus()
  const group = row.locator("xpath=../..")
  await scroller.evaluate((node) => (node.scrollTop = node.scrollHeight))
  const scrollTop = await scroller.evaluate((node) => node.scrollTop)
  const rowHandle = await row.elementHandle()
  const groupHandle = await group.elementHandle()
  await row.evaluate((node) => {
    const original = node.focus.bind(node)
    let calls = 0
    Object.defineProperty(node, "focus", {
      configurable: true,
      value: (...args: Parameters<HTMLElement["focus"]>) => {
        calls++
        return original(...args)
      },
    })
    Object.defineProperty(node, "archiveFocusCalls", { configurable: true, get: () => calls })
  })
  await expect(row).toBeFocused()
  await scroller.hover()
  const activeKey = await dialog.locator('[data-slot="list-item"][data-active="true"]').getAttribute("data-key")
  if (!activeKey) throw new Error("Expected one active archived session")
  const active = dialog.locator(`[data-slot="list-item"][data-key="${activeKey}"]`)
  await page.mouse.wheel(0, 800)
  const retry = dialog.getByRole("button", { name: "Try again" })
  await expect(retry).toBeVisible()
  await expect(dialog.getByRole("status")).toContainText("No se pudieron cargar las sesiones archivadas")

  for (const handle of [rowHandle, groupHandle]) expect(await handle?.evaluate((node) => node.isConnected)).toBe(true)
  // SAFETY: this test-owned property counts only forced focus calls on the retained native row.
  expect(
    await rowHandle?.evaluate((node) => (node as HTMLElement & { archiveFocusCalls: number }).archiveFocusCalls),
  ).toBe(0)
  await expect(row).toBeFocused()
  await expect(active).toHaveAttribute("data-active", "true")
  await expect(scroller).toHaveJSProperty("scrollTop", scrollTop)

  const focusableCount = await dialog.locator("button:not([disabled]), input:not([disabled]), [href]").count()
  for (let index = 0; index <= focusableCount; index++) {
    if (await retry.evaluate((node) => node === document.activeElement)) break
    await page.keyboard.press("Tab")
  }
  await expect(retry).toBeFocused()
  const scrollBeforeRetry = await scroller.evaluate((node) => node.scrollTop)
  await page.keyboard.press("Enter")
  await expect(dialog.locator('[data-slot="list-item"][data-key="ses_archive_identity_50"]')).toBeVisible()
  await expect(dialog.getByRole("status")).toHaveCount(0)

  expect(await rowHandle?.evaluate((node) => node.isConnected)).toBe(true)
  expect(await groupHandle?.evaluate((node) => node.isConnected)).toBe(true)
  expect(
    await rowHandle?.evaluate((node) => node === document.querySelector('[data-key="ses_archive_identity_49"]')),
  ).toBe(true)
  expect(await groupHandle?.evaluate((node) => node === document.querySelector('[data-slot="list-group"]'))).toBe(true)
  // SAFETY: this test-owned property remains on the same retained native row after Retry appends.
  expect(
    await rowHandle?.evaluate((node) => (node as HTMLElement & { archiveFocusCalls: number }).archiveFocusCalls),
  ).toBe(0)
  await expect(dialog.getByPlaceholder("Buscar")).toBeFocused()
  await expect(active).toHaveAttribute("data-active", "true")
  await expect(scroller).toHaveJSProperty("scrollTop", scrollBeforeRetry)
})

for (const [action, key, userLeavesPendingAction] of [
  ["Load more", "Enter", false],
  ["Load more", " ", false],
  ["Retry", "Enter", false],
  ["Retry", " ", false],
  ["Load more", "Enter", true],
] as const) {
  test(`reaches ${action} by Tab and Shift+Tab and activates it once with ${key}${userLeavesPendingAction ? " without stealing user-moved focus" : ""}`, async () => {
    const continuation = Promise.withResolvers<void>()
    const cursors: Array<string | null> = []
    const expectedCursor = action === "Retry" ? "retry-cursor" : "load-cursor"
    await page.route(
      (url) => url.pathname === "/api/session" && url.searchParams.get("archived") === "true",
      async (route) => {
        const cursor = new URL(route.request().url()).searchParams.get("cursor")
        cursors.push(cursor)
        if (!cursor)
          return route.fulfill({
            json: {
              data: Array.from({ length: 50 }, (_, index) =>
                toArchivedApiRow({
                  id: `ses_archive_keyboard_${index}`,
                  title: `Keyboard ${index}`,
                  directory: `/workspace/keyboard-${index}`,
                  archived: Date.now() - index,
                }),
              ),
              cursor: { next: expectedCursor },
            },
          })
        if (action === "Retry" && cursors.length === 2) return route.abort("failed")
        await continuation.promise
        return route.fulfill({
          json: {
            data: [
              toArchivedApiRow({
                id: "ses_archive_keyboard_more",
                title: "Keyboard more",
                directory: "/workspace/keyboard-more",
                archived: Date.now() - 100,
              }),
            ],
            cursor: {},
          },
        })
      },
    )
    const dialog = await openArchivedSessions(page)
    const search = dialog.getByPlaceholder("Buscar")
    const loadMore = dialog.getByRole("button", { name: "Cargar más" })
    await expect(search).toBeFocused()
    const focusableCount = await dialog.locator("button:not([disabled]), input:not([disabled]), [href]").count()
    for (let index = 0; index <= focusableCount; index++) {
      if (await loadMore.evaluate((node) => node === document.activeElement)) break
      await page.keyboard.press("Tab")
    }
    await expect(loadMore).toBeFocused()

    if (action === "Retry") {
      await page.keyboard.press("Enter")
      await expect(dialog.getByRole("button", { name: "Try again" })).toBeVisible()
      await expect.poll(() => cursors).toEqual([null, "retry-cursor"])
    }

    const button = action === "Retry" ? dialog.getByRole("button", { name: "Try again" }) : loadMore
    for (let index = 0; index <= focusableCount; index++) {
      if (await button.evaluate((node) => node === document.activeElement)) break
      await page.keyboard.press("Tab")
    }
    await expect(button).toBeFocused()
    await page.keyboard.press("Tab")
    await page.keyboard.press("Shift+Tab")
    await expect(button).toBeFocused()
    const buttonHandle = await button.elementHandle()
    if (!buttonHandle) throw new Error("Expected continuation action handle")
    await page.keyboard.press(key)
    await expect
      .poll(() => cursors)
      .toEqual(action === "Retry" ? [null, "retry-cursor", "retry-cursor"] : [null, "load-cursor"])
    expect(await buttonHandle.evaluate((node) => node.isConnected)).toBe(true)
    expect(await buttonHandle.evaluate((node) => node === document.activeElement)).toBe(true)
    expect(
      await buttonHandle.evaluate(
        (node) => (node instanceof HTMLButtonElement && node.disabled) || node.getAttribute("aria-disabled") === "true",
      ),
    ).toBe(true)
    await page.keyboard.press(key)
    await expect
      .poll(() => cursors)
      .toEqual(action === "Retry" ? [null, "retry-cursor", "retry-cursor"] : [null, "load-cursor"])
    expect(await buttonHandle.evaluate((node) => node.isConnected && node === document.activeElement)).toBe(true)
    if (userLeavesPendingAction) {
      await page.keyboard.press("Tab")
      await expect(dialog.locator('[data-slot="dialog-close-button"]')).toBeFocused()
    }
    continuation.resolve()
    await expect(dialog.getByText("Keyboard more", { exact: true })).toBeVisible()
    if (userLeavesPendingAction) await expect(dialog.locator('[data-slot="dialog-close-button"]')).toBeFocused()
    else await expect(search).toBeFocused()
  })
}

test("does not recover stale load-more focus after the action settles, loses focus, and a later wheel exhausts", async () => {
  const cursors: Array<string | null> = []
  await page.route(
    (url) => url.pathname === "/api/session" && url.searchParams.get("archived") === "true",
    async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor")
      cursors.push(cursor)
      if (!cursor)
        return route.fulfill({
          json: {
            data: Array.from({ length: 50 }, (_, index) =>
              toArchivedApiRow({
                id: `ses_archive_settled_${index}`,
                title: `Settled ${index}`,
                directory: `/workspace/settled-${index}`,
                archived: Date.now() - index,
              }),
            ),
            cursor: { next: "cursor-2" },
          },
        })
      if (cursor === "cursor-2")
        return route.fulfill({
          json: {
            data: [
              toArchivedApiRow({
                id: "ses_archive_settled_more",
                title: "Settled more",
                directory: "/workspace/more",
                archived: Date.now() - 100,
              }),
            ],
            cursor: { next: "cursor-3" },
          },
        })
      return route.fulfill({
        json: {
          data: [
            toArchivedApiRow({
              id: "ses_archive_settled_last",
              title: "Settled last",
              directory: "/workspace/last",
              archived: Date.now() - 101,
            }),
          ],
          cursor: {},
        },
      })
    },
  )

  const dialog = await openArchivedSessions(page)
  const loadMore = dialog.getByRole("button", { name: "Cargar más" })
  const search = dialog.getByPlaceholder("Buscar")
  await expect(search).toBeVisible()
  await expect(search).toBeFocused()
  await expect(dialog.locator('[data-slot="list-item"]')).toHaveCount(50)
  await expect(loadMore).toBeVisible()
  await expect(loadMore).toBeEnabled()
  await expect(loadMore).not.toHaveAttribute("aria-disabled", "true")
  const focusableCount = await dialog.locator("button:not([disabled]), input:not([disabled]), [href]").count()
  for (let index = 0; index <= focusableCount; index++) {
    if (await loadMore.evaluate((node) => node === document.activeElement)) break
    await page.keyboard.press("Tab")
  }
  await expect(loadMore).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(dialog.getByText("Settled more", { exact: true })).toBeVisible()
  await expect(loadMore).toBeFocused()
  await page.keyboard.press("Tab")
  const close = dialog.locator('[data-slot="dialog-close-button"]')
  await expect(close).toBeFocused()

  const scroller = dialog.locator('[data-slot="list-scroll"]')
  await scroller.evaluate((element) => (element.scrollTop = element.scrollHeight))
  await scroller.hover()
  await page.mouse.wheel(0, 800)
  await expect(dialog.getByText("Settled last", { exact: true })).toBeVisible()
  await expect(close).toBeFocused()
  await expect(search).not.toBeFocused()
  expect(cursors).toEqual([null, "cursor-2", "cursor-3"])
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
    (url) => url.pathname === "/api/session" && url.searchParams.get("archived") === "true",
    async (route) => {
      return route.fulfill({
        json: {
          data: sessions.map(toArchivedApiRow),
          cursor: {},
        },
      })
    },
  )
}

function toArchivedApiRow(session: {
  id: string
  title: string
  directory: string
  archived: number
  updated?: number
}) {
  return {
    id: session.id,
    title: session.title,
    location: { directory: session.directory },
    time: { archived: session.archived, updated: session.updated ?? session.archived },
  }
}
