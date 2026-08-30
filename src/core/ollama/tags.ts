import { BodyAbortedError, LimitedBodyError, readLimitedResponse } from "../../core/http-body.js";
import { isRecord } from "../json.js";

export type OllamaTag = {
  name: string;
  model?: string;
  details?: {
    context_length?: number;
    family?: string;
    parameter_size?: string;
  };
  capabilities?: string[];
  remote_host?: string;
};

export const OLLAMA_TAGS_TIMEOUT_MS = 5_000;

/** Cap on the /api/tags response body; real model lists stay far below this. */
export const OLLAMA_TAGS_MAX_BYTES = 1_048_576;

export async function loadOllamaTags(
  ollamaUrl: string,
  timeoutMs = OLLAMA_TAGS_TIMEOUT_MS,
): Promise<OllamaTag[]> {
  const url = `${ollamaUrl.replace(/\/$/, "")}/api/tags`;
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error(`Ollama /api/tags timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
  if (!response.ok) {
    throw new Error(`Ollama /api/tags failed: ${response.status} ${response.statusText}`);
  }
  const payload: unknown = await readTagsBody(response, signal, timeoutMs);
  if (!isRecord(payload) || !Array.isArray(payload.models)) {
    throw new Error("Ollama /api/tags returned an unexpected payload");
  }
  return payload.models.filter(isRecord).map((model) => ({
    name: typeof model.name === "string" ? model.name : "",
    model: typeof model.model === "string" ? model.model : undefined,
    details: isRecord(model.details)
      ? {
          context_length:
            typeof model.details.context_length === "number"
              ? model.details.context_length
              : undefined,
          family: typeof model.details.family === "string" ? model.details.family : undefined,
          parameter_size:
            typeof model.details.parameter_size === "string"
              ? model.details.parameter_size
              : undefined,
        }
      : undefined,
    capabilities: Array.isArray(model.capabilities)
      ? model.capabilities.filter((item): item is string => typeof item === "string")
      : [],
    remote_host: typeof model.remote_host === "string" ? model.remote_host : undefined,
  })).filter((tag) => tag.name.length > 0);
}

async function readTagsBody(
  response: Response,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<unknown> {
  let text: string;
  try {
    text = await readLimitedResponse(response, {
      maxBytes: OLLAMA_TAGS_MAX_BYTES,
      signal,
    });
  } catch (error) {
    if (error instanceof BodyAbortedError) {
      throw new Error(`Ollama /api/tags timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LimitedBodyError("body_malformed", "Ollama /api/tags returned a malformed body");
  }
}
