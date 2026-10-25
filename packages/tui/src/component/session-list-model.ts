export function shouldKeepSessionScopeBinding(input: {
  archiveBindings: () => readonly unknown[]
  matchesCtrlA: (binding: unknown) => boolean
}): boolean {
  return !input.archiveBindings().some(input.matchesCtrlA)
}
