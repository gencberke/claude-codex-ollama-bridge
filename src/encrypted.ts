import { isRecord } from "./types.js";

const FERNET_PREFIX = "gAAAAA";
export const NON_STRING_ENCRYPTED_CONTENT = "<non-string-encrypted_content>";

export function findEncryptedContent(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findEncryptedContent(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const direct = value.encrypted_content;
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct;
  }
  if (direct !== undefined && direct !== null && typeof direct !== "string") {
    return NON_STRING_ENCRYPTED_CONTENT;
  }
  for (const nested of Object.values(value)) {
    const found = findEncryptedContent(nested);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function findFernetEncryptedContent(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFernetEncryptedContent(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const direct = value.encrypted_content;
  if (typeof direct === "string" && direct.trim().startsWith(FERNET_PREFIX)) {
    return direct;
  }
  for (const nested of Object.values(value)) {
    const found = findFernetEncryptedContent(nested);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function stripPlaintextEncryptedContent(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripPlaintextEncryptedContent(item));
  }
  if (!isRecord(value)) return value;
  const next: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "encrypted_content") continue;
    next[key] = stripPlaintextEncryptedContent(nested);
  }
  return next;
}

export function looksLikeCiphertext(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.startsWith(FERNET_PREFIX)) return true;
  return trimmed.length >= 80 && /^[A-Za-z0-9+/_=-]+$/.test(trimmed);
}

export function encryptedOllamaRejection(ciphertext: string): {
  status: number;
  body: JsonError;
} {
  const kind =
    ciphertext === NON_STRING_ENCRYPTED_CONTENT
      ? "non-string encrypted_content cannot be forwarded to Ollama"
      : looksLikeCiphertext(ciphertext)
        ? "V2 encrypted_content cannot be forwarded to Ollama"
        : "encrypted_content is present; refusing to send it to Ollama";
  return {
    status: 400,
    body: {
      error: {
        type: "invalid_request_error",
        code: "encrypted_content_unsupported",
        message: `${kind}. Keep features.multi_agent_v2 = false and spawn Ollama children on V1.`,
      },
    },
  };
}

export type JsonError = {
  error: {
    type: string;
    code?: string;
    message: string;
  };
};
