/**
 * @spec-handoff
 * @interface `opencode session list` and `opencode session export [session]`
 * @behavior
 *   - The session-list command requests active roots with archived:false.
 *   - The interactive export picker requests active roots with archived:false before exporting its selected ID.
 *   - Explicit-ID export reads that ID directly without applying an archive-state list filter.
 * @edge-cases
 *   - The interactive picker remains non-TTY-safe through its mocked prompt boundary.
 * @see ../src/commands/handlers/session/list.ts
 */
import { expect, mock, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@opencode/util/global"
import { Effect, FileSystem, Option, Scope } from "effect"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { Config } from "../src/config"
let selected = "ses_active"
const prompts: Array<{ message: string; values: readonly string[] }> = []
mock.module("@clack/prompts", () => ({
  autocomplete: async (input: { message: string; options: Array<{ value: string }> }) => {
    prompts.push({ message: input.message, values: input.options.map((option) => option.value) })
    return selected
  },
  cancel() {},
  intro() {},
  isCancel: () => false,
  log: { error() {} },
  outro() {},
}))
const listHandler = (await import("../src/commands/handlers/session/list")).default
const exportHandler = (await import("../src/commands/handlers/session/export")).default
const session = (id: string) => ({
  id,
  projectID: "project_fixture",
  title: id,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  location: { directory: "/fixture" },
})
async function withServer(run: (input: { url: string; requests: URL[] }) => Promise<void>) {
  const requests: URL[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      requests.push(url)
      if (url.pathname === "/api/info") return Response.json({ version: "2.1.4", pid: process.pid, urls: [] })
      if (url.pathname === "/api/location")
        return Response.json({
          directory: "/fixture",
          project: { id: "project_fixture", directory: "/fixture", canonical: "/fixture" },
        })
      if (url.pathname === "/api/session") return Response.json({ data: [session("ses_active")], cursor: {} })
      if (url.pathname.endsWith("/export")) return Response.json({ id: url.pathname.split("/").at(-2) })
      return new Response(null, { status: 404 })
    },
  })
  try {
    await run({ url: server.url.toString(), requests })
  } finally {
    server.stop(true)
  }
}
async function runHandler(
  effect: Effect.Effect<void, unknown, Config.Service | Global.Service | FileSystem.FileSystem | Scope.Scope>,
) {
  const root = path.join(import.meta.dirname, "../.debug", `plan382-cli-session-${process.pid}-${crypto.randomUUID()}`)
  const config = path.join(root, "config")
  const state = path.join(root, "state")
  await Promise.all([mkdir(config, { recursive: true }), mkdir(state, { recursive: true })])
  try {
    await Effect.runPromise(
      effect.pipe(
        Effect.provide(Config.layer),
        Effect.provide(Global.layerWith({ config, state })),
        Effect.provide(NodeFileSystem.layer),
        Effect.scoped,
      ),
    )
  } finally {
    await rm(root, { force: true, recursive: true })
  }
}
test("session list sends archived:false through the public command handler", async () => {
  await withServer(async ({ url, requests }) => {
    await runHandler(
      listHandler({ server: Option.some(url), standalone: false, maxCount: Option.some(1), format: "json" }),
    )
    expect(requests.find((request) => request.pathname === "/api/session")?.searchParams.get("archived")).toBe("false")
  })
})
test("interactive export lists active roots before exporting the prompt-selected ID", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
  selected = "ses_active"
  prompts.length = 0
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true })
  try {
    await withServer(async ({ url, requests }) => {
      await runHandler(
        exportHandler({ server: Option.some(url), standalone: false, session: Option.none(), sanitize: false }),
      )
      expect(requests.find((request) => request.pathname === "/api/session")?.searchParams.get("archived")).toBe(
        "false",
      )
      expect(requests.some((request) => request.pathname === "/api/experimental/session/ses_active/export")).toBe(true)
      expect(prompts).toEqual([{ message: "Select session to export", values: ["ses_active"] }])
    })
  } finally {
    if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor)
    else Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: undefined })
  }
})
test("explicit-ID export skips the active-only picker and exports an archived ID", async () => {
  prompts.length = 0
  await withServer(async ({ url, requests }) => {
    await runHandler(
      exportHandler({
        server: Option.some(url),
        standalone: false,
        session: Option.some("ses_archived"),
        sanitize: false,
      }),
    )
    expect(requests.some((request) => request.pathname === "/api/session")).toBe(false)
    expect(requests.some((request) => request.pathname === "/api/experimental/session/ses_archived/export")).toBe(true)
    expect(prompts).toEqual([])
  })
})
