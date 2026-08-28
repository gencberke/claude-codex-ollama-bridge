import type { JsonObject } from "../../core/json.js";
import { isRecord } from "../../core/json.js";
import { isEncryptedFieldName } from "../encrypted.js";
import { isEmptyReasoningItem } from "./summary.js";
const UNSUPPORTED_OLLAMA_COMPACT_MEDIA = new Set([
  "input_image",
  "input_file",
  "image_url",
  "computer_screenshot",
  "input_audio",
  "audio",
  "image",
]);

/** Native ChatGPT compact request/response projection. Never sent to Ollama. */

export function findCompactionInputItem(payload: JsonObject): JsonObject | undefined {
  if (!Array.isArray(payload.input)) return undefined;
  return payload.input.find(
    (item): item is JsonObject => isRecord(item) && item.type === "compaction",
  );
}

/**
 * Validate the completed response returned by the native v2 compactor. The
 * encrypted payload is intentionally opaque: cob checks shape and presence,
 * never attempts to decrypt or manufacture replacement ciphertext.
 */
export function nativeCompactionResponseError(value: unknown): string | undefined {
  const envelope = isRecord(value) && isRecord(value.response) ? value.response : value;
  if (!isRecord(envelope)) return "native compaction response is not an object";
  if (envelope.status !== "completed") {
    return `native compaction response status is ${typeof envelope.status === "string" ? envelope.status : "missing"}`;
  }
  if (!Array.isArray(envelope.output)) return "native compaction response has no output array";
  const items = envelope.output.filter(
    (item): item is JsonObject => isRecord(item) && item.type === "compaction",
  );
  if (items.length !== 1) {
    return `native compaction response must contain exactly one compaction output item; got ${items.length}`;
  }
  const encrypted = items[0]?.encrypted_content;
  if (typeof encrypted !== "string" || encrypted.trim().length === 0) {
    return "native compaction output is missing encrypted_content";
  }
  if (typeof envelope.id !== "string" || envelope.id.trim().length === 0) {
    return "native compaction response is missing a response id";
  }
  return undefined;
}

/**
 * Native Responses compaction rejects assistant `input_text` (`output_text` or
 * `refusal` only). Cob stores Ollama-safe history, so restore assistant content
 * types before the ChatGPT compact call. User/developer messages stay
 * `input_text`. Ciphertext is never forwarded.
 *
 * Ollama-thread compact uses `store: false` (the v2 compactor rejects stored
 * responses). Codex still embeds item ids (`rs_…`, `msg_…`) from the local
 * thread; ChatGPT then 404s looking them up. Strip those ids, drop
 * id-only references, and keep in-request `call_id` pairing.
 */
export function projectNativeCompactInput(value: unknown): unknown {
  if (Array.isArray(value)) {
    const next: unknown[] = [];
    for (const item of value) {
      const projected = projectNativeCompactInput(item);
      if (shouldDropNativeCompactItem(projected)) continue;
      next.push(projected);
    }
    return next;
  }
  if (!isRecord(value)) return value;
  const next: JsonObject = {};
  for (const [key, nested] of Object.entries(value)) {
    if (isEncryptedFieldName(key)) continue;
    next[key] = projectNativeCompactInput(nested);
  }
  if (typeof next.type === "string") {
    delete next.id;
  }
  if (next.type === "message" && next.role === "assistant" && Array.isArray(next.content)) {
    next.content = next.content.map((part) => {
      if (!isRecord(part) || part.type !== "input_text") return part;
      return { ...part, type: "output_text" };
    });
  }
  return next;
}

function shouldDropNativeCompactItem(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "item_reference") return true;
  if (value.type !== "reasoning") return false;
  return isEmptyReasoningItem(value);
}

export function nativeCompactRequest(payload: JsonObject, compactModel: string): JsonObject {
  const next: JsonObject = {
    ...payload,
    model: compactModel,
  };
  delete next.previous_response_id;
  // The ChatGPT v2 compactor rejects stored responses. Native-thread
  // passthrough remains byte-for-byte; this applies only to Ollama reroutes.
  next.store = false;
  return next;
}

export function isResponseEnvelope(value: JsonObject): boolean {
  return (
    value.object === "response" ||
    value.object === "response.compaction" ||
    Array.isArray(value.output)
  );
}

export function unsupportedOllamaCompactMediaError(value: unknown, path = "input"): string | undefined {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const err = unsupportedOllamaCompactMediaError(value[i], `${path}[${i}]`);
      if (err) return err;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (typeof value.type === "string" && UNSUPPORTED_OLLAMA_COMPACT_MEDIA.has(value.type)) {
    return `${path}: ${value.type} cannot be summarized; resend the full context without images or files`;
  }
  for (const [key, nested] of Object.entries(value)) {
    const err = unsupportedOllamaCompactMediaError(nested, `${path}.${key}`);
    if (err) return err;
  }
  return undefined;
}
