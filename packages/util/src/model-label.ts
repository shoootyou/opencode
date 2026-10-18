export type ModelLabelRef = Readonly<{
  providerID?: string
  id?: string
  variant?: string
}>

export type FormatModelVariant = (label: string, variant: string) => string

export function formatModelLabel(model: ModelLabelRef | undefined, name?: string, formatVariant?: FormatModelVariant): string {
  if (!model?.providerID || !model.id) return ""

  const label = `${model.providerID}/${name ?? model.id}`
  if (!model.variant || model.variant === "default") return label

  const variant = model.variant[0].toUpperCase() + model.variant.slice(1)
  return (formatVariant ?? ((label, variant) => `${label} (${variant})`))(label, variant)
}
