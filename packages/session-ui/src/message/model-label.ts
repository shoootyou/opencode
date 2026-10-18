import { formatModelLabel, type FormatModelVariant, type ModelLabelRef } from "@opencode/util/model-label"

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
  const provider = model?.providerID ? providers?.get(model.providerID) : undefined
  const name = model?.id && provider && Object.hasOwn(provider.models, model.id) ? provider.models[model.id]?.name : undefined
  return formatModelLabel(model, name, formatVariant)
}
