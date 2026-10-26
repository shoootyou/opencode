/**
 * @spec-handoff
 * @interface compiledLegacyArchiveRoundtrip(manifestPath: string): Promise<void>
 * @behavior
 *   - Populates active, epoch-zero archived, normally archived, and restored sessions through the old compiled HTTP API.
 *   - Starts the native compiled binary on the copied old profile and requires it to read the preserved identities, archive times, and retained old event journal.
 *   - Requires a native archive transition to retain a native archive event, then restores the pre-upgrade profile and proves the old binary can read it.
 * @edge-cases
 *   - Missing an explicitly requested manifest fails configuration; normal runs may opt in with the manifest environment variable.
 *   - Every spawned server is an isolated process group whose identity, reaping, and absence are verified before profile snapshots or deletion.
 * @see ../../../.debug/fixtures/plan382-e8-d2c112b/fixture-pair.json
 */
import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { randomBytes } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import path from "node:path"

const manifestPath = process.env.OPENCODE_COMPILED_FIXTURE_MANIFEST
const required = process.env.OPENCODE_COMPILED_FIXTURE_REQUIRED === "1"

test.skipIf(!manifestPath && !required)(
  "compiled old/native populated fixture requires an explicit manifest",
  async () => {
    if (!manifestPath)
      throw new Error("OPENCODE_COMPILED_FIXTURE_MANIFEST is required when compiled fixture execution is requested")
    const manifest = await readManifest(manifestPath!)
    const paths = fixturePaths(manifestPath!)
    const priorRuns = (await readdir(paths.runRoot)).sort()
    const root = await createRunRoot(paths.runRoot)
    const receipt = path.join(paths.evidenceRoot, `shin-compiled-fixture-${path.basename(root)}.json`)
    const oldInput = await inputEntries(path.dirname(manifest.old_reference.path))
    const oldHash = await sha256(manifest.old_reference.path)
    const password = randomBytes(24).toString("hex")
    let old: Server | undefined
    let native: Server | undefined
    let semanticOutcome = "exception"
    const starts: Array<{ pid: number; pgid: number; startticks: string }> = []

    try {
      expect(oldHash).toBe(manifest.old_reference.sha256)
      expect(await sha256(manifest.native.path)).toBe(manifest.native.sha256)

      const oldProfile = await createProfile(root, "old")
      old = await startServer(manifest.old_reference.path, oldProfile, password, "old")
      starts.push({ pid: old.child.pid, pgid: old.child.pid, startticks: old.start })
      const active = await createSession(old, "active")
      const epoch = await createSession(old, "epoch-zero")
      const archived = await createSession(old, "archived")
      const restored = await createSession(old, "restored")
      await archiveOld(old, epoch.id, 0)
      await archiveOld(old, archived.id, 1_700_000_000_000)
      await archiveOld(old, restored.id, 1_700_000_000_100)
      await archiveOld(old, restored.id, null)
      const oldState = await sessionStates(old, [active.id, epoch.id, archived.id, restored.id])
      expect(oldState).toEqual({ active: null, archived: 1_700_000_000_000, epoch: 0, restored: null })
      await stopServer(old)
      old = undefined
      expect(await ownedProcessIDs(root)).toEqual([])

      const preupgrade = path.join(root, "preupgrade")
      await Bun.write(path.join(root, "baseline.json"), JSON.stringify(oldState))
      await copyProfile(oldProfile, preupgrade)
      native = await startServer(manifest.native.path, oldProfile, password, "native")
      starts.push({ pid: native.child.pid, pgid: native.child.pid, startticks: native.start })
      const nativeState = await sessionStates(native, [active.id, epoch.id, archived.id, restored.id])
      expect(nativeState).toEqual(oldState)
      const nativeJournal = await readJournal(oldProfile, [epoch.id, archived.id, restored.id])
      expect(nativeJournal.some((event) => event.type === "session.archive.changed.1" && event.seq >= 0)).toBe(true)

      await archiveNative(native, active.id)
      const afterNative = await sessionStates(native, [active.id])
      expect(afterNative.active).not.toBeNull()
      const afterNativeJournal = await readJournal(oldProfile, [active.id])
      const nativeEvents = afterNativeJournal.filter((event) => event.type === "session.archived.1")
      expect(nativeEvents).toHaveLength(1)
      expect(nativeEvents[0]?.seq).toBe(1)
      await stopServer(native)
      native = undefined
      expect(await ownedProcessIDs(root)).toEqual([])

      await rm(oldProfile, { recursive: true, force: true })
      await copyProfile(preupgrade, oldProfile)
      old = await startServer(manifest.old_reference.path, oldProfile, password, "rollback")
      starts.push({ pid: old.child.pid, pgid: old.child.pid, startticks: old.start })
      expect(await sessionStates(old, [active.id, epoch.id, archived.id, restored.id])).toEqual(oldState)
      await stopServer(old)
      old = undefined
      expect(await ownedProcessIDs(root)).toEqual([])
      semanticOutcome = "semantic-green-native-retention"
    } finally {
      await Promise.all([stopServer(native), stopServer(old)])
      expect(await ownedProcessIDs(root)).toEqual([])
      expect(await sha256(manifest.old_reference.path)).toBe(manifest.old_reference.sha256)
      expect(await inputEntries(path.dirname(manifest.old_reference.path))).toEqual(oldInput)
      await mkdir(paths.evidenceRoot, { recursive: true, mode: 0o700 })
      await writeFile(
        receipt,
        JSON.stringify({
          native_sha256: manifest.native.sha256,
          old_sha256: manifest.old_reference.sha256,
          outcome: semanticOutcome,
          owned_root: root,
          starts,
          process_groups_absent: true,
          proof_sequence: [
            "old-populate",
            "old-stop",
            "snapshot",
            "native-read-write",
            "native-stop",
            "rollback",
            "delete",
          ],
          snapshot_and_rollback: true,
          source: "d2c112bad4ee61a94e4fbef731ab611aa284f269",
        }),
      )
      await rm(root, { recursive: true, force: false })
      expect(await Bun.file(root).exists()).toBe(false)
      expect((await readdir(paths.runRoot)).sort()).toEqual(priorRuns)
    }
  },
  30_000,
)

