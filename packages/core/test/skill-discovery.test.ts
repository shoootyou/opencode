/**
 * @spec-handoff
 * @interface SkillDiscovery.pull(catalog: string): Effect<ReadonlyArray<string>>
 * @behavior
 *   - Fetches remote v2 catalog files only for a manifest whose name and every file path are safe relative paths.
 *   - Rejects an unsafe manifest atomically: it returns no directory and performs no file fetch or cache write.
 *   - Preserves safe nested-file downloads and versioned cache staging behavior.
 * @edge-cases
 *   - Traversal, absolute, backslash, control, URL, query/fragment, and dot-component paths are unsafe.
 */
import fs from "fs/promises"
import path from "path"
import { createServer } from "node:http"
import { describe, expect } from "bun:test"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect } from "effect"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Global } from "@opencode/util/global"
import { SkillDiscovery } from "@opencode/core/skill/discovery"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const fixture = Effect.gen(function* () {
  const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir()))
  const state: {
    skills: unknown[]
    files: Record<string, string>
    requests: string[]
  } = { skills: [], files: {}, requests: [] }
  const server = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 })
  const base = new URL("/v2/skills/", HttpServer.formatAddress(server.address)).href
  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const url = new URL(request.url, base)
      state.requests.push(url.href)
      const body =
        url.pathname === "/v2/skills/index.json" ? JSON.stringify({ skills: state.skills }) : state.files[url.pathname]
      return HttpServerResponse.text(body ?? "Not Found", { status: body === undefined ? 404 : 200 })
    }),
  )
  return {
    cache: tmp.path,
    base,
    pull: (skills: unknown[], files: Record<string, string> = {}) =>
      Effect.gen(function* () {
        state.skills = skills
        state.files = files
        state.requests = []
        // Rebuild per pull so repeated calls exercise the disk cache, not a shared service.
        const directories = yield* Effect.gen(function* () {
          const discovery = yield* SkillDiscovery.Service
          return yield* discovery.pull(base)
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(SkillDiscovery.node, [Global.node.replace(Global.layerWith({ cache: tmp.path }))]),
          ),
        )
        return { directories, requests: state.requests.slice() }
      }),
  }
})

