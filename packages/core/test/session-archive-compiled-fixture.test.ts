/**
 * @spec-handoff
 * @interface compiledLegacyArchiveRoundtrip(manifestPath: string): Promise<void>
 * @behavior
 *   - Populates active, epoch-zero archived, normally archived, and restored sessions through the old compiled HTTP API.
 *   - Captures an exact typed old-profile baseline (sessions, legacy archive envelopes, message history, and config) through the old binary and its SQLite state.
 *   - Requires native archive/restore transitions, repeated no-op behavior, and restart persistence without changing preserved profile configuration.
 *   - Counts retained legacy and native archive-family rows after restart, then refuses the next real HTTP transition at the mixed rate boundary without mutation.
 *   - Restores the pre-upgrade backup and requires the old binary to read the complete typed baseline exactly.
 * @edge-cases
 *   - Missing an explicitly requested manifest fails configuration; normal runs may opt in with the manifest environment variable.
 *   - Every spawned server is an isolated process group whose identity, reaping, and absence are verified before profile snapshots or deletion.
 *   - The old binary has no supported events.persist=false surface (serve --help exposes only hostname, port, cors, service, and stdio) and new sessions have empty message history with no model-free message-write surface; core retention suites cover both at unit level.
 * @see ../../../.debug/fixtures/plan382-r1-f7dcf30/fixture-pair.json
 */
import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { randomBytes } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import path from "node:path"

const manifestPath = process.env.OPENCODE_COMPILED_FIXTURE_MANIFEST
const required = process.env.OPENCODE_COMPILED_FIXTURE_REQUIRED === "1"
const runtime = process.execPath

test("compiled fixture harness does not commit a workspace-root executable path", async () => {
  const source = await readFile(new URL(import.meta.url), "utf8")
  const workspaceRoots = ["/" + "code-projects" + "/", "/" + "workspace" + "/"]
  for (const root of workspaceRoots)
    expect(source, `compiled fixture harness must not commit workspace root ${root}`).not.toContain(root)
})

test("lifecycle cleanup terminates an owned descendant after its leader exits", async () => {
  const root = await adversarialRoot()
  const process = await startOwnedProcess(["/bin/sh", "-c", "sleep 0.15; sleep 30 & exit 0"], {
    cwd: root,
    env: syntheticEnvironment(root),
    label: "leader-first-exit",
  })
  try {
    await exitsWithin(process.child, 1_000)
    expect((await groupMembers(process.ownership.pgid)).some((member) => member.pid !== process.ownership.pid)).toBe(
      true,
    )
    await stopServer(process)
    expect(process.receipt.signals).toContain("SIGTERM")
    expect(process.receipt.final_members).toEqual([])
  } finally {
    await stopServer(process).catch(() => undefined)
    await cleanupSyntheticProcess(process)
    expect(await scanGroupMembers(process.ownership.pgid)).toEqual([])
    await rm(root, { recursive: true, force: true })
  }
})