function fixturePaths(manifest: string) {
  const base = path.dirname(path.resolve(manifest))
  return { evidenceRoot: path.join(base, "evidence"), runRoot: path.join(base, "shin-compiled-roundtrip") }
}

async function createRunRoot(fixtureRoot: string) {
  const requested = await mkdtemp(path.join(fixtureRoot, "run-"))
  const [physical, metadata] = await Promise.all([realpath(requested), lstat(requested)])
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || !physical.startsWith(`${fixtureRoot}${path.sep}`))
    throw new Error("compiled fixture root escaped the owned physical prefix")
  return physical
}

async function readManifest(file: string) {
  const requested = path.resolve(file)
  if (!path.isAbsolute(file) || !requested.endsWith("/fixture-pair.json"))
    throw new Error("fixture manifest must be an absolute fixture-pair.json path")
  const source = await readFile(requested, "utf8")
  const parsed: unknown = JSON.parse(source)
  if (!isManifest(parsed)) throw new Error("fixture manifest has an invalid compiled-pair shape")
  return parsed
}

function isManifest(value: unknown): value is {
  old_reference: { path: string; sha256: string }
  native: { path: string; sha256: string }
} {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.old_reference === "object" &&
    record.old_reference !== null &&
    typeof (record.old_reference as Record<string, unknown>).path === "string" &&
    typeof (record.old_reference as Record<string, unknown>).sha256 === "string" &&
    typeof record.native === "object" &&
    record.native !== null &&
    typeof (record.native as Record<string, unknown>).path === "string" &&
    typeof (record.native as Record<string, unknown>).sha256 === "string"
  )
}

