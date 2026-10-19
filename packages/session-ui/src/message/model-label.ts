import {
  formatModelLabel,
  readModelLabelRef,
  type FormatModelVariant,
  type ModelLabelRef,
} from "@opencode/util/model-label"

type ProviderNames = ReadonlyMap<
  string,
  {
    models: Readonly<Record<string, { name: string }>>
  }
>

export function assistantModelLabel(
  model: ModelLabelRef | undefined,
  providers: ProviderNames | undefined,
  formatVariant: FormatModelVariant,
): string {
  const reference = readModelLabelRef(model)

  const name =
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- untrusted catalog data: primitive-string-only identity gate; no coercion.
    typeof reference?.providerID === "string" && typeof reference.id === "string"
      ? catalogName(providers, reference.providerID, reference.id)
      : undefined

  return formatModelLabel(reference, name, formatVariant)
}

function catalogName(providers: ProviderNames | undefined, providerID: string, id: string): string | undefined {
  try {
    const provider = providers?.get(providerID)

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- untrusted catalog data: primitive-string-only identity gate; no coercion.
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) return

    const models = provider.models

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- untrusted catalog data: primitive-string-only identity gate; no coercion.
    if (!models || typeof models !== "object" || Array.isArray(models) || !Object.hasOwn(models, id)) return

    const model = models[id]

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- untrusted catalog data: primitive-string-only identity gate; no coercion.
    if (!model || typeof model !== "object" || Array.isArray(model)) return

    const name = model.name

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- untrusted catalog data: primitive-string-only identity gate; no coercion.
    return typeof name === "string" ? name : undefined
  } catch {
    return
  }
}
