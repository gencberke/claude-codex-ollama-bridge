import { StringDecoder } from "node:string_decoder";
import { Transform } from "node:stream";
import { MAX_SSE_LINE_BYTES } from "./limits.js";

export class SseLimitError extends Error {
  readonly code = "sse_frame_too_large";
  readonly status = 413;
  constructor(message = `SSE frame exceeded ${MAX_SSE_LINE_BYTES} bytes`) {
    super(message);
    this.name = "SseLimitError";
  }
}

export const SSE_OMIT_LINE = Symbol("sse-omit-line");

export type SseObserver = {
  onChunk?: (chunk: Buffer) => void;
  onData?: (event: { value?: unknown; done?: boolean; malformed?: boolean }) => void;
  suppressDone?: boolean;
  /** Drop remaining `data:` lines without parsing them. */
  omitData?: () => boolean;
};

export function sseRewriteTransform(
  rewriteJson: (value: unknown) => unknown,
  maxLineBytes = MAX_SSE_LINE_BYTES,
  observer?: SseObserver,
): Transform {
  const decoder = new StringDecoder("utf8");
  let rest = "";
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const bytes = Buffer.from(chunk as Buffer);
        observer?.onChunk?.(bytes);
        rest += decoder.write(bytes);
        const parts = rest.split(/\n/);
        rest = parts.pop() ?? "";
        assertLineBudget(rest, maxLineBytes);
        for (const part of parts) assertLineBudget(part, maxLineBytes);
        const rewritten = parts
          .map((line) => rewriteSseLine(line.replace(/\r$/, ""), rewriteJson, observer))
          .filter((line): line is string => line !== SSE_OMIT_LINE);
        callback(null, rewritten.length > 0 ? `${rewritten.join("\n")}\n` : "");
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback) {
      try {
        rest += decoder.end();
        if (rest.length === 0) {
          callback();
          return;
        }
        assertLineBudget(rest, maxLineBytes);
        const line = rewriteSseLine(rest.replace(/\r$/, ""), rewriteJson, observer);
        callback(null, line === SSE_OMIT_LINE ? undefined : line);
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

export function rewriteSseLine(
  line: string,
  rewriteJson: (value: unknown) => unknown,
  observer?: SseObserver,
): string | typeof SSE_OMIT_LINE {
  if (!line.startsWith("data:")) return line;
  if (observer?.omitData?.()) return SSE_OMIT_LINE;
  const payload = line.slice("data:".length).trim();
  if (payload.length === 0) return line;
  if (payload === "[DONE]") {
    observer?.onData?.({ done: true });
    return observer?.suppressDone ? "" : line;
  }
  try {
    const parsed: unknown = JSON.parse(payload);
    observer?.onData?.({ value: parsed });
    const rewritten = rewriteJson(parsed);
    if (rewritten === SSE_OMIT_LINE) return SSE_OMIT_LINE;
    if (rewritten === parsed) return line;
    return `data: ${JSON.stringify(rewritten)}`;
  } catch {
    observer?.onData?.({ malformed: true });
    return line;
  }
}

function assertLineBudget(text: string, maxLineBytes: number): void {
  if (Buffer.byteLength(text, "utf8") > maxLineBytes) {
    throw new SseLimitError();
  }
}
