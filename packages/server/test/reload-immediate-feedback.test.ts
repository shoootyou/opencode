/**
 * @spec-handoff
 * @interface POST /api/session/:sessionID/command { name: "reload", text: "" }: 204
 * @behavior
 *   - Returns only after a marked, described reload notice is projected into the session transcript.
 *   - Leaves no reload feedback item in the pending inbox and does not require a follow-up prompt.
 * @edge-cases
 *   - Reload count wording is singular only for one and plural for zero or many.
 *   - A later prompt follows the persisted notice in canonical transcript order.
 * @see ../../core/src/fork/plugin/reload-command.ts
 */
import { expect } from "bun:test"
import { OpenCode } from "@opencode/client"
import { Effect } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

it.live("projects /reload feedback before the HTTP command response without an inbox item", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      config: { project: false },
      models: { fetch: false },
      fs: { filewatcher: false },
    })
    const api = OpenCode.make({
      baseUrl: "http://opencode.local",
      fetch: Object.assign((input: string | URL | Request, init?: RequestInit) => handler(new Request(input, init)), {
        preconnect: fetch.preconnect,
      }),
    })
    const session = yield* Effect.promise(() => api.session.create({ title: "Reload feedback" }))

    yield* Effect.promise(() => api.session.command({ sessionID: session.id, name: "reload", text: "" }))

    const messages = yield* Effect.promise(() => api.message.list({ sessionID: session.id }))
    const inbox = yield* Effect.promise(() => api.session.inbox.list({ sessionID: session.id }))
    expect(messages.data).toEqual([
      expect.objectContaining({
        type: "synthetic",
        text: "Reloaded 0 skills.",
        description: "Reloaded 0 skills.",
        metadata: expect.objectContaining({
          "opencode.fork.displayOnly": true,
          source: "command",
          command: "reload",
          outcome: "success",
        }),
      }),
    ])
    expect(inbox).toEqual([])
  }),
)
