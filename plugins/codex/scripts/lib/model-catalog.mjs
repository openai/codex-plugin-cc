function isUnsupportedMethodError(error) {
  if (error?.rpcCode === -32601) {
    return true;
  }
  return /unknown (variant|method)|unsupported method|method not found/i.test(
    String(error?.message ?? error ?? "")
  );
}

async function readModelCatalog(client) {
  const models = [];
  let cursor = null;

  try {
    do {
      const response = await client.request("model/list", {
        cursor,
        limit: 100,
        includeHidden: true
      });
      models.push(...(response.data ?? []));
      cursor = response.nextCursor ?? null;
    } while (cursor);
  } catch (error) {
    if (isUnsupportedMethodError(error)) {
      return null;
    }
    throw error;
  }

  return models;
}

function supportedEfforts(model) {
  return (model.supportedReasoningEfforts ?? [])
    .map((option) => String(option.reasoningEffort ?? "").trim().toLowerCase())
    .filter(Boolean);
}

export async function validateReasoningSelection(client, selection = {}) {
  const modelName = String(selection.model ?? "").trim();
  const effort = String(selection.effort ?? "").trim().toLowerCase();
  const provider = String(selection.modelProvider ?? "").trim().toLowerCase();
  if (!effort || provider !== "openai") {
    return;
  }

  const catalog = await readModelCatalog(client);
  if (!catalog) {
    return;
  }

  const model = modelName
    ? catalog.find((candidate) => candidate.model === modelName || candidate.id === modelName)
    : catalog.find((candidate) => candidate.isDefault === true);
  if (!model) {
    return;
  }
  const selectedModelName = model.model ?? model.id ?? modelName;

  const efforts = supportedEfforts(model);
  if (efforts.length === 0 || efforts.includes(effort)) {
    return;
  }

  throw new Error(
    `Reasoning effort "${effort}" is not supported by model "${selectedModelName}". Supported efforts: ${efforts.join(", ")}.`
  );
}

export async function validateExplicitReasoningSelection(client, cwd, selection = {}, options = {}) {
  if (!selection.model && !selection.effort && !options.includeInherited) {
    return;
  }

  let config;
  try {
    const response = await client.request("config/read", { cwd, includeLayers: false });
    config = response.config ?? {};
  } catch (error) {
    if (isUnsupportedMethodError(error)) {
      return;
    }
    throw error;
  }

  await validateReasoningSelection(client, {
    model: selection.model ?? config.model,
    effort: selection.effort ?? config.model_reasoning_effort,
    modelProvider: config.model_provider ?? "openai"
  });
}
