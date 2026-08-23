export const DEFAULT_PORT = 18790;
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
export const NATIVE_RESPONSES_URL =
  "https://chatgpt.com/backend-api/codex/responses";

export const OLLAMA_PREFIX = "ollama/";

/** Picker list order (priority ASC), then the first spawnable Ollama slug. */
export const FEATURED_NATIVE_SLUGS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;

/** Advertised Codex window for Ollama rows. Not Ollama n_ctx. */
export const OLLAMA_CATALOG_CONTEXT_CAP = 256_000;

/** Isolated Stage 4 compact-threshold experiment: 90% of the 256k active cap. */
export const OLLAMA_ISOLATED_COMPACT_TOKEN_LIMIT = 230_400;

/** Prefer known ChatGPT-account compaction-capable native slugs when present. */
export const PREFERRED_NATIVE_COMPACT_SLUGS = [
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "codex-mini",
  "codex-mini-latest",
] as const;

/**
 * ChatGPT / Codex request headers that must reach the native backend.
 * Never send these to Ollama.
 */
export const FORWARD_HEADERS = [
  "accept",
  "authorization",
  "chatgpt-account-id",
  "content-encoding",
  "openai-beta",
  "originator",
  "session_id",
  "session-id",
  "thread-id",
  "x-client-request-id",
  "x-codex-beta-features",
  "x-codex-installation-id",
  "x-codex-parent-thread-id",
  "x-codex-turn-metadata",
  "x-codex-turn-state",
  "x-codex-window-id",
  "x-oai-attestation",
  "x-openai-subagent",
  "x-responsesapi-include-timing-metrics",
] as const;

/** Cob-owned. Not copied from GPT catalog rows. Codex requires one of these fields. */
export const OLLAMA_BASE_INSTRUCTIONS =
  "You are a coding assistant running on Ollama through the cob gateway. Follow the user and developer instructions in this turn. Do not claim to be ChatGPT or a GPT model. Prefer concise, correct code changes. If tool_search is listed, use it to find deferred tools instead of guessing names.";

export const OLLAMA_CATALOG_FIELDS = [
  "slug",
  "display_name",
  "description",
  "base_instructions",
  "visibility",
  "priority",
  "supported_in_api",
  "context_window",
  "max_context_window",
  "effective_context_window_percent",
  "auto_compact_token_limit",
  "input_modalities",
  "supported_reasoning_levels",
  "default_reasoning_level",
  "default_reasoning_summary",
  "support_verbosity",
  "supports_parallel_tool_calls",
  "supports_image_detail_original",
  "supports_search_tool",
  "shell_type",
  "truncation_policy",
  "experimental_supported_tools",
  "multi_agent_version",
] as const;

export const GPT_IDENTITY_FIELDS = [
  "base_instructions",
  "model_messages",
  "availability_nux",
  "upgrade",
  "comp_hash",
  "additional_speed_tiers",
  "service_tiers",
  "use_responses_lite",
  "include_apps_usage_instructions",
  "include_plugin_usage_instructions",
  "include_skills_usage_instructions",
  "web_search_tool_type",
  "supports_websockets",
  "prefer_websockets",
] as const;
