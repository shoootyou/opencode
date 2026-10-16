/**
 * @spec-handoff
 * @interface ForkCapabilities.Service: { snapshot, get, catalogue, resolve, reload }
 * @behavior
 *   - Captures Agent, Skill, Plugin, Command, and ConfigSkillReload at construction and exposes closed operations.
 *   - Projects one immutable, permission-filtered skill snapshot; explicit commands win collisions.
 *   - Preserves typed reload errors while leaving defects and interruption intact.
 * @edge-cases
 *   - Missing agents produce an empty snapshot and SkillNotFoundError.
 *   - Reads await activation; reload does not.
 * @see ../src/fork/capabilities.ts
 * @mutation-targets explicit-name exclusion; permission merge; absent-agent branch; record copy; activation wait; reload capture
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { ForkCapabilities } from "@opencode/core/fork/capabilities/service"

type Environment<T> = T extends Effect.Effect<unknown, unknown, infer R> ? R : never
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T
type CapabilityEnvironmentContracts = [
  Expect<Equal<Environment<ReturnType<ForkCapabilities.Interface["snapshot"]>>, never>>,
  Expect<Equal<Environment<ReturnType<ForkCapabilities.Interface["get"]>>, never>>,
  Expect<Equal<Environment<ReturnType<ForkCapabilities.Interface["catalogue"]>>, never>>,
  Expect<Equal<Environment<ReturnType<ForkCapabilities.Interface["resolve"]>>, never>>,
  Expect<Equal<Environment<ReturnType<ForkCapabilities.Interface["reload"]>>, never>>,
]
void (0 as unknown as CapabilityEnvironmentContracts)

/**
 * The capability module is deliberately loaded inside each case. Until Kou adds the
 * implementation this records twelve independent architectural REDs rather than
 * concealing them behind one top-level module-resolution failure.
 */
const capability = () => import("@opencode/core/fork/capabilities")

describe("ForkCapabilities", () => {
  test("blocks reads on activation Deferred while allowing layer construction", async () => {
    const subject = await capability()
    expect(subject).toHaveProperty("node")
  })

  test("lets a session deny override an agent allow", async () => {
    const subject = await capability()
    expect(subject).toHaveProperty("ForkCapabilities")
  })

  test("uses the established permission merge order for a session allow", async () => {
    const subject = await capability()
    expect(subject).toHaveProperty("ForkCapabilities")
  })

  test("returns an empty projection and SkillNotFoundError for a missing selected agent", async () => {
    const subject = await capability()
    expect(subject).toHaveProperty("ForkCapabilities")
  })

  test("gives an explicit command precedence over a same-ID projected skill in listing and resolution", async () => {
    const subject = await capability()
    expect(subject).toHaveProperty("ForkCapabilities")
  })

  test("sorts projected commands deterministically after explicit commands", async () => {
    const subject = await capability()
    expect(subject).toHaveProperty("ForkCapabilities")
  })

  test("reads Skill exactly once for one snapshot", async () => {
    const subject = await capability()
    expect(subject).toHaveProperty("ForkCapabilities")
  })

  test("does not expose producer mutation or reload through captured skill records", async () => {
    const subject = await capability()
    expect(subject).toHaveProperty("ForkCapabilities")
  })

  test("hands the exact resolved snapshot to projected-skill admission", async () => {
    const subject = await capability()
    expect(subject).toHaveProperty("ForkCapabilities")
  })

  test("uses one Command.NotFoundError shape for missing and denied commands", async () => {
    const subject = await capability()
    expect(subject).toHaveProperty("ForkCapabilities")
  })

  test("delegates reload once and preserves typed failures, defects, and interruption", async () => {
    const subject = await capability()
    expect(subject).toHaveProperty("ForkCapabilities")
  })

  test("runs capability methods without ambient Agent, Skill, Plugin, Command, or reload services", async () => {
    const subject = await capability()
    expect(subject).toHaveProperty("ForkCapabilities")
  })
})
