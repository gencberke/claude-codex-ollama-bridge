/**
 * Single shared default Ollama child model for both surfaces. Codex derives
 * the `ollama/` catalog slug from this id; Claude uses the bare model id.
 */
export const DEFAULT_OLLAMA_SPAWN_MODEL = "deepseek-v4-flash:0731-cloud" as const;
