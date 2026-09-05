export const MAX_SSE_LINE_BYTES = 4 * 1024 * 1024;

/** Native fetch-to-headers / TTFB deadline. Not a TCP-connect timer. */
export const NATIVE_HEADERS_TIMEOUT_MS = 30_000;
/** Ollama fetch-to-headers / TTFB deadline. Slow local/cloud reasoning can exceed 30s. */
export const OLLAMA_HEADERS_TIMEOUT_MS = 240_000;
export const HEALTH_FETCH_TIMEOUT_MS = 2_000;
export const START_HEALTH_DEADLINE_MS = 45_000;
export const CODEX_CATALOG_TIMEOUT_MS = 30_000;

/**
 * Cumulative ceiling on one Ollama SSE response, in bytes.
 *
 * Measured on the live 0.3.3 sidecar: completed responses peak at 1.63 MB
 * (17,760 output tokens) while runaway generations cluster tightly at
 * 3.83-4.24 MB and burn 181-254 s each before Ollama's own non-success
 * terminal fires. The turn is already lost when that happens; the ceiling
 * ends it early so the loss costs seconds instead of minutes. It is not a
 * retry, and cob still owns no retry.
 */
export const OLLAMA_MAX_RESPONSE_BYTES = 2_621_440;

/** One Ollama response stream exceeded the configured cumulative ceiling. */
export class OllamaStreamCeilingError extends Error {
  readonly code = "ollama_response_stream_too_large";
  constructor(readonly limitBytes: number) {
    super(`Ollama response stream exceeds ${limitBytes} bytes`);
    this.name = "OllamaStreamCeilingError";
  }
}
