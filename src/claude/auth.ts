import { spawnSync } from "node:child_process";
import { CLAUDE_DESKTOP_GATEWAY_KEY } from "./constants.js";

export type ClaudeUpstreamAuth = {
  authorization?: string;
  "x-api-key"?: string;
  "anthropic-beta"?: string;
};

export type ClaudeAuthReader = () => ClaudeUpstreamAuth | undefined;

const PLACEHOLDER_KEYS = new Set([CLAUDE_DESKTOP_GATEWAY_KEY, "ollama"]);
const CLAUDE_CODE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const OAUTH_BETA = "oauth-2025-04-20";

export function isPlaceholderGatewayCredential(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  return trimmed.length === 0 || PLACEHOLDER_KEYS.has(trimmed);
}

export function incomingAnthropicCredential(headers: Record<string, string>): string {
  const authorization = headers.authorization?.trim() ?? "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice("bearer ".length).trim();
  }
  return headers["x-api-key"]?.trim() ?? "";
}

export function resolveAnthropicUpstreamHeaders(
  incoming: Record<string, string>,
  reader: ClaudeAuthReader = readClaudeCodeAuth,
): Record<string, string> {
  const credential = incomingAnthropicCredential(incoming);
  if (!isPlaceholderGatewayCredential(credential)) {
    return incoming;
  }
  const injected = reader();
  if (!injected) {
    throw new ClaudeAnthropicAuthError(
      "cob claude needs Claude Code credentials for Anthropic routes when Claude Desktop sends the cob gateway placeholder",
    );
  }
  const headers = { ...incoming };
  delete headers.authorization;
  delete headers["x-api-key"];
  if (injected.authorization) headers.authorization = injected.authorization;
  if (injected["x-api-key"]) headers["x-api-key"] = injected["x-api-key"];
  if (injected["anthropic-beta"] && !headers["anthropic-beta"]) {
    headers["anthropic-beta"] = injected["anthropic-beta"];
  }
  return headers;
}

export function readClaudeCodeAuth(
  env: NodeJS.ProcessEnv = process.env,
  keychainReader: ClaudeAuthReader = readClaudeCodeKeychainAuth,
): ClaudeUpstreamAuth | undefined {
  const keychain = keychainReader();
  if (keychain) return keychain;
  const authToken = env.ANTHROPIC_AUTH_TOKEN?.trim();
  if (authToken && !isPlaceholderGatewayCredential(authToken)) {
    return authorizationFromToken(authToken);
  }
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (apiKey && !isPlaceholderGatewayCredential(apiKey)) {
    return { "x-api-key": apiKey };
  }
  return undefined;
}

export function describeAnthropicAuthKind(headers: Record<string, string>): string {
  if (headers["x-api-key"]) return `x-api-key len=${headers["x-api-key"].length}`;
  const authorization = headers.authorization?.trim() ?? "";
  if (!authorization) return "missing";
  const token = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice("bearer ".length).trim()
    : authorization;
    const kind = token.startsWith("sk-ant-oat")
      ? "oat"
      : token.startsWith("sk-ant-")
        ? "sk-ant"
        : token.startsWith("eyJ")
          ? "jwt"
          : "other";
  return `authorization kind=${kind} len=${token.length}`;
}

export function authorizationFromToken(token: string): ClaudeUpstreamAuth {
  if (token.startsWith("sk-ant-oat")) {
    return { authorization: `Bearer ${token}`, "anthropic-beta": OAUTH_BETA };
  }
  if (token.startsWith("sk-ant-api") || (token.startsWith("sk-ant-") && !token.includes("oat"))) {
    return { "x-api-key": token };
  }
  return { authorization: `Bearer ${token}`, "anthropic-beta": OAUTH_BETA };
}

export function readClaudeCodeKeychainAuth(): ClaudeUpstreamAuth | undefined {
  if (process.platform !== "darwin") return undefined;
  const result = spawnSync(
    "security",
    ["find-generic-password", "-s", CLAUDE_CODE_KEYCHAIN_SERVICE, "-w"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return undefined;
  const raw = result.stdout.trim();
  if (raw.length === 0) return undefined;
  return parseClaudeCodeCredentialBlob(raw);
}

export function parseClaudeCodeCredentialBlob(raw: string): ClaudeUpstreamAuth | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return authorizationFromToken(raw);
    const record = parsed as Record<string, unknown>;
    const oauth = firstString(
      nestedString(record.claudeAiOauth, "accessToken"),
      nestedString(record.oauth, "accessToken"),
      typeof record.accessToken === "string" ? record.accessToken : undefined,
    );
    if (oauth) return authorizationFromToken(oauth);
    const apiKey = firstString(
      typeof record.apiKey === "string" ? record.apiKey : undefined,
      typeof record.primaryApiKey === "string" ? record.primaryApiKey : undefined,
    );
    if (apiKey) return authorizationFromToken(apiKey);
  } catch {
    return authorizationFromToken(raw);
  }
  return undefined;
}

export class ClaudeAnthropicAuthError extends Error {
  readonly code = "claude_anthropic_auth_missing";
  constructor(message: string) {
    super(message);
    this.name = "ClaudeAnthropicAuthError";
  }
}

function nestedString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim().length > 0);
}
