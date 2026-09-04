import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
  zstdDecompressSync,
} from "node:zlib";
import { MAX_DECODED_BODY_BYTES } from "../core/http/body.js";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

export class RequestDecodeError extends Error {
  readonly code = "invalid_encoding";
  constructor(message: string) {
    super(message);
    this.name = "RequestDecodeError";
  }
}

export type DecodedBody = {
  body: Buffer;
  decoded: boolean;
};

/**
 * Codex ChatGPT requests compress POST /v1/responses with zstd
 * (Content-Encoding: zstd) while keeping Content-Type: application/json.
 */
export function decodeRequestBody(raw: Buffer, contentEncoding?: string): DecodedBody {
  if (raw.length === 0) {
    return { body: raw, decoded: false };
  }
  const encoding = (contentEncoding ?? "").toLowerCase();
  const looksZstd = encoding.includes("zstd") || raw.subarray(0, 4).equals(ZSTD_MAGIC);
  const looksGzip = encoding.includes("gzip") || raw.subarray(0, 2).equals(GZIP_MAGIC);
  const looksDeflate = encoding.includes("deflate");
  const looksBrotli = encoding.includes("br") || encoding.includes("brotli");
  if (!looksZstd && !looksGzip && !looksDeflate && !looksBrotli) {
    return { body: stripBom(raw), decoded: false };
  }
  try {
    const limits = { maxOutputLength: MAX_DECODED_BODY_BYTES };
    let inflated: Buffer;
    if (looksZstd) {
      inflated = zstdDecompressSync(raw, limits);
    } else if (looksGzip) {
      inflated = gunzipSync(raw, limits);
    } else if (looksDeflate) {
      inflated = inflateSync(raw, limits);
    } else {
      inflated = brotliDecompressSync(raw, limits);
    }
    return { body: stripBom(inflated), decoded: true };
  } catch {
    throw new RequestDecodeError("Failed to decompress request body.");
  }
}

function stripBom(buffer: Buffer): Buffer {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3);
  }
  return buffer;
}