async function createProfile(root: string, name: string) {
  const profile = path.join(root, name)
  for (const directory of ["cache", "config", "data", "home", "runtime", "state", "tmp", "workspace"])
    await mkdir(path.join(profile, directory), { recursive: true, mode: 0o700 })
  return profile
}

async function copyProfile(source: string, destination: string) {
  await mkdir(destination, { recursive: true, mode: 0o700 })
  const result = Bun.spawn(["cp", "-a", `${source}/.`, destination], { stdout: "ignore", stderr: "pipe" })
  if ((await result.exited) !== 0) throw new Error("owned profile copy failed")
}

async function sha256(file: string) {
  const result = Bun.spawn(["sha256sum", file], { stdout: "pipe", stderr: "pipe" })
  if ((await result.exited) !== 0) throw new Error("fixture hash command failed")
  const hash = (await new Response(result.stdout).text()).split(/\s+/)[0]
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("fixture hash command returned an invalid digest")
  return hash
}

async function inputEntries(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true })
  return entries.sort()
}

type Server = { child: Bun.Subprocess; origin: string; password: string; profile: string; start: string }

async function startServer(binary: string, profile: string, password: string, label: string): Promise<Server> {
  const child = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: path.join(profile, "workspace"),
    detached: true,
    env: childEnvironment(profile, password),
    stdout: "pipe",
    stderr: "pipe",
  })
  if (child.stderr instanceof ReadableStream) void new Response(child.stderr).text()
  if (!child.pid) throw new Error(`${label} server had no pid`)
  const start = await processIdentity(child.pid)
  if (!start || start.pgid !== child.pid) throw new Error(`${label} server did not establish an owned process group`)
  const output = await announcedOrigin(child, label)
  const origin = new URL(output)
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port)
    throw new Error(`${label} announced non-loopback origin`)
  const server = { child, origin: origin.origin, password, profile, start: start.start }
  await health(server, label)
  return server
}

function childEnvironment(profile: string, password: string) {
  return {
    HOME: path.join(profile, "home"),
    LANG: "C.UTF-8",
    OPENCODE_CONFIG_DIR: path.join(profile, "config", "opencode"),
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DB: path.join(profile, "data", "opencode.db"),
    OPENCODE_PASSWORD: password,
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    TMPDIR: path.join(profile, "tmp"),
    XDG_CACHE_HOME: path.join(profile, "cache"),
    XDG_CONFIG_HOME: path.join(profile, "config"),
    XDG_DATA_HOME: path.join(profile, "data"),
    XDG_RUNTIME_DIR: path.join(profile, "runtime"),
    XDG_STATE_HOME: path.join(profile, "state"),
  }
}

async function announcedOrigin(child: Bun.Subprocess, label: string) {
  if (!(child.stdout instanceof ReadableStream)) throw new Error(`${label} server stdout was not piped`)
  const reader = child.stdout.getReader()
  const timeout = AbortSignal.timeout(10_000)
  let output = ""
  try {
    while (!timeout.aborted) {
      const next = await reader.read()
      if (next.done) break
      output += new TextDecoder().decode(next.value)
      const match = output.match(/server listening on (http:\/\/\S+)/)
      if (match) return match[1]
    }
  } finally {
    reader.releaseLock()
  }
  throw new Error(`${label} server did not announce a listener`)
}

async function health(server: Server, label: string) {
  const headers = { authorization: `Basic ${btoa(`opencode:${server.password}`)}` }
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(new URL("/api/info", server.origin), {
      headers,
      signal: AbortSignal.timeout(2_000),
    }).catch(() => undefined)
    if (!response?.ok) continue
    const body: unknown = await response.json()
    if (typeof body === "object" && body !== null && (body as { pid?: unknown }).pid === server.child.pid) return
  }
  throw new Error(`${label} server failed two bounded health checks`)
}

async function createSession(server: Server, title: string) {
  const response = await request(server, "/api/session", "POST", {
    title,
    location: { directory: path.join(server.profile, "workspace") },
  })
  expect(response.status).toBe(200)
  const body = await response.json()
  const value = typeof body === "object" && body !== null && "data" in body ? body.data : body
  if (typeof value !== "object" || value === null || typeof (value as { id?: unknown }).id !== "string")
    throw new Error("old server did not create a session")
  return value as { id: string }
}

