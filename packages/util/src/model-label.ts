export type ModelLabelRef = Readonly<{
  providerID?: string
  id?: string
  variant?: string
}>

export type FormatModelVariant = (label: string, variant: string) => string

export function formatModelLabel(
  model: ModelLabelRef | undefined,
  name?: string,
  formatVariant?: FormatModelVariant,
): string {
  if (!model?.providerID || !model.id) return ""

  const provider = sanitizeComponent(model.providerID)
  const label = [provider, sanitizeComponent(name ?? "") || sanitizeComponent(model.id)].filter(Boolean).join("/")
  const variant = sanitizeComponent(model.variant ?? "")
  if (!variant || variant === "default") return label

  return (formatVariant ?? ((label, variant) => `${label} (${variant})`))(
    label,
    variant[0].toUpperCase() + variant.slice(1),
  )
}

const forbiddenDisplayCharacter =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/u
const whitespace = /\s/u
const maxComponentCodePoints = 64

function sanitizeComponent(value: string): string {
  const result: string[] = []
  let pendingSpace = false

  for (const character of value) {
    if (forbiddenDisplayCharacter.test(character)) continue
    if (whitespace.test(character)) {
      pendingSpace ||= result.length > 0
      continue
    }

    if (pendingSpace) result.push(" ")
    pendingSpace = false
    result.push(character)

    if (result.length > maxComponentCodePoints) return result.slice(0, maxComponentCodePoints - 1).join("") + "…"
  }

  return result.join("")
}
