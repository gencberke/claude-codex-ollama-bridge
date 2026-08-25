import { isRecord } from "./types.js";

const FERNET_PREFIX = "gAAAAA";
const OCX1_PREFIX = "ocx1";
const COB_ENVELOPE_PREFIX = "cob1.";
export const NON_STRING_ENCRYPTED_CONTENT = "<non-string-encrypted_content>";

export function isEncryptedFieldName(key: string): boolean {
  return key === "encrypted" || key.startsWith("encrypted_");
}

export function findEncryptedContent(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findEncryptedContent(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value === "string") {
    return looksLikeNativeCiphertext(value) ? value : undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const [key, nested] of Object.entries(value)) {
    if (isEncryptedFieldName(key)) {
      if (typeof nested === "string" && nested.length > 0) return nested;
      if (nested !== undefined && nested !== null && nested !== "" && !isEmptyPlaceholder(nested)) {
        return NON_STRING_ENCRYPTED_CONTENT;
      }
      continue;
    }
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
  for (const [key, nested] of Object.entries(value)) {
    if (isEncryptedFieldName(key) && typeof nested === "string" && nested.trim().startsWith(FERNET_PREFIX)) {
      return nested;
    }
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
    if (isEncryptedFieldName(key)) continue;
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
      ? "non-string encrypted fields cannot be forwarded to Ollama"
      : "encrypted fields are present; refusing to send them to Ollama";
  return {
    status: 400,
    body: {
      error: {
        type: "invalid_request_error",
        code: "encrypted_content_unsupported",
        message: `${kind}. cob will not guess whether it is plaintext or ciphertext; resend a provider-safe plaintext/V1 child task or the full context.`,
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

function isEmptyPlaceholder(value: unknown): boolean {
  if (value === "") return true;
  return Array.isArray(value) && value.length === 0;
}

function looksLikeNativeCiphertext(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.startsWith(FERNET_PREFIX) ||
    trimmed.startsWith(OCX1_PREFIX) ||
    trimmed.startsWith(COB_ENVELOPE_PREFIX)
  );
}
