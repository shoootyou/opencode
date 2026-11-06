export function normalizeAccountName(raw: string): string | undefined {
  return raw.trim() || undefined
}

export function isDuplicateAccountName(name: string, labels: readonly string[]): boolean {
  const wanted = normalizeAccountName(name)?.toLowerCase()

  return wanted !== undefined && labels.some((label) => label.trim().toLowerCase() === wanted)
}