test("lifecycle refuses unstable ownership without signalling its synthetic child", async () => {
  const root = await adversarialRoot()
  let failure: OwnershipFailure | undefined
  try {
    await startOwnedProcess([runtime, "-e", "await Bun.sleep(200)"], {
      cwd: root,
      env: syntheticEnvironment(root),
      label: "unstable-group",
      observe: (identity, sample) => (sample === 1 ? { ...identity, pgid: identity.pgid + 1 } : identity),
    })
  } catch (error) {
    failure = error as OwnershipFailure
  }
  try {
    expect(failure).toBeDefined()
    expect(failure?.receipt.signals).toEqual([])
    expect(await exitsWithin(failure!.child, 1_000)).toBe(true)
    expect(await groupMembers(failure!.actual.pgid)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("lifecycle refuses identity mismatch without signalling its synthetic child", async () => {
  const root = await adversarialRoot()
  const process = await startOwnedProcess([runtime, "-e", "await Bun.sleep(200)"], {
    cwd: root,
    env: syntheticEnvironment(root),
    label: "identity-mismatch",
  })
  process.ownership = { ...process.ownership, start: "0" }
  try {
    await expect(stopServer(process)).rejects.toThrow("recycled process-group leader")
    expect(process.receipt.signals).toEqual([])
    expect(await exitsWithin(process.child, 1_000)).toBe(true)
    expect(await groupMembers(process.receipt.leader.pgid)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.skipIf(!manifestPath && !required)(
  "compiled old/native populated fixture requires an explicit manifest",
  async () => {
    if (!manifestPath)
      throw new Error("OPENCODE_COMPILED_FIXTURE_MANIFEST is required when compiled fixture execution is requested")
    const manifest = await readManifest(manifestPath!)
    const paths = fixturePaths(manifestPath!)
    await mkdir(paths.runRoot, { recursive: true, mode: 0o700 })
    const priorRuns = (await readdir(paths.runRoot)).sort()
    const root = await createRunRoot(paths.runRoot)
    const oldInput = await inputEntries(path.dirname(manifest.old_reference.path))
    const oldHash = await sha256(manifest.old_reference.path)
    const password = randomBytes(24).toString("hex")
    let old: Server | undefined
    let native: Server | undefined
    let semanticOutcome = "exception"
    let mixedBoundary: { q: number; admitted: number; q_at_refusal: number; retry_after_millis: number } | undefined
    const lifecycles: LifecycleReceipt[] = []

    try {
      expect(oldHash).toBe(manifest.old_reference.sha256)
      expect(await sha256(manifest.native.path)).toBe(manifest.native.sha256)

      const oldProfile = await createProfile(root, "old")
      old = await startServer(manifest.old_reference.path, oldProfile, password, "old")
      lifecycles.push(old.receipt)
      const active = await createSession(old, "active")
      const epoch = await createSession(old, "epoch-zero")
      const archived = await createSession(old, "archived")
      const restored = await createSession(old, "restored")
      await archiveOld(old, epoch.id, 0)
      await archiveOld(old, archived.id, 1_700_000_000_000)
      const archivedBeforeRepeat = await archiveBaseline(old, archived.id)
      await archiveOld(old, archived.id, 1_700_000_000_999)
      expect(await archiveBaseline(old, archived.id)).toEqual(archivedBeforeRepeat)
      await archiveOld(old, restored.id, 1_700_000_000_100)
      await archiveOld(old, restored.id, null)
      const populatedAt = Date.now()
      const oldState = await sessionStates(old, [active.id, epoch.id, archived.id, restored.id])
      expect(oldState).toEqual({ active: null, archived: 1_700_000_000_000, epoch: 0, restored: null })
      const baseline = await typedBaseline(old, oldProfile, [active.id, epoch.id, archived.id, restored.id], active.id)
      expect(baseline.sessions.map((session) => session.id)).toEqual([active.id, epoch.id, archived.id, restored.id])
      expect(baseline.sessions.map((session) => session.time.archived)).toEqual([null, 0, 1_700_000_000_000, null])
      expect(baseline.legacy).toHaveLength(4)
      expect(baseline.legacy.map((event) => event.aggregate_id)).toEqual(
        [epoch.id, archived.id, restored.id, restored.id].sort(),
      )
      expect(baseline.messages.length).toBeGreaterThanOrEqual(0)
      await stopServer(old)
      old = undefined
      expect(await ownedProcessIDs(root)).toEqual([])

      const preupgrade = path.join(root, "preupgrade")
      await Bun.write(path.join(root, "baseline.json"), JSON.stringify(baseline))
      await copyProfile(oldProfile, preupgrade)
      native = await startServer(manifest.native.path, oldProfile, password, "native")
      lifecycles.push(native.receipt)
      expect(
        await typedBaseline(native, oldProfile, [active.id, epoch.id, archived.id, restored.id], active.id),
      ).toEqual(baseline)

      await archiveNative(native, active.id)
      const archivedNative = await archiveBaseline(native, active.id)
      expect(archivedNative.session.time.archived).not.toBeNull()
      expect(archivedNative.events.filter((event) => event.type === "session.archived.1")).toHaveLength(1)
      const archivedUpdated = archivedNative.session.time.updated
      const archivedSequence = archivedNative.sequence
      await archiveNative(native, active.id)
      expect(await archiveBaseline(native, active.id)).toEqual(archivedNative)
      await restoreNative(native, active.id)
      const restoredNative = await archiveBaseline(native, active.id)
      expect(restoredNative.session.time.archived).toBeNull()
      expect(restoredNative.events.filter((event) => event.type === "session.unarchived.1")).toHaveLength(1)
      expect(restoredNative.session.time.updated).not.toBe(archivedUpdated)
      expect(restoredNative.sequence).toBe(archivedSequence + 1)
      await restoreNative(native, active.id)
      expect(await archiveBaseline(native, active.id)).toEqual(restoredNative)
      expect(await configSnapshot(oldProfile)).toEqual(baseline.config)
      await stopServer(native)
      native = undefined
      expect(await ownedProcessIDs(root)).toEqual([])

      native = await startServer(manifest.native.path, oldProfile, password, "native-restart")
      lifecycles.push(native.receipt)
      expect(await archiveBaseline(native, active.id)).toEqual(restoredNative)
      expect(await configSnapshot(oldProfile)).toEqual(baseline.config)
      expect(
        Date.now() - populatedAt,
        "mixed admission sequence exceeded its 30-second anti-flake budget",
      ).toBeLessThanOrEqual(30_000)
      const legacy = baseline.legacy.filter((event) => event.aggregate_id === restored.id)
      const q = qualifyingArchiveRows(legacy, Date.now()).length
      expect(q).toBe(2)
      let admitted = 0
      let beforeLastAdmission: ArchiveBaseline | undefined
      for (const archived of [true, false, true, false]) {
        const before = await archiveBaseline(native, restored.id)
        beforeLastAdmission = before
        const response = await transitionNative(native, restored.id, archived)
        expect(response.status).toBe(204)
        admitted++
        const after = await archiveBaseline(native, restored.id)
        expect(after.sequence).toBe(before.sequence + 1)
        expect(qualifyingArchiveRows(after.events, Date.now()).length).toBeLessThan(7)
      }
      expect(admitted).toBe(6 - q)
      const beforeRefusal = await archiveBaseline(native, restored.id)
      const sentAt = Date.now()
      const refused = await transitionNative(native, restored.id, true)
      const receivedAt = Date.now()
      expect(refused.status).toBe(429)
      const refusal = await refused.json()
      expect(refusal).toMatchObject({
        _tag: "SessionArchiveLimitError",
        sessionID: restored.id,
        kind: "rate",
        message: "Archive transition rate limit exceeded",
      })
      if (
        typeof refusal !== "object" ||
        refusal === null ||
        typeof (refusal as { retryAfterMillis?: unknown }).retryAfterMillis !== "number"
      )
        throw new Error("rate refusal omitted numeric retryAfterMillis")
      const retryAfterMillis = (refusal as { retryAfterMillis: number }).retryAfterMillis
      expect(retryAfterMillis).toBeGreaterThan(0)
      expect(retryAfterMillis).toBeLessThanOrEqual(60_000 + 1_000)
      const afterRefusal = await archiveBaseline(native, restored.id)
      expect(afterRefusal).toEqual(beforeRefusal)
      const qualifyingAtRefusal = definitelyQualifyingArchiveRows(afterRefusal.events, sentAt, receivedAt)
      expect(qualifyingAtRefusal.length).toBeGreaterThanOrEqual(6)
      expect(beforeLastAdmission).toBeDefined()
      expect(qualifyingArchiveRows(beforeLastAdmission!.events, sentAt).length).toBeLessThan(6)
      expect(
        Date.now() - populatedAt,
        "mixed admission sequence exceeded its 30-second anti-flake budget",
      ).toBeLessThanOrEqual(30_000)
      mixedBoundary = { q, admitted, q_at_refusal: qualifyingAtRefusal.length, retry_after_millis: retryAfterMillis }
      await stopServer(native)
      native = undefined
      expect(await ownedProcessIDs(root)).toEqual([])

      await rm(oldProfile, { recursive: true, force: true })
      await copyProfile(preupgrade, oldProfile)
      old = await startServer(manifest.old_reference.path, oldProfile, password, "rollback")
      lifecycles.push(old.receipt)
      expect(await typedBaseline(old, oldProfile, [active.id, epoch.id, archived.id, restored.id], active.id)).toEqual(
        baseline,
      )
      await stopServer(old)
      old = undefined
      expect(await ownedProcessIDs(root)).toEqual([])
      semanticOutcome = "semantic-green-native-retention"
    } finally {
      await Promise.all([stopServer(native), stopServer(old)])
      expect(await ownedProcessIDs(root)).toEqual([])
      expect(await sha256(manifest.old_reference.path)).toBe(manifest.old_reference.sha256)
      expect(await inputEntries(path.dirname(manifest.old_reference.path))).toEqual(oldInput)
      const receiptRoot = path.join(paths.evidenceRoot, semanticOutcome === "exception" ? "failed" : "accepted")
      const receipt = path.join(receiptRoot, `shin-compiled-fixture-${path.basename(root)}.json`)
      await mkdir(receiptRoot, { recursive: true, mode: 0o700 })
      await writeFile(
        receipt,
        JSON.stringify({
          binary_provenance: {
            native: {
              sha256: manifest.native.sha256,
              source_commit: manifest.source.commit,
              source_tree: manifest.source.tree,
              reported_version: manifest.native.reported_version,
            },
            old_reference: {
              sha256: manifest.old_reference.sha256,
              source_commit: manifest.old_reference.source_commit,
              source_tree: manifest.old_reference.source_tree,
            },
            production_source_identity_check: manifest.source.production_source_tree_identical,
          },
          harness_provenance: await harnessProvenance(manifest),
          outcome: semanticOutcome,
          mixed_admission_boundary: mixedBoundary,
          owned_root: root,
          lifecycles,
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
  old_reference: { path: string; sha256: string; source_commit: string; source_tree: string }
  native: { path: string; sha256: string; reported_version: string }
  source: { commit: string; tree: string; production_source_tree_identical: boolean }
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
    typeof (record.native as Record<string, unknown>).sha256 === "string" &&
    typeof (record.native as Record<string, unknown>).reported_version === "string" &&
    typeof (record.old_reference as Record<string, unknown>).source_commit === "string" &&
    typeof (record.old_reference as Record<string, unknown>).source_tree === "string" &&
    typeof record.source === "object" &&
    record.source !== null &&
    typeof (record.source as Record<string, unknown>).commit === "string" &&
    typeof (record.source as Record<string, unknown>).tree === "string" &&
    typeof (record.source as Record<string, unknown>).production_source_tree_identical === "boolean"
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

type ProcessIdentity = { pid: number; pgid: number; sid: number; start: string }
type LifecycleReceipt = {
  label: string
  leader: ProcessIdentity
  runner_groups: number[]
  stabilization_samples: ProcessIdentity[]
  members_before_term: ProcessIdentity[]
  signals: string[]
  waits: Array<{ signal: string; outcome: "empty" | "timed-out" }>
  final_members: ProcessIdentity[]
}
type OwnedProcess = { child: Bun.Subprocess; ownership: ProcessIdentity; receipt: LifecycleReceipt }
type Server = OwnedProcess & { origin: string; password: string; profile: string }
type OwnershipFailure = Error & { child: Bun.Subprocess; receipt: LifecycleReceipt; actual: ProcessIdentity }

async function startServer(binary: string, profile: string, password: string, label: string): Promise<Server> {
  const process = await startOwnedProcess([binary, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: path.join(profile, "workspace"),
    env: childEnvironment(profile, password),
    label,
  })
  const output = await announcedOrigin(process.child, label)
  const origin = new URL(output)
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port)
    throw new Error(`${label} announced non-loopback origin`)
  const server = { ...process, origin: origin.origin, password, profile }
  await health(server, label)
  return server
}

async function startOwnedProcess(
  command: string[],
  options: {
    cwd: string
    env: Record<string, string>
    label: string
    observe?: (identity: ProcessIdentity, sample: number) => ProcessIdentity
  },
): Promise<OwnedProcess> {
  const runnerGroups = await ancestorGroups()
  await capabilityPreflight(runnerGroups)
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    detached: true,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (child.stderr instanceof ReadableStream) void new Response(child.stderr).text()
  if (!child.pid) throw new Error(`${options.label} process had no pid`)
  const samples: ProcessIdentity[] = []
  for (let sample = 0; sample < 3; sample++) {
    const observed = await processIdentity(child.pid)
    if (!observed) throw new Error(`${options.label} leader exited before ownership stabilization`)
    samples.push(options.observe?.(observed, sample) ?? observed)
    if (sample < 2) await Bun.sleep(20)
  }
  const receipt: LifecycleReceipt = {
    label: options.label,
    leader: samples[0]!,
    runner_groups: runnerGroups,
    stabilization_samples: samples,
    members_before_term: [],
    signals: [],
    waits: [],
    final_members: [],
  }
  try {
    const ownership = requireStableOwnership(child.pid, samples, runnerGroups, options.label)
    return {
      child,
      ownership,
      receipt: { ...receipt, leader: ownership },
    }
  } catch (error) {
    const actual = await processIdentity(child.pid)
    if (!actual) throw error
    Object.assign(error as Error, { child, receipt, actual })
    throw error
  }
}

async function capabilityPreflight(runnerGroups: number[]) {
  if (process.platform !== "linux")
    throw new Error("compiled lifecycle fixture requires Linux /proc process inspection")
  const self = await processIdentity(process.pid)
  if (!self || runnerGroups.length === 0 || !Number.isInteger(self.sid))
    throw new Error("compiled lifecycle fixture cannot establish process-group inspection capability")
}

function requireStableOwnership(pid: number, samples: ProcessIdentity[], runnerGroups: number[], label: string) {
  const first = samples[0]
  if (
    !first ||
    samples.length !== 3 ||
    samples.some(
      (sample) => sample.pid !== pid || sample.pgid !== pid || sample.sid !== pid || sample.start !== first.start,
    ) ||
    runnerGroups.includes(pid)
  )
    throw new Error(`${label} process failed owned session/process-group stabilization`)
  return first
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

async function adversarialRoot() {
  const base = path.resolve(import.meta.dir, "../.debug/compiled-fixture-lifecycle")
  await mkdir(base, { recursive: true, mode: 0o700 })
  return createRunRoot(base)
}

function syntheticEnvironment(root: string) {
  return {
    HOME: root,
    LANG: "C.UTF-8",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    TMPDIR: root,
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
  const response = await transitionNative(server, sessionID, true)
  expect(response.status).toBe(204)
}

async function restoreNative(server: Server, sessionID: string) {
  const response = await transitionNative(server, sessionID, false)
  expect(response.status).toBe(204)
}

function transitionNative(server: Server, sessionID: string, archived: boolean) {
  return request(server, `/api/session/${sessionID}`, "PATCH", { archived })
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

type SessionSnapshot = { id: string; time: { created: number; updated: number; archived: number | null } }
type DurableEnvelope = {
  id: string
  aggregate_id: string
  seq: number
  created: number
  type: string
  data: unknown
}
type ArchiveBaseline = { session: SessionSnapshot; events: DurableEnvelope[]; sequence: number }
type TypedBaseline = {
  sessions: SessionSnapshot[]
  legacy: DurableEnvelope[]
  messages: unknown[]
  config: Record<string, string>
}

function qualifyingArchiveRows(rows: DurableEnvelope[], now: number) {
  return rows.filter((row) => isArchiveFamily(row) && row.created > now - 60_000 && row.created <= now + 60_000)
}

function definitelyQualifyingArchiveRows(rows: DurableEnvelope[], sentAt: number, receivedAt: number) {
  return rows.filter(
    (row) => isArchiveFamily(row) && row.created > receivedAt - 60_000 && row.created <= sentAt + 60_000,
  )
}

function isArchiveFamily(row: DurableEnvelope) {
  return ["session.archive.changed.1", "session.archived.1", "session.unarchived.1"].includes(row.type)
}

async function typedBaseline(
  server: Server,
  profile: string,
  ids: string[],
  messageSessionID: string,
): Promise<TypedBaseline> {
  const sessions = await Promise.all(ids.map((id) => sessionSnapshot(server, id)))
  const journal = await readEnvelopes(profile, ids)
  const messages = await messageHistory(server, messageSessionID)
  return {
    sessions,
    legacy: journal.filter((event) => event.type === "session.archive.changed.1"),
    messages,
    config: await configSnapshot(profile),
  }
}

async function archiveBaseline(server: Server, sessionID: string): Promise<ArchiveBaseline> {
  const [session, events, sequence] = await Promise.all([
    sessionSnapshot(server, sessionID),
    readEnvelopes(server.profile, [sessionID]),
    sequenceFor(server.profile, sessionID),
  ])
  return { session, events, sequence }
}

async function sessionSnapshot(server: Server, id: string): Promise<SessionSnapshot> {
  const response = await request(server, `/api/session/${id}`, "GET")
  expect(response.status).toBe(200)
  return requireSessionSnapshot(await response.json())
}

function requireSessionSnapshot(body: unknown): SessionSnapshot {
  const value = typeof body === "object" && body !== null && "data" in body ? (body as { data: unknown }).data : body
  const time = typeof value === "object" && value !== null ? (value as { time?: unknown }).time : undefined
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { id?: unknown }).id !== "string" ||
    typeof time !== "object" ||
    time === null ||
    typeof (time as { created?: unknown }).created !== "number" ||
    typeof (time as { updated?: unknown }).updated !== "number"
  )
    throw new Error("fixture session HTTP response had an invalid typed snapshot")
  const archived = (time as { archived?: unknown }).archived ?? null
  if (archived !== null && typeof archived !== "number")
    throw new Error("fixture session HTTP archive value had an invalid shape")
  return {
    id: (value as { id: string }).id,
    time: { created: (time as { created: number }).created, updated: (time as { updated: number }).updated, archived },
  }
}

async function readEnvelopes(profile: string, sessionIDs: string[]): Promise<DurableEnvelope[]> {
  const connection = new Database(path.join(profile, "data", "opencode.db"), { readonly: true })
  const placeholders = sessionIDs.map(() => "?").join(", ")
  const rows: unknown = connection
    .query(
      `select id, aggregate_id, seq, created, type, data from event where aggregate_id in (${placeholders}) order by aggregate_id, seq`,
    )
    .all(...sessionIDs)
  connection.close()
  if (!Array.isArray(rows)) throw new Error("fixture envelope query returned invalid data")
  return rows.map(requireEnvelope)
}

function requireEnvelope(value: unknown): DurableEnvelope {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { id?: unknown }).id !== "string" ||
    typeof (value as { aggregate_id?: unknown }).aggregate_id !== "string" ||
    typeof (value as { seq?: unknown }).seq !== "number" ||
    typeof (value as { created?: unknown }).created !== "number" ||
    typeof (value as { type?: unknown }).type !== "string" ||
    typeof (value as { data?: unknown }).data !== "string"
  )
    throw new Error("fixture durable envelope row had an invalid shape")
  return {
    id: (value as { id: string }).id,
    aggregate_id: (value as { aggregate_id: string }).aggregate_id,
    seq: (value as { seq: number }).seq,
    created: (value as { created: number }).created,
    type: (value as { type: string }).type,
    data: JSON.parse((value as { data: string }).data),
  }
}

async function sequenceFor(profile: string, sessionID: string) {
  const connection = new Database(path.join(profile, "data", "opencode.db"), { readonly: true })
  const row: unknown = connection.query("select seq from event_sequence where aggregate_id = ?").get(sessionID)
  connection.close()
  if (typeof row !== "object" || row === null || typeof (row as { seq?: unknown }).seq !== "number")
    throw new Error("fixture event sequence row had an invalid shape")
  return (row as { seq: number }).seq
}

async function messageHistory(server: Server, sessionID: string) {
  const response = await request(server, `/api/session/${sessionID}/message`, "GET")
  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  const value = typeof body === "object" && body !== null && "data" in body ? (body as { data: unknown }).data : body
  if (!Array.isArray(value)) throw new Error("fixture message history response had an invalid shape")
  return value
}

async function configSnapshot(profile: string) {
  const root = path.join(profile, "config")
  const files = await readdir(root, { recursive: true })
  const pairs = await Promise.all(
    files.sort().map(async (relative) => {
      const absolute = path.join(root, relative)
      const metadata = await lstat(absolute)
      if (!metadata.isFile()) return undefined
      return [relative, Buffer.from(await readFile(absolute)).toString("base64")] as const
    }),
  )
  return Object.fromEntries(pairs.filter((pair): pair is readonly [string, string] => pair !== undefined))
}

async function stopServer(server: OwnedProcess | undefined) {
  if (!server) return
  const before = await groupMembers(server.ownership.pgid)
  server.receipt.members_before_term = before
  assertOwnedGroup(server, before)
  if (before.length > 0) {
    process.kill(-server.ownership.pgid, "SIGTERM")
    server.receipt.signals.push("SIGTERM")
  }
  const afterTerm = await waitForEmptyGroup(server.ownership.pgid, 500)
  server.receipt.waits.push({ signal: "SIGTERM", outcome: afterTerm.length === 0 ? "empty" : "timed-out" })
  if (afterTerm.length > 0) {
    assertOwnedGroup(server, afterTerm)
    process.kill(-server.ownership.pgid, "SIGKILL")
    server.receipt.signals.push("SIGKILL")
  }
  const final = await waitForEmptyGroup(server.ownership.pgid, 500)
  server.receipt.waits.push({ signal: "SIGKILL", outcome: final.length === 0 ? "empty" : "timed-out" })
  server.receipt.final_members = final
  if (final.length > 0) throw new Error("owned process group did not become empty after bounded cleanup")
  await exitsWithin(server.child, 500)
}

function assertOwnedGroup(server: OwnedProcess, members: ProcessIdentity[]) {
  const leader = members.find((member) => member.pid === server.ownership.pid)
  if (leader && !sameIdentity(leader, server.ownership))
    throw new Error("refusing to signal a recycled process-group leader")
  if (
    members.some(
      (member) =>
        member.pgid !== server.ownership.pgid ||
        member.sid !== server.ownership.sid ||
        BigInt(member.start) < BigInt(server.ownership.start),
    )
  )
    throw new Error("refusing to signal a process group whose membership is not continuously owned")
}

function sameIdentity(left: ProcessIdentity, right: ProcessIdentity) {
  return left.pid === right.pid && left.pgid === right.pgid && left.sid === right.sid && left.start === right.start
}

async function waitForEmptyGroup(pgid: number, milliseconds: number) {
  const deadline = Date.now() + milliseconds
  for (;;) {
    const members = await groupMembers(pgid)
    if (members.length === 0 || Date.now() >= deadline) return members
    await Bun.sleep(20)
  }
}

async function exitsWithin(child: Bun.Subprocess, milliseconds: number) {
  return Promise.race([child.exited.then(() => true), Bun.sleep(milliseconds).then(() => false)])
}

async function processIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  const source = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined)
  if (!source) return undefined
  const close = source.lastIndexOf(")")
  const fields = source
    .slice(close + 2)
    .trim()
    .split(" ")
  if (fields.length < 20 || !/^\d+$/.test(fields[19] ?? "")) return undefined
  return { pid, pgid: Number(fields[2]), sid: Number(fields[3]), start: fields[19] }
}

async function groupMembers(pgid: number) {
  return scanGroupMembers(pgid)
}

async function scanGroupMembers(pgid: number) {
  const entries = await readdir("/proc")
  const identities = await Promise.all(
    entries.filter((entry) => /^\d+$/.test(entry)).map((entry) => processIdentity(Number(entry))),
  )
  return identities.filter((identity): identity is ProcessIdentity => identity?.pgid === pgid)
}

async function cleanupSyntheticProcess(owned: OwnedProcess) {
  const members = await scanGroupMembers(owned.receipt.leader.pgid)
  if (members.length === 0) return
  const leader = members.find((member) => member.pid === owned.receipt.leader.pid)
  if (leader && !sameIdentity(leader, owned.receipt.leader))
    throw new Error("synthetic cleanup refused recycled leader")
  if (
    members.some(
      (member) => member.sid !== owned.receipt.leader.sid || BigInt(member.start) < BigInt(owned.receipt.leader.start),
    )
  )
    throw new Error("synthetic cleanup refused unowned group")
  process.kill(-owned.receipt.leader.pgid, "SIGKILL")
  expect(await waitForEmptyGroupDirect(owned.receipt.leader.pgid, 500)).toEqual([])
}

async function waitForEmptyGroupDirect(pgid: number, milliseconds: number) {
  const deadline = Date.now() + milliseconds
  for (;;) {
    const members = await scanGroupMembers(pgid)
    if (members.length === 0 || Date.now() >= deadline) return members
    await Bun.sleep(20)
  }
}

async function ancestorGroups() {
  const groups: number[] = []
  let pid = process.pid
  for (let depth = 0; depth < 32; depth++) {
    const source = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined)
    if (!source) break
    const close = source.lastIndexOf(")")
    const fields = source
      .slice(close + 2)
      .trim()
      .split(" ")
    const pgid = Number(fields[2])
    const parent = Number(fields[1])
    if (!Number.isInteger(pgid) || !Number.isInteger(parent)) break
    groups.push(pgid)
    if (parent <= 1 || parent === pid) break
    pid = parent
  }
  return [...new Set(groups)]
}

async function harnessProvenance(manifest: Awaited<ReturnType<typeof readManifest>>) {
  const cwd = path.resolve(import.meta.dir, "../../..")
  const [head, tree, status] = await Promise.all([
    gitOutput(cwd, ["rev-parse", "HEAD"]),
    gitOutput(cwd, ["rev-parse", "HEAD^{tree}"]),
    gitOutput(cwd, ["status", "--porcelain", "--untracked-files=no"]),
  ])
  return {
    commit: head,
    tree,
    dirty: status !== "",
    command: ["bun", "--no-env-file", "run", "script/test.ts", "session-archive-compiled-fixture.test.ts"],
    env_names: ["OPENCODE_COMPILED_FIXTURE_MANIFEST", "OPENCODE_COMPILED_FIXTURE_REQUIRED", "PATH"],
    differs_from_binary_source: head !== manifest.source.commit,
    test_only_commits_do_not_change_production_source: manifest.source.production_source_tree_identical,
  }
}

async function gitOutput(cwd: string, args: string[]) {
  const child = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "" },
  })
  if ((await child.exited) !== 0) throw new Error(`git ${args[0]} failed while capturing harness provenance`)
  return (await new Response(child.stdout).text()).trim()
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
