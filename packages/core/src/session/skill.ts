export * as SessionSkill from "./skill.js"

import type { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { ForkCapabilities } from "../fork/capabilities/service.js"
import { Instance } from "../instance/service.js"
import { Skill } from "../skill.js"

export type Snapshot = ForkCapabilities.Snapshot

export const snapshot = Effect.fn("SessionSkill.snapshot")(function* (input: { session: Session.Info }) {
  const instances = yield* Instance.Service
  return yield* ForkCapabilities.Service.use((capability) => capability.snapshot(input)).pipe(instances.provide(input.session))
})

export const get = Effect.fn("SessionSkill.get")(function* (input: { session: Session.Info; skill: Skill.ID }) {
  const instances = yield* Instance.Service
  return yield* ForkCapabilities.Service.use((capability) => capability.get(input)).pipe(instances.provide(input.session))
})
