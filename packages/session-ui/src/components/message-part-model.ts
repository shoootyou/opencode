export function formatModelLabel(
  providerID: string | undefined,
  modelID: string | undefined,
  provider: { models: Record<string, { name: string }> } | undefined,
): string {
  if (!providerID || !modelID) return ""
  const modelLabel = provider?.models?.[modelID]?.name ?? modelID
  return `${providerID}/${modelLabel}`
}

export function formatMessageContentModelLabel(
  model: { providerID: string; id: string; variant?: string },
  provider: { models: Record<string, { name: string }> } | undefined,
  formatVariant: (model: string, variant: string) => string,
) {
  const label = formatModelLabel(model.providerID, model.id, provider)
  if (!model.variant || model.variant === "default") return label
  return formatVariant(label, model.variant[0]?.toUpperCase() + model.variant.slice(1))
}
