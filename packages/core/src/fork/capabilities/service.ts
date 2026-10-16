export * as ForkCapabilities from "./service.js"

import type { Session } from "@opencode/schema/session"
import type { Skill } from "@opencode/schema/skill"
import { Context, type Effect } from "effect"
import type { Command } from "../../command.js"
import type { ConfigSkillReload } from "../../config/skill-reload.js"
import type { SkillNotFoundError } from "../../session/error.js"

export type Snapshot = {
  readonly skills: ReadonlyMap<Skill.ID, Skill.Info>
}

export type Resolved =
  | { readonly type: "command"; readonly definition: Command.Definition }
  | { readonly type: "skill"; readonly skill: Skill.Info; readonly snapshot: Snapshot }

export type ReloadError = ConfigSkillReload.ReloadUnavailable | ConfigSkillReload.ReloadFailed

export interface Interface {
  readonly snapshot: (input: { readonly session: Session.Info }) => Effect.Effect<Snapshot>
  readonly get: (input: { readonly session: Session.Info; readonly skill: Skill.ID }) => Effect.Effect<Skill.Info, SkillNotFoundError>
  readonly catalogue: (input: { readonly session: Session.Info }) => Effect.Effect<Command.Info[]>
  readonly resolve: (input: { readonly session: Session.Info; readonly command: string }) => Effect.Effect<Resolved, Command.NotFoundError>
  readonly reload: () => Effect.Effect<{ readonly count: number }, ReloadError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ForkCapabilities") {}
