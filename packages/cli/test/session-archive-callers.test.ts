/**
 * @spec-handoff
 * @interface `opencode session list` and `opencode session export [session]`
 * @behavior
 *   - The session-list command requests active roots with archived:false.
 *   - The interactive export picker requests active roots with archived:false before exporting its selected ID.
 *   - Explicit-ID export reads that ID directly without applying an archive-state list filter.
 * @edge-cases
 *   - The interactive picker runs behind an isolated mocked prompt boundary that cannot leak into sibling tests.
 * @see ../src/commands/handlers/session/list.ts
 */
import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import path from "node:path"
type Result = { requests: string[]; prompts: Array<{ message: string; values: string[] }> }

const harness = `
import { expect, mock, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@opencode/util/global"
import { Effect, FileSystem, Option, Scope } from "effect"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const cliRoot = process.env.CLI_ROOT
if (!cliRoot) throw new Error("CLI_ROOT is required for the isolated session archive harness")
const { Config } = await import(pathToFileURL(path.join(cliRoot, "src/config/index.ts")).href)

const prompts = []
mock.module("@clack/prompts", () => ({
  autocomplete: async (input) => {
    prompts.push({ message: input.message, values: input.options.map((option) => option.value) })
    return "ses_active"
  },
  cancel() {}, intro() {}, isCancel: () => false, log: { error() {} }, outro() {},
}))

const session = (id) => ({ id, projectID: "project_fixture", title: id, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 2 }, location: { directory: "/fixture" } })
async function runHandler(effect) {
  const root = path.join(import.meta.dirname, ".tmp-session-archive-child-" + process.pid + "-" + crypto.randomUUID())
  const config = path.join(root, "config")
  const state = path.join(root, "state")
  await Promise.all([mkdir(config, { recursive: true }), mkdir(state, { recursive: true })])
  try { await Effect.runPromise(effect.pipe(Effect.provide(Config.layer), Effect.provide(Global.layerWith({ config, state })), Effect.provide(NodeFileSystem.layer), Effect.scoped)) }
  finally { await rm(root, { force: true, recursive: true }) }
}

test("isolated session archive caller", async () => {
  const requests = []
  const server = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url)
    requests.push(url.toString())
    if (url.pathname === "/api/info") return Response.json({ version: "2.1.4", pid: process.pid, urls: [] })
    if (url.pathname === "/api/location") return Response.json({ directory: "/fixture", project: { id: "project_fixture", directory: "/fixture", canonical: "/fixture" } })
    if (url.pathname === "/api/session") return Response.json({ data: [session("ses_active")], cursor: {} })
    if (url.pathname.endsWith("/export")) return Response.json({ id: url.pathname.split("/").at(-2) })
    return new Response(null, { status: 404 })
  }})
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
  try {
    const { default: listHandler } = await import(pathToFileURL(path.join(cliRoot, "src/commands/handlers/session/list.ts")).href)
    const { default: exportHandler } = await import(pathToFileURL(path.join(cliRoot, "src/commands/handlers/session/export.ts")).href)
    if (process.env.SCENARIO === "list") await runHandler(listHandler({ server: Option.some(server.url.toString()), standalone: false, maxCount: Option.some(1), format: "json" }))
    if (process.env.SCENARIO === "interactive") {
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true })
      await runHandler(exportHandler({ server: Option.some(server.url.toString()), standalone: false, session: Option.none(), sanitize: false }))
    }
    if (process.env.SCENARIO === "explicit") await runHandler(exportHandler({ server: Option.some(server.url.toString()), standalone: false, session: Option.some("ses_archived"), sanitize: false }))
    await Bun.write(process.env.RESULT_PATH, JSON.stringify({ requests, prompts }))
  } finally {
    if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor)
    else Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: undefined })
    server.stop(true)
  }
})
`

