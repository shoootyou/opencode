/**
 * @spec-handoff
 * @interface Unit1Topology(): void
 * @behavior
 *   - Resolves the 30 Unit 1 paths to the v2.0.28 package and Turbo topology.
 *   - Keeps the 21 v2 manifests and deletes the nine obsolete v1-only manifests.
 *   - Uses v2 package identities, dependencies, PWA wiring, and the Desktop → App typecheck edge.
 * @edge-cases
 *   - Enterprise may retain published @opencode-ai/sdk@1.18.21, never a workspace SDK pointer.
 * @see ../packages/app/vite.config.ts
 */
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const survivingManifests = [
  "packages/app/package.json",
  "packages/cli/package.json",
  "packages/codemode/package.json",
  "packages/console/app/package.json",
  "packages/console/function/package.json",
  "packages/core/package.json",
  "packages/desktop/package.json",
  "packages/enterprise/package.json",
  "packages/function/package.json",
  "packages/http-recorder/package.json",
  "packages/plugin/package.json",
  "packages/sdk/package.json",
  "packages/server/package.json",
  "packages/session-ui/package.json",
  "packages/stats/app/package.json",
  "packages/stats/core/package.json",
  "packages/stats/server/package.json",
  "packages/tui/package.json",
  "packages/ui/package.json",
  "packages/web/package.json",
  "sdks/vscode/package.json",
]

const obsoleteManifests = [
  "packages/console/core/package.json",
  "packages/console/mail/package.json",
  "packages/console/support/package.json",
  "packages/effect-drizzle-sqlite/package.json",
  "packages/effect-sqlite-node/package.json",
  "packages/llm/package.json",
  "packages/opencode/package.json",
  "packages/sdk/js/package.json",
  "packages/slack/package.json",
]

const packageJSON = async (relative: string) => JSON.parse(await Bun.file(path.join(root, relative)).text())

const workspaceDependencies = (manifest: Record<string, unknown>) => {
  const sections = ["dependencies", "devDependencies", "optionalDependencies"] as const
  return Object.fromEntries(
    sections.flatMap((section) =>
      Object.entries((manifest[section] as Record<string, string> | undefined) ?? {}).filter(([, value]) => value === "workspace:*"),
    ),
  )
}

describe("Plan 346 Unit 1 v2 topology", () => {
  test("retains exactly the 21 v2 manifests, removes nine v1-only manifests, and identifies every v2 package", async () => {
    expect([...survivingManifests, ...obsoleteManifests]).toHaveLength(30)
    expect(await Promise.all(survivingManifests.map((file) => Bun.file(path.join(root, file)).exists()))).toEqual(
      Array(survivingManifests.length).fill(true),
    )
    expect(await Promise.all(obsoleteManifests.map((file) => Bun.file(path.join(root, file)).exists()))).toEqual(
      Array(obsoleteManifests.length).fill(false),
    )

    for (const file of survivingManifests) {
      const manifest = await packageJSON(file)
      expect(manifest.version, file).toBe("2.0.28")
      expect(manifest.name, file).toMatch(file === "sdks/vscode/package.json" ? /^opencode$/ : /^@opencode\//)
    }
  })

  test("uses only v2 workspace names and preserves the published enterprise SDK exception", async () => {
    const manifests = await Promise.all(survivingManifests.map(async (file) => [file, await packageJSON(file)] as const))
    const oldWorkspacePointers = manifests.flatMap(([file, manifest]) =>
      Object.entries(workspaceDependencies(manifest)).filter(([name]) => name.startsWith("@opencode-ai/")).map(([name]) => `${file}: ${name}`),
    )
    expect(oldWorkspacePointers).toEqual([])

    const enterprise = await packageJSON("packages/enterprise/package.json")
    expect(enterprise.dependencies["@opencode-ai/sdk"]).toBe("1.18.21")
    expect(enterprise.dependencies["@opencode-ai/sdk"]).not.toBe("workspace:*")
  })

  test("keeps the v2 direct workspace dependency topology for cli, core, server, app, and tui", async () => {
    const expected = {
      "packages/cli/package.json": ["@opencode/client", "@opencode/plugin", "@opencode/protocol", "@opencode/schema", "@opencode/script", "@opencode/server", "@opencode/tui", "@opencode/util"],
      "packages/core/package.json": ["@opencode/ai", "@opencode/codemode", "@opencode/http-recorder", "@opencode/plugin", "@opencode/plugin-browser", "@opencode/schema", "@opencode/util"],
      "packages/server/package.json": ["@opencode/client", "@opencode/core", "@opencode/plugin", "@opencode/protocol", "@opencode/schema", "@opencode/simulation", "@opencode/util"],
      "packages/app/package.json": ["@opencode/client", "@opencode/gui-extensions", "@opencode/schema", "@opencode/session-ui", "@opencode/ui", "@opencode/util"],
      "packages/tui/package.json": ["@opencode/client", "@opencode/core", "@opencode/latex", "@opencode/merman", "@opencode/plugin", "@opencode/schema", "@opencode/simulation", "@opencode/theme", "@opencode/ui", "@opencode/util"],
    }

    for (const [file, dependencies] of Object.entries(expected)) {
      expect(Object.keys(workspaceDependencies(await packageJSON(file))).sort(), file).toEqual(dependencies)
    }

    const directDependencyNames = Object.values(expected).flat()
    expect(directDependencyNames.join("\n")).not.toMatch(/geo|athena|firehose/i)
    expect(directDependencyNames).not.toContain("@opencode/desktop")
    expect(directDependencyNames).not.toContain("@opencode-ai/desktop")
    expect((await packageJSON("packages/tui/package.json")).dependencies).not.toMatchObject({ clipboardy: expect.anything(), open: expect.anything() })
  })

  test("pins the app PWA dependencies and keeps both production consumers", async () => {
    const app = await packageJSON("packages/app/package.json")
    expect(app.devDependencies["vite-plugin-pwa"]).toBe("1.3.0")
    expect(app.devDependencies["workbox-window"]).toBe("7.4.1")
    expect(await Bun.file(path.join(root, "packages/app/vite.config.ts")).text()).toContain('from "vite-plugin-pwa"')
    expect(await Bun.file(path.join(root, "packages/app/vite.config.ts")).text()).toContain("VitePWA(")
    expect(await Bun.file(path.join(root, "packages/app/src/shell/titlebar/PwaUpdatePrompt.tsx")).text()).toContain('from "virtual:pwa-register/solid"')
    expect(await Bun.file(path.join(root, "packages/app/src/shell/titlebar/PwaUpdatePrompt.tsx")).text()).toContain("useRegisterSW(")
  })

  test("keeps the v2 Turbo graph, removes old task keys, and makes desktop typecheck wait for app", async () => {
    const turbo = await packageJSON("turbo.json")
    expect(turbo.tasks).toHaveProperty("typecheck")
    expect(turbo.tasks).toHaveProperty("@opencode/desktop#typecheck")
    expect(turbo.tasks["@opencode/desktop#typecheck"].dependsOn).toEqual(["@opencode/app#typecheck"])
    expect(Object.keys(turbo.tasks).filter((name) => name.startsWith("@opencode-ai/"))).toEqual([])
    expect(turbo.tasks).not.toHaveProperty("@opencode-ai/desktop#typecheck")
  })
})
