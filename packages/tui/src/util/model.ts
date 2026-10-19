import { formatModelLabel, readModelLabelRef, type ModelLabelRef } from "@opencode/util/model-label"

export function parse(value: string) {
  const [providerID, ...modelID] = value.split("/")
  return { providerID, modelID: modelID.join("/") }
}

export function formatRef(model: { providerID: string; id: string; variant?: string }) {
  return [model.providerID, model.id, model.variant].filter((value) => value !== undefined).join("/")
}

export function assistantModelLabel(
  model: ModelLabelRef | undefined,
  models: readonly Readonly<{ providerID: string; id: string; name: string }>[] | undefined,
) {
  const reference = readModelLabelRef(model)
  const name =
    typeof reference?.providerID === "string" && typeof reference.id === "string"
      ? catalogName(models, reference.providerID, reference.id)
      : undefined
  return formatModelLabel(reference, name)
}

function catalogName(
  models: readonly Readonly<{ providerID: string; id: string; name: string }>[] | undefined,
  providerID: string,
  id: string,
): string | undefined {
  try {
    return models?.find((item) => {
      const itemProviderID = item.providerID
      const itemID = item.id
      return itemProviderID === providerID && itemID === id
    })?.name
  } catch {
    return
  }
}

export function switchLabel(
  model: { providerID: string; id: string; variant?: string },
  models?: readonly { providerID: string; id: string; name: string }[],
  previous?: { providerID: string; id: string; variant?: string },
) {
  if (previous?.providerID === model.providerID && previous.id === model.id)
    return `Switched variant to ${model.variant ?? "default"}`
  const display = models?.find((item) => item.providerID === model.providerID && item.id === model.id)?.name
  if (display === undefined) return `Switched model to ${formatRef(model)}`
  const variant = model.variant && model.variant !== "default" ? ` (${model.variant})` : ""
  return `Switched model to ${display}${variant}`
}
