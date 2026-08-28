import { isRecord, type JsonObject } from "../../core/json.js";
import { isEncryptedFieldName } from "../encrypted.js";

/**
 * Provider-safe history projection rules shared by conversation state and
 * compaction. Both consume this downward module; neither owns the wire rules.
 */

/**
 * Project one archived item into the subset accepted as Ollama follow-up
 * input. Compaction items are deliberately left opaque here; callers must
 * resolve them from the bridge-owned checkpoint before forwarding.
 */
export function projectOllamaInputValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => projectOllamaInputValue(item));
  if (!isRecord(value)) return value;
  const next: JsonObject = {};
  for (const [key, nested] of Object.entries(value)) {
    if (isEncryptedFieldName(key)) continue;
    if (key === "status" && value.type === "message") continue;
    next[key] = projectOllamaInputValue(nested);
  }
  if (next.type === "output_text") {
    next.type = "input_text";
  }
  return next;
}

/** Strict wire check for any input that is about to cross into Ollama. */
export function ollamaFollowUpInputError(value: unknown, path = "input"): string | undefined {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const err = ollamaFollowUpInputError(value[i], `${path}[${i}]`);
      if (err) return err;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (value.type === "compaction" || value.type === "compaction_trigger") {
    return `${path}: ${value.type} must be resolved by cob before Ollama forwarding`;
  }
  if (
    Object.entries(value).some(
      ([key, nested]) =>
        isEncryptedFieldName(key) && nested !== undefined && nested !== "" && !(Array.isArray(nested) && nested.length === 0),
    )
  ) {
    return `${path}: encrypted fields must not be sent to Ollama`;
  }
  if (value.type === "message") {
    if (value.status !== undefined) {
      return `${path}: output-only status is not valid on Ollama input items`;
    }
    if (Array.isArray(value.content)) {
      for (let i = 0; i < value.content.length; i += 1) {
        const part = value.content[i];
        if (isRecord(part) && part.type === "output_text") {
          return `${path}.content[${i}]: output_text is not valid on Ollama input items`;
        }
      }
    }
  }
  for (const [key, nested] of Object.entries(value)) {
    if (isEncryptedFieldName(key)) continue;
    const err = ollamaFollowUpInputError(nested, `${path}.${key}`);
    if (err) return err;
  }
  return undefined;
}

export function assertValidOllamaFollowUpInput(value: unknown): void {
  const err = ollamaFollowUpInputError(value);
  if (err) throw new Error(err);
}
