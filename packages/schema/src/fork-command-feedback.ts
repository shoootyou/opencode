export const DISPLAY_ONLY_MARKER = "opencode.fork.displayOnly"

export function isDisplayOnly(message: unknown) {
  if (typeof message !== "object" || message === null) return false
  const record = message as Record<string, unknown>
  if (record.type !== "synthetic" || typeof record.metadata !== "object" || record.metadata === null) return false
  return (record.metadata as Record<string, unknown>)[DISPLAY_ONLY_MARKER] === true
}
