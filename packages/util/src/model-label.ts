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
  const reference = readModelLabelRef(model)
  if (!reference || reference.providerID === "" || reference.id === "") return ""

  const provider = sanitizeComponent(reference.providerID)
  const modelName = sanitizeComponent(name) || sanitizeComponent(reference.id)
  if (!modelName) return ""

  const label = [provider, modelName].filter(Boolean).join("/")
  const variant = sanitizeComponent(reference.variant)
  if (!variant || variant === "default") return label

  return (formatVariant ?? ((label, variant) => `${label} (${variant})`))(
    label,
    capComponent(variant[0].toUpperCase() + variant.slice(1)),
  )
}

export function readModelLabelRef(model: ModelLabelRef | undefined): ModelLabelRef | undefined {
  if (!model || typeof model !== "object") return

  try {
    if (!Object.hasOwn(model, "providerID") || !Object.hasOwn(model, "id")) return
    return {
      providerID: model.providerID,
      id: model.id,
      variant: model.variant,
    } as ModelLabelRef
  } catch {
    return
  }
}

const forbiddenDisplayCharacter =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/u
const whitespace = /\s/u
const maxComponentCodePoints = 64

function sanitizeComponent(value: unknown): string {
  if (typeof value !== "string") return ""

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

    if (result.length > maxComponentCodePoints) return capComponent(result.join(""))
  }

  return result.join("")
}

function capComponent(value: string): string {
  const codePoints = Array.from(value)
  if (codePoints.length <= maxComponentCodePoints) return value
  return codePoints.slice(0, maxComponentCodePoints - 1).join("") + "…"
}
