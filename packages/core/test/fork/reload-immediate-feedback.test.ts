/**
 * @spec-handoff
 * @interface POST /api/session/:sessionID/command { name: "reload" }: 204 | HTTP command failure
 * @behavior
 *   - Projects exactly one marked, described synthetic reload result before the command completes.
 *   - Keeps feedback out of model conversion and preserves ordinary synthetic guidance.
 * @edge-cases
 *   - Typed reload failures publish their safe notice then retain the HTTP failure; interrupts and defects pass through.
 *   - No inbox admission, wake, resume, or provider call occurs; later prompts retain canonical ordering.
 * @see ../../src/fork/plugin/reload-command.ts
 */
import { describe, expect, test } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { Command } from "@opencode/core/command"
import { ConfigSkillReload } from "@opencode/core/config/skill-reload"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { ReloadCommand } from "@opencode/core/fork/plugin/reload-command"
import { ForkCapabilities } from "@opencode/core/fork/capabilities/service"
import { Location } from "@opencode/core/location"
import { Mcp } from "@opencode/core/mcp/index"
import { toLLMMessages } from "@opencode/core/session/runner/to-llm-message"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/schema/session"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { SessionMessage } from "@opencode/core/session/message"
import { DateTime, Effect, Layer } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { emptyMcpLayer } from "../fixture/mcp"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const model = Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("test") })
const directory = AbsolutePath.make("/repo/packages/app")
const locationLayer = Layer.succeed(Location.Service, Location.Service.of(location({ directory })))
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Command.node, Mcp.node, Bus.node, ConfigSkillReload.node]), [
    Mcp.node.replace(emptyMcpLayer),
    Location.node.replace(locationLayer),
  ]),
)
const feedback = {
  id: SessionMessage.ID.make("msg_reload"),
  type: "synthetic" as const,
  text: "Reloaded 1 skill.",
  description: "Reloaded 1 skill.",
  metadata: { "opencode.fork.displayOnly": true, source: "command", command: "reload", outcome: "success" },
  time: { created: DateTime.makeUnsafe(1) },
}

describe("/reload immediate feedback", () => {
  test("excludes marked feedback from canonical LLM messages while retaining ordinary synthetic guidance", () => {
    const ordinary = {
      id: SessionMessage.ID.make("msg_guidance"),
      type: "synthetic" as const,
      text: "Use the refreshed skill.",
      time: { created: DateTime.makeUnsafe(2) },
    }

    expect(toLLMMessages([feedback, ordinary], model).map((message) => message.content)).toEqual([
      [{ type: "text", text: "Use the refreshed skill." }],
    ])
  })

  it.effect("publishes reload feedback directly instead of admitting an inbox synthetic", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      let reloads = 0
      yield* ReloadCommand.Plugin.effect(
        host({
          command: {
            list: () => command.list().pipe(Effect.map((data) => ({ location: { directory }, data }))),
            transform: command.transform,
            reload: command.reload,
          },
          session: { synthetic: () => Effect.die("reload feedback must not enter session_inbox") },
        }),
      ).pipe(
        Effect.provideService(
          ForkCapabilities.Service,
          ForkCapabilities.Service.of({
            snapshot: () => Effect.die("unused"),
            get: () => Effect.die("unused"),
            catalogue: () => Effect.die("unused"),
            resolve: () => Effect.die("unused"),
            reload: () => Effect.sync(() => ({ count: ++reloads })),
          }),
        ),
        Effect.provide(locationLayer),
      )
      yield* command.execute({
        name: "reload",
        invocation: { sessionID: Session.ID.make("ses_reload_direct"), prompt: { text: "" }, delivery: "steer" },
      })
      expect(reloads).toBe(1)
    }),
  )
})