async function archiveOld(server: Server, sessionID: string, archive: number | null) {
  const response = await request(server, `/api/session/${sessionID}`, "PATCH", { archive })
  expect(response.status).toBe(204)
}

async function archiveNative(server: Server, sessionID: string) {
  const response = await request(server, `/api/session/${sessionID}`, "PATCH", { archived: true })
  expect(response.status).toBe(204)
}

async function sessionStates(server: Server, ids: string[]) {
  const sessions = await Promise.all(
    ids.map(async (id) => {
      const response = await request(server, `/api/session/${id}`, "GET")
      expect(response.status).toBe(200)
      const body = await response.json()
      const value = typeof body === "object" && body !== null && "data" in body ? body.data : body
      if (typeof value !== "object" || value === null) throw new Error("session read had no data")
      const time = (value as { time?: { archived?: unknown } }).time
      return typeof time?.archived === "number" ? time.archived : null
    }),
  )
  return { active: sessions[0], epoch: sessions[1], archived: sessions[2], restored: sessions[3] }
}

async function request(server: Server, route: string, method: string, body?: unknown) {
  return fetch(new URL(route, server.origin), {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { authorization: `Basic ${btoa(`opencode:${server.password}`)}`, "content-type": "application/json" },
    method,
    signal: AbortSignal.timeout(5_000),
  })
}

async function readJournal(profile: string, sessionIDs: string[]) {
  const database = path.join(profile, "data", "opencode.db")
  const connection = new Database(database, { readonly: true })
  const placeholders = sessionIDs.map(() => "?").join(", ")
  const rows: unknown = connection
    .query(`select type, seq from event where aggregate_id in (${placeholders})`)
    .all(...sessionIDs)
  connection.close()
  if (!Array.isArray(rows)) throw new Error("fixture journal query returned invalid data")
  return rows.filter(
    (entry): entry is { type: string; seq: number } =>
      typeof entry === "object" && entry !== null && typeof entry.type === "string" && typeof entry.seq === "number",
  )
}

async function stopServer(server: Server | undefined) {
  if (!server || server.child.exitCode !== null) return
  const before = await processIdentity(server.child.pid)
  if (!before || before.pgid !== server.child.pid || before.start !== server.start)
    throw new Error("refusing to signal an unverified process group")
  process.kill(-server.child.pid, "SIGTERM")
  if (!(await exitsWithin(server.child, 5_000))) process.kill(-server.child.pid, "SIGKILL")
  if (!(await exitsWithin(server.child, 5_000))) throw new Error("owned server did not reap after SIGKILL")
  expect(await groupProcessIDs(server.child.pid)).toEqual([])
}

async function exitsWithin(child: Bun.Subprocess, milliseconds: number) {
  return Promise.race([child.exited.then(() => true), Bun.sleep(milliseconds).then(() => false)])
}

async function processIdentity(pid: number) {
  const source = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined)
  if (!source) return undefined
  const close = source.lastIndexOf(")")
  const fields = source
    .slice(close + 2)
    .trim()
    .split(" ")
  return { pgid: Number(fields[2]), start: fields[19] }
}

async function groupProcessIDs(pgid: number) {
  const entries = await readdir("/proc")
  const identities = await Promise.all(
    entries.filter((entry) => /^\d+$/.test(entry)).map((entry) => processIdentity(Number(entry))),
  )
  return identities.filter((identity) => identity?.pgid === pgid)
}

async function ownedProcessIDs(root: string) {
  const entries = await readdir("/proc")
  const matches = await Promise.all(
    entries
      .filter((entry) => /^\d+$/.test(entry))
      .map(async (entry) => {
        const pid = Number(entry)
        const command = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")
        return command.includes(root) ? pid : undefined
      }),
  )
  return matches.filter((pid): pid is number => pid !== undefined)
}
