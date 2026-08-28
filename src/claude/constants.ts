/** cob claude live loopback. Distinct from Codex :18790 / :18791. */
export const CLAUDE_DEFAULT_PORT = 18792;
export const CLAUDE_DEFAULT_DEV_PORT = 18793;
export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_COUNT_TOKENS_URL = "https://api.anthropic.com/v1/messages/count_tokens";

/** Claude-side advertised context window for Ollama rows. Not Ollama n_ctx. */
export const CLAUDE_OLLAMA_CONTEXT_CAP = 256_000;
