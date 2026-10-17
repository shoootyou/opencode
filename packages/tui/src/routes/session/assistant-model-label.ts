import type { ModelInfo, SessionMessageAssistant } from "@opencode/client"
import { providerModel } from "../../util/model"

export function assistantModelLabel(
  models: readonly Pick<ModelInfo, "providerID" | "modelID" | "name">[] | undefined,
  message: Pick<SessionMessageAssistant, "model"> | { providerID: string; modelID: string },
) {
  const model = "model" in message ? message.model : message
  return providerModel(models, model.providerID, "modelID" in model ? model.modelID : model.id)
}