async function runScenario(scenario: "list" | "interactive" | "explicit"): Promise<Result> {
  const debugRoot = path.join(path.dirname(import.meta.dirname), ".debug")
  let root: string | undefined
  const allowed = ["HOME", "PATH", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]
  const env = Object.fromEntries(
    allowed.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
  )
  let child: ReturnType<typeof spawn> | undefined
  try {
    root = await mkdtemp(path.join(debugRoot, "session-archive-callers-"))
    await chmod(root, 0o700)
    const [physicalRoot, debugPhysicalRoot, metadata] = await Promise.all([
      realpath(root),
      realpath(debugRoot),
      lstat(root),
    ])
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      !physicalRoot.startsWith(`${debugPhysicalRoot}${path.sep}`) ||
      (metadata.mode & 0o777) !== 0o700
    )
      throw new Error("session archive caller harness root escaped the owned private debug directory")
    const harnessPath = path.join(physicalRoot, "harness.test.ts")
    const resultPath = path.join(physicalRoot, "result.json")
    await writeFile(harnessPath, harness)
    const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      child = spawn(
        process.execPath,
        ["--no-env-file", "test", "--preload", "@opentui/solid/preload", "--timeout", "30000", harnessPath],
        {
          cwd: import.meta.dirname,
          detached: true,
          env: { ...env, CLI_ROOT: path.dirname(import.meta.dirname), RESULT_PATH: resultPath, SCENARIO: scenario },
          stdio: ["ignore", "pipe", "pipe"],
        },
      )
      let stdout = ""
      let stderr = ""
      if (!child.stdout || !child.stderr) {
        reject(new Error("child process output pipes are unavailable"))
        return
      }
      child.stdout.on("data", (chunk) => (stdout += chunk))
      child.stderr.on("data", (chunk) => (stderr += chunk))
      child.once("error", reject)
      child.once("close", (code) => resolve({ code, stdout, stderr }))
    })
    expect(output.code, `${output.stdout}\n${output.stderr}`).toBe(0)
    return JSON.parse(await readFile(resultPath, "utf8"))
  } finally {
    const pgid = child?.pid
    if (pgid && child?.exitCode === null) process.kill(-pgid, "SIGTERM")
    if (pgid) expect(() => process.kill(-pgid, 0)).toThrow()
    if (root) {
      const [physicalRoot, debugPhysicalRoot, metadata] = await Promise.all([
        realpath(root),
        realpath(debugRoot),
        lstat(root),
      ])
      if (
        metadata.isSymbolicLink() ||
        !metadata.isDirectory() ||
        !physicalRoot.startsWith(`${debugPhysicalRoot}${path.sep}`)
      )
        throw new Error("refusing to remove session archive caller harness outside the owned debug directory")
      await rm(physicalRoot, { force: true, recursive: true })
    }
  }
}

test("session list sends archived:false through the public command handler", async () => {
  const result = await runScenario("list")
  expect(
    new URL(result.requests.find((request) => new URL(request).pathname === "/api/session")!).searchParams.get(
      "archived",
    ),
  ).toBe("false")
})

test("interactive export lists active roots before exporting the prompt-selected ID", async () => {
  const result = await runScenario("interactive")
  expect(
    new URL(result.requests.find((request) => new URL(request).pathname === "/api/session")!).searchParams.get(
      "archived",
    ),
  ).toBe("false")
  expect(
    result.requests.some((request) => new URL(request).pathname === "/api/experimental/session/ses_active/export"),
  ).toBe(true)
  expect(result.prompts).toEqual([{ message: "Select session to export", values: ["ses_active"] }])
})

test("explicit-ID export skips the active-only picker and exports an archived ID", async () => {
  const result = await runScenario("explicit")
  expect(result.requests.some((request) => new URL(request).pathname === "/api/session")).toBe(false)
  expect(
    result.requests.some((request) => new URL(request).pathname === "/api/experimental/session/ses_archived/export"),
  ).toBe(true)
  expect(result.prompts).toEqual([])
})
