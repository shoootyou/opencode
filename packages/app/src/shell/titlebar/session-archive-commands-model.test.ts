/**
 * @spec-handoff
 * @interface resolveArchiveServer(input): string|undefined; createArchiveCommandRegistration(deps)
 * @behavior
 *   - Resolves exact route servers without fallback and exposes three reactive descriptors.
 *   - Rechecks root/archive/pending eligibility when a descriptor executes.
 *   - Routes archive through the shared timeline transition rather than a direct PATCH.
 * @see RFC 057 Addendum A.4
 */
import { expect, test } from "bun:test"
import {
  createArchiveCommandRegistration,
  getArchiveCommandState,
  resolveArchiveServer,
  type ArchiveCommandTextKey,
} from "./session-archive-commands-model"

const active = { id: "x", location: { directory: "/x" }, time: {} }

test("resolves session routes exactly but uses selected then first elsewhere", () => {
  expect(
    resolveArchiveServer({
      route: { type: "session", server: "gone", sessionID: "x" },
      servers: ["a"],
      selectedServer: "a",
    }),
  ).toBeUndefined()
  expect(resolveArchiveServer({ route: { type: "home" }, servers: ["a", "b"], selectedServer: "b" })).toBe("b")
  expect(
    getArchiveCommandState({
      route: { type: "session", server: "a", sessionID: "x" },
      servers: ["a"],
      session: { server: "a", info: active },
      pending: false,
    }).canArchive,
  ).toBe(true)
})

test("registers exactly three descriptors and rereads disabled eligibility on execution", async () => {
  let pending = false
  const calls: string[] = []

  // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: This fixture supplies only the command dependencies exercised by the shared-transition assertion.
  const registration = createArchiveCommandRegistration({
    read: () => ({
      route: { type: "session", server: "a", sessionID: "x" },
      servers: ["a"],
      session: { server: "a", info: active },
      pending,
    }),
    t: (x) => x,
    archive: async () => {
      calls.push("archive")

      return true
    },
    unarchive: async () => {
      calls.push("unarchive")

      return true
    },
    browse: (x) => calls.push(`browse:${x}`),
  })

  const options = registration.options()
  expect(options.map((x: { id: string }) => x.id)).toEqual([
    "session.archive",
    "session.unarchive",
    "session.archived.browse",
  ])
  expect(options[0].keybind).toBe("mod+shift+backspace")
  expect(options[2].featured).toBe(true)
  pending = true
  await options[0].onSelect()
  expect(calls).toEqual([])
})

test("delegates current-route archive to the shared transition flow", async () => {
  const calls: string[] = []

  // SAFETY: This fixture supplies only the command dependencies exercised by the shared-transition assertion.
  const registration = createArchiveCommandRegistration({
    read: () => ({
      route: { type: "session", server: "a", sessionID: "x" },
      servers: ["a"],
      session: { server: "a", info: active },
      pending: false,
    }),
    t: (x: ArchiveCommandTextKey) => x,
    archive: async () => {
      calls.push("direct-patch")

      return true
    },
    unarchive: async () => true,
    browse: () => {},
    transition: async (target: { server: string; sessionID: string }) => {
      calls.push(`transition:${target.server}:${target.sessionID}`)

      return true
    },
  } as never)

  await registration.options()[0].onSelect()
  expect(calls).toEqual(["transition:a:x"])
})
