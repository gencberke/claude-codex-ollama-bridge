export const MAX_SSE_LINE_BYTES = 4 * 1024 * 1024;

/** Native fetch-to-headers / TTFB deadline. Not a TCP-connect timer. */
export const NATIVE_HEADERS_TIMEOUT_MS = 30_000;
/** Ollama fetch-to-headers / TTFB deadline. Slow local/cloud reasoning can exceed 30s. */
export const OLLAMA_HEADERS_TIMEOUT_MS = 240_000;
export const HEALTH_FETCH_TIMEOUT_MS = 2_000;
export const START_HEALTH_DEADLINE_MS = 45_000;
export const CODEX_CATALOG_TIMEOUT_MS = 30_000;
