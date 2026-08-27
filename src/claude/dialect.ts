/**
 * cob claude routing contract. Source/test authority — not runtime discovery.
 * Claude Code subscription OAuth is forwarded untouched on Anthropic routes.
 * Native Claude ids are never rewritten to Ollama (no nativeAlias).
 */

export const CLAUDE_DIALECT_VERSION = 1 as const;
export const CLAUDE_REVIEWED_STATUS = "live-messages" as const;
export const CLAUDE_MESSAGES_PATH = "/v1/messages" as const;
export const CLAUDE_COUNT_TOKENS_PATH = "/v1/messages/count_tokens" as const;
export const CLAUDE_MODELS_PATH = "/v1/models" as const;

export const ANTHROPIC_MODEL_ALIASES = ["opus", "sonnet", "haiku", "fable"] as const;

export const ANTHROPIC_FORWARD_HEADERS = [
  "accept",
  "anthropic-beta",
  "anthropic-version",
  "authorization",
  "content-type",
  "user-agent",
  "x-api-key",
] as const;

export const OLLAMA_MESSAGES_FORWARD_HEADERS = ["accept", "content-type"] as const;

export type ClaudeRouteBackend = "anthropic" | "ollama";

export type ClaudeModelRoute = {
  backend: ClaudeRouteBackend;
  upstreamModel: string;
};

export const CLAUDE_DIALECT = {
  version: CLAUDE_DIALECT_VERSION,
  status: CLAUDE_REVIEWED_STATUS,
  endpoint: CLAUDE_MESSAGES_PATH,
  providerState: "stateless" as const,
  capabilities: {
    claudeDesktopThirdParty: "overlay-opt-in",
    ollamaLaunchClaude: "unsupported",
    nativeAlias: "unsupported",
    cobRoute: "system-marker",
    settingsJsonWrites: "unsupported",
    userClaudeHomeWrites: "agents-overlay-opt-in",
  },
} as const;

export function routeClaudeRequestModel(model: string): ClaudeModelRoute {
  const trimmed = model.trim();
  if (trimmed.length === 0) {
    throw new ClaudeModelRouteError("model is required");
  }
  if (isAnthropicClaudeModel(trimmed)) {
    return { backend: "anthropic", upstreamModel: trimmed };
  }
  return { backend: "ollama", upstreamModel: stripOllamaPrefix(trimmed) };
}

export function isAnthropicClaudeModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  if (normalized.startsWith("claude")) return true;
  return (ANTHROPIC_MODEL_ALIASES as readonly string[]).includes(normalized);
}

export function stripOllamaPrefix(model: string): string {
  return model.startsWith("ollama/") ? model.slice("ollama/".length) : model;
}

/** Ollama has no Messages count_tokens route. cob answers locally; never forward this path. */
export function estimateOllamaCountTokens(payload: Record<string, unknown>): { input_tokens: number } {
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  return { input_tokens: Math.max(1, Math.ceil(bytes / 4)) };
}

export class ClaudeModelRouteError extends Error {
  readonly code = "claude_model_unroutable";
  constructor(message: string) {
    super(message);
    this.name = "ClaudeModelRouteError";
  }
}