describe("SkillDiscovery.pull", () => {
  for (const input of [
    {
      name: "rejects a skill name containing plain traversal without fetching files",
      skills: [{ name: "../outside", files: ["SKILL.md"] }],
    },
    {
      name: "rejects a skill name containing encoded traversal without fetching files",
      skills: [{ name: "%2e%2e%2foutside", files: ["SKILL.md"] }],
    },
    {
      name: "rejects a skill name containing a POSIX absolute path without fetching files",
      skills: [{ name: "/tmp/outside", files: ["SKILL.md"] }],
    },
    {
      name: "rejects a skill name containing a Windows absolute path without fetching files",
      skills: [{ name: "C:\\outside", files: ["SKILL.md"] }],
    },
    {
      name: "rejects a skill name containing a backslash without fetching files",
      skills: [{ name: "nested\\outside", files: ["SKILL.md"] }],
    },
    {
      name: "rejects a skill name containing a NUL character without fetching files",
      skills: [{ name: "deploy\0outside", files: ["SKILL.md"] }],
    },
    {
      name: "rejects a skill name containing a control character without fetching files",
      skills: [{ name: "deploy\noutside", files: ["SKILL.md"] }],
    },
    {
      name: "rejects a skill name containing a URL without fetching files",
      skills: [{ name: "https://evil.example.test/outside", files: ["SKILL.md"] }],
    },
    {
      name: "rejects a skill name containing query injection without fetching files",
      skills: [{ name: "deploy?version=outside", files: ["SKILL.md"] }],
    },
    {
      name: "rejects a skill name containing fragment injection without fetching files",
      skills: [{ name: "deploy#outside", files: ["SKILL.md"] }],
    },
    {
      name: "rejects a dot skill-name component without fetching files",
      skills: [{ name: ".", files: ["SKILL.md"] }],
    },
    {
      name: "rejects a dot-dot skill-name component without fetching files",
      skills: [{ name: "..", files: ["SKILL.md"] }],
    },
    {
      name: "rejects a manifest with plain traversal atomically without fetching safe files",
      skills: [{ name: "deploy", files: ["SKILL.md", "../outside.md"] }],
    },
    {
      name: "rejects a manifest with encoded traversal atomically without fetching safe files",
      skills: [{ name: "deploy", files: ["SKILL.md", "%2e%2e%2foutside.md"] }],
    },
    {
      name: "rejects a manifest with a POSIX absolute path atomically without fetching safe files",
      skills: [{ name: "deploy", files: ["SKILL.md", "/tmp/outside.md"] }],
    },
    {
      name: "rejects a manifest with a Windows absolute path atomically without fetching safe files",
      skills: [{ name: "deploy", files: ["SKILL.md", "C:\\outside.md"] }],
    },
    {
      name: "rejects a manifest with a backslash path atomically without fetching safe files",
      skills: [{ name: "deploy", files: ["SKILL.md", "references\\outside.md"] }],
    },
    {
      name: "rejects a manifest with a NUL path atomically without fetching safe files",
      skills: [{ name: "deploy", files: ["SKILL.md", "outside\0.md"] }],
    },
    {
      name: "rejects a manifest with a control-character path atomically without fetching safe files",
      skills: [{ name: "deploy", files: ["SKILL.md", "outside\t.md"] }],
    },
    {
      name: "rejects a manifest with a URL-like path atomically without fetching safe files",
      skills: [{ name: "deploy", files: ["SKILL.md", "https://evil.example.test/outside.md"] }],
    },
    {
      name: "rejects a manifest with query injection atomically without fetching safe files",
      skills: [{ name: "deploy", files: ["SKILL.md", "references/guide.md?outside"] }],
    },
    {
      name: "rejects a manifest with fragment injection atomically without fetching safe files",
      skills: [{ name: "deploy", files: ["SKILL.md", "references/guide.md#outside"] }],
    },
    {
      name: "rejects a manifest with a dot component atomically without fetching safe files",
      skills: [{ name: "deploy", files: ["SKILL.md", "references/./guide.md"] }],
    },
    {
      name: "rejects a manifest with a dot-dot component atomically without fetching safe files",
      skills: [{ name: "deploy", files: ["SKILL.md", "references/../guide.md"] }],
    },
  ]) {
    it.live(
      input.name,
      Effect.gen(function* () {
        const catalog = yield* fixture
        const result = yield* catalog.pull(input.skills)
        expect(result.directories).toEqual([])
        expect(result.requests).toEqual([`${catalog.base}index.json`])
        expect(yield* Effect.promise(() => fs.readdir(catalog.cache))).toEqual([])
      }),
    )
  }

  it.live(
    "downloads safe nested files under the skill root",
    Effect.gen(function* () {
      const catalog = yield* fixture
      const result = yield* catalog.pull([{ name: "deploy", files: ["SKILL.md", "references/guide.md"] }], {
        "/v2/skills/deploy/SKILL.md": "# Deploy",
        "/v2/skills/deploy/references/guide.md": "# Guide",
      })
      expect(result.directories).toHaveLength(1)
      expect(result.requests.toSorted()).toEqual(
        [
          `${catalog.base}index.json`,
          `${catalog.base}deploy/SKILL.md`,
          `${catalog.base}deploy/references/guide.md`,
        ].toSorted(),
      )
      expect(yield* Effect.promise(() => Bun.file(path.join(result.directories[0], "SKILL.md")).text())).toBe(
        "# Deploy",
      )
      expect(
        yield* Effect.promise(() => Bun.file(path.join(result.directories[0], "references", "guide.md")).text()),
      ).toBe("# Guide")
    }),
  )

  it.live(
    "refreshes cached files when the version changes",
    Effect.gen(function* () {
      const catalog = yield* fixture
      const first = yield* catalog.pull([{ name: "deploy", version: "1", files: ["SKILL.md"] }], {
        "/v2/skills/deploy/SKILL.md": "# Old",
      })
      const second = yield* catalog.pull([{ name: "deploy", version: "2", files: ["SKILL.md"] }], {
        "/v2/skills/deploy/SKILL.md": "# New",
      })

      expect(yield* Effect.promise(() => Bun.file(path.join(first.directories[0], "SKILL.md")).text())).toBe("# New")
      expect(second.requests).toContain(`${catalog.base}deploy/SKILL.md`)
      const third = yield* catalog.pull([{ name: "deploy", version: "2", files: ["SKILL.md"] }], {
        "/v2/skills/deploy/SKILL.md": "# Ignored",
      })
      expect(third.requests).toEqual([`${catalog.base}index.json`])
    }),
  )

  it.live(
    "publishes complete updates and removes stale files",
    Effect.gen(function* () {
      const catalog = yield* fixture
      const first = yield* catalog.pull([{ name: "deploy", version: "1", files: ["SKILL.md", "old.md"] }], {
        "/v2/skills/deploy/SKILL.md": "# Old",
        "/v2/skills/deploy/old.md": "old reference",
      })
      const root = first.directories[0]

      yield* catalog.pull([{ name: "deploy", version: "2", files: ["SKILL.md", "missing.md"] }], {
        "/v2/skills/deploy/SKILL.md": "# Partial",
      })
      expect(yield* Effect.promise(() => Bun.file(path.join(root, "SKILL.md")).text())).toBe("# Old")
      expect(yield* Effect.promise(() => Bun.file(path.join(root, "old.md")).text())).toBe("old reference")

      yield* catalog.pull([{ name: "deploy", version: "3", files: ["SKILL.md"] }], {
        "/v2/skills/deploy/SKILL.md": "# New",
      })
      expect(yield* Effect.promise(() => Bun.file(path.join(root, "SKILL.md")).text())).toBe("# New")
      expect(yield* Effect.promise(() => Bun.file(path.join(root, "old.md")).exists())).toBe(false)
    }),
  )
})
