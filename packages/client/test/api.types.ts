/**
 * @spec-handoff
 * @interface Session.Info.time.archived: number | undefined
 * @interface OpenCode.session.commands.list({ sessionID }): CommandInfo[]
 * @behavior
 *   - Generated Promise and Effect read models expose archive time as optional number only.
 *   - Promise and Effect clients expose nested session commands without replacing existing command operations.
 *   - Session command lists accept only sessionID and return command information arrays.
 * @edge-cases
 *   - Null is not accepted as a session archive read-model value.
 * @see ../src/promise/generated/types.ts
 */
import { Effect } from "effect"
import { OpenCode as EffectOpenCode, type AppApi as EffectApi } from "../src/effect"
import type { Session } from "@opencode/schema/session"
import type { DiscoverOptions } from "../src/service"
import type { CommandInfo } from "../src/promise/generated/types"

type EffectClient = Effect.Success<ReturnType<typeof EffectOpenCode.make>>
type PromiseClient = ReturnType<typeof import("../src/promise").OpenCode.make>

declare const effectClient: EffectClient
declare const promiseClient: PromiseClient

const exactVersion: DiscoverOptions = { version: "2.0.0" }
const compatibleVersion: DiscoverOptions = { version: (version) => version.startsWith("2.") }

const effectApi: EffectApi<unknown> = effectClient

type Expect<T extends true> = T
type IsExactly<T, U> = (<V>() => V extends T ? 1 : 2) extends <V>() => V extends U ? 1 : 2 ? true : false
type PromiseSession = Awaited<ReturnType<typeof promiseClient.session.get>>
type ArchiveTime = PromiseSession["time"]["archived"]
const archiveTimeStaysOptionalNumber: Expect<IsExactly<ArchiveTime, number | undefined>> = true

const effectSession: Effect.Effect<Session.Info, unknown> = effectClient.session.get({
  sessionID: "ses_test" as Session.ID,
})

declare const sessionID: Parameters<typeof effectApi.session.instructions.entry.list>[0]["sessionID"]

const effectList: Effect.Effect<
  ReadonlyArray<{ readonly key: string; readonly value: unknown }>,
  unknown
> = effectApi.session.instructions.entry.list({ sessionID })
const effectPut: Effect.Effect<void, unknown> = effectApi.session.instructions.entry.put({
  sessionID,
  key: "review-notes",
  value: { text: "Check the diff" },
})
const effectRemove: Effect.Effect<void, unknown> = effectApi.session.instructions.entry.remove({
  sessionID,
  key: "review-notes",
})

const promiseList: Promise<ReadonlyArray<{ readonly key: string; readonly value: unknown }>> =
  promiseClient.session.instructions.entry.list({ sessionID: "ses_test" })
const promisePut: Promise<void> = promiseClient.session.instructions.entry.put({
  sessionID: "ses_test",
  key: "review-notes",
  value: { text: "Check the diff" },
})
const promiseRemove: Promise<void> = promiseClient.session.instructions.entry.remove({
  sessionID: "ses_test",
  key: "review-notes",
})

const promiseSessionCommands: Promise<Array<CommandInfo>> = promiseClient.session.commands.list({ sessionID: "ses_test" })
const promiseSessionCommand: Promise<void> = promiseClient.session.command({
  sessionID: "ses_test",
  name: "review",
  text: "Review this",
})
const promiseGlobalCommands: Promise<{ location: { directory: string }; data: Array<CommandInfo> }> = promiseClient.command.list({
  location: { directory: "/repo" },
})
const effectSessionCommands: Effect.Effect<ReadonlyArray<CommandInfo>, unknown> = effectClient.session.commands.list({
  sessionID: "ses_test" as Session.ID,
})

void [
  effectSession,
  effectList,
  effectPut,
  effectRemove,
  promiseList,
  promisePut,
  promiseRemove,
  promiseSessionCommands,
  promiseSessionCommand,
  promiseGlobalCommands,
  effectSessionCommands,
  exactVersion,
  compatibleVersion,
  archiveTimeStaysOptionalNumber,
]
