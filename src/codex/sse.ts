import { StringDecoder } from "node:string_decoder";
import { Transform } from "node:stream";
import { MAX_SSE_LINE_BYTES } from "./limits.js";

/** Codex/OpenAI Responses SSE error terminal. Never sent on Claude or raw relays. */
export function sseErrorTerminal(message: string, code = "upstream_stream_error"): string {
  const payload = JSON.stringify({
    error: { type: "server_error", code, message },
  });
  return `data: ${payload}\n\ndata: [DONE]\n\n`;
}

/** Codex/OpenAI Responses SSE completion terminal. */
export function sseDoneTerminal(): string {
  return "data: [DONE]\n\n";
}

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
  /** Fail the transform instead of forwarding an invalid or rejected data line. */
  failOnError?: boolean;
  /** Fail instead of forwarding a line that is not a recognized SSE field. */
  failOnUnknownField?: boolean;
  suppressDone?: boolean;
  /** Drop remaining `data:` lines without parsing them. */
  omitData?: () => boolean;
  /** Drop unparseable `data:` lines instead of relaying them verbatim. */
  omitMalformed?: boolean;
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
  if (!line.startsWith("data:")) {
    if (observer?.failOnUnknownField && !isRecognizedSseField(line)) {
      throw new Error("SSE stream contains an unsupported field");
    }
    return line;
  }
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
  } catch (error) {
    if (observer?.failOnError) {
      if (error instanceof SyntaxError) throw new Error("SSE data payload is invalid");
      throw error;
    }
    if (error instanceof SyntaxError) {
      observer?.onData?.({ malformed: true });
      return observer?.omitMalformed ? SSE_OMIT_LINE : line;
    }
    observer?.onData?.({ malformed: true });
    return line;
  }
}

function isRecognizedSseField(line: string): boolean {
  if (line.length === 0 || line.startsWith(":")) return true;
  return ["data", "event", "id", "retry"].some((field) => line === field || line.startsWith(`${field}:`));
}

function assertLineBudget(text: string, maxLineBytes: number): void {
  if (Buffer.byteLength(text, "utf8") > maxLineBytes) {
    throw new SseLimitError();
  }
}
