import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { OllamaTag } from "../core/ollama/tags.js";
import { loadOllamaTags } from "../core/ollama/tags.js";
import {
  ClaudeAnthropicAuthError,
  describeAnthropicAuthKind,
  incomingAnthropicCredential,
  isDesktopGatewayCredential,
  readClaudeCodeAuth,
  resolveAnthropicUpstreamHeaders,
  timingSafeTokenEqual,
  type ClaudeAuthReader,
} from "./auth.js";
import {
  ANTHROPIC_FORWARD_HEADERS,
  CLAUDE_COUNT_TOKENS_PATH,
  CLAUDE_MESSAGES_PATH,
  CLAUDE_MODELS_PATH,
  ClaudeModelRouteError,
  OLLAMA_MESSAGES_FORWARD_HEADERS,
  estimateOllamaCountTokens,
  routeClaudeRequestModel,
  type ClaudeModelRoute,
} from "./dialect.js";
import { CLAUDE_SPAWN_ALLOWLIST } from "./agents.js";
import { buildClaudeModelsResponse } from "./models.js";
import { applyCobRouteDirective, formatClaudeRouteLog } from "./route.js";
import { ANTHROPIC_COUNT_TOKENS_URL, ANTHROPIC_MESSAGES_URL } from "./constants.js";
import { DEFAULT_OLLAMA_URL } from "../core/ollama/constants.js";
import { assertLoopbackBindHost, assertLoopbackHttpUrl } from "../core/loopback.js";
import { BodyAbortedError, BodyLimitError, readLimitedBody } from "../core/http/body.js";
import { attachCancellation } from "../core/http/cancellation.js";
import { relayPassthrough } from "../core/http/relay.js";
import { fetchWithHeadersTimeout, HeadersTimeoutError, IdleTimeoutError } from "../core/http/timeouts.js";
import type { JsonObject } from "../core/json.js";

const HEADERS_TIMEOUT_MS = 30_000;
const OLLAMA_HEADERS_TIMEOUT_MS = 240_000;
const IDLE_MS = 300_000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;

export type ClaudeGatewayFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: Buffer;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export type ClaudeGatewayOptions = {
  port: number;
  host?: string;
  ollamaUrl?: string;
  /** Per-install Desktop gateway token. Only its exact match may reach credential injection. */
  desktopToken?: string;
  /** Runtime nonce published in /health and required by /cob/shutdown. */
  healthNonce?: string;
  /** Test hook for the authenticated self-shutdown; defaults to SIGTERM on this process. */
  onShutdown?: () => void;
  anthropicMessagesUrl?: string;
  anthropicCountTokensUrl?: string;
  fetchImpl?: ClaudeGatewayFetch;
  authReader?: ClaudeAuthReader;
  listOllamaTags?: (ollamaUrl: string) => Promise<OllamaTag[]>;
  spawnAllowlist?: readonly string[];
  logLine?: (line: string) => void;
};

export function createClaudeGateway(options: ClaudeGatewayOptions): Server {
  const ollamaUrl = (options.ollamaUrl ?? DEFAULT_OLLAMA_URL).replace(/\/$/, "");
  assertLoopbackHttpUrl(ollamaUrl, "Ollama URL");
  const anthropicUrl = options.anthropicMessagesUrl ?? ANTHROPIC_MESSAGES_URL;
  const anthropicCountTokensUrl = options.anthropicCountTokensUrl ?? ANTHROPIC_COUNT_TOKENS_URL;
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  /** Production default: Desktop token injections come from Claude Code keychain/env. */
  const authReader = options.authReader ?? readClaudeCodeAuth;
  const listOllamaTags = options.listOllamaTags;
  const spawnAllowlist = options.spawnAllowlist ?? CLAUDE_SPAWN_ALLOWLIST;
  const logLine = options.logLine ?? ((line: string) => process.stderr.write(line));
  return createServer((req, res) => {
    void handleClaudeRequest(req, res, {
      ollamaUrl,
      anthropicUrl,
      anthropicCountTokensUrl,
      fetchImpl,
      authReader,
      desktopToken: options.desktopToken,
      healthNonce: options.healthNonce,
      onShutdown: options.onShutdown,
      listOllamaTags,
      spawnAllowlist,
      logLine,
    }).catch((error: unknown) => {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      if (error instanceof HeadersTimeoutError || error instanceof IdleTimeoutError) {
        anthropicError(res, 504, "timeout_error", error.message);
        return;
      }
      anthropicError(res, 500, "api_error", error instanceof Error ? error.message : String(error));
    });
  });
}

export function listenClaudeGateway(options: ClaudeGatewayOptions): Promise<Server> {
  const host = options.host ?? "127.0.0.1";
  assertLoopbackBindHost(host);
  const server = createClaudeGateway(options);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

async function handleClaudeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    ollamaUrl: string;
    anthropicUrl: string;
    anthropicCountTokensUrl: string;
    fetchImpl: ClaudeGatewayFetch;
    authReader?: ClaudeAuthReader;
    desktopToken?: string;
    healthNonce?: string;
    onShutdown?: () => void;
    listOllamaTags?: (ollamaUrl: string) => Promise<OllamaTag[]>;
    spawnAllowlist: readonly string[];
    logLine: (line: string) => void;
  },
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
    const presented = headerValue(req.headers["x-cob-nonce"]) ?? "";
    const body: Record<string, unknown> = {
      ok: true,
      surface: "claude",
      pid: process.pid,
      nonce_ok: Boolean(options.healthNonce && timingSafeTokenEqual(presented, options.healthNonce)),
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }
  if (req.method === "POST" && url.pathname === "/cob/shutdown") {
    await handleCobShutdown(req, res, options);
    return;
  }
  if (req.method === "GET" && url.pathname === CLAUDE_MODELS_PATH) {
    const tags = await listClaudeOllamaTags(options.ollamaUrl, options.listOllamaTags);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(buildClaudeModelsResponse(tags)));
    return;
  }
  const isCountTokens = req.method === "POST" && url.pathname === CLAUDE_COUNT_TOKENS_PATH;
  if (req.method !== "POST" || (url.pathname !== CLAUDE_MESSAGES_PATH && !isCountTokens)) {
    anthropicError(
      res,
      404,
      "not_found_error",
      "cob claude allowlists GET /v1/models and POST /v1/messages",
    );
    return;
  }

  let raw: Buffer;
  try {
    raw = await readLimitedBody(req, { maxBytes: MAX_BODY_BYTES });
  } catch (error) {
    if (error instanceof BodyLimitError) {
      anthropicError(res, 413, "invalid_request_error", error.message);
      return;
    }
    if (error instanceof BodyAbortedError) return;
    throw error;
  }
  let payload: JsonObject;
  try {
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("body must be a JSON object");
    }
    payload = parsed as JsonObject;
  } catch {
    anthropicError(res, 400, "invalid_request_error", "request body is not valid JSON");
    return;
  }

  const routed = applyCobRouteDirective(payload, options.spawnAllowlist);
  payload = routed.payload as JsonObject;
  const model = typeof payload.model === "string" ? payload.model : "";
  let route: ClaudeModelRoute;
  try {
    route = routeClaudeRequestModel(model);
  } catch (error) {
    const message = error instanceof ClaudeModelRouteError ? error.message : "model is required";
    anthropicError(res, 400, "invalid_request_error", message);
    return;
  }

  payload.model = route.upstreamModel;
  options.logLine(
    formatClaudeRouteLog({
      path: url.pathname,
      clientModel: routed.clientModel,
      backend: route.backend,
      upstream: route.upstreamModel,
      cobRoute: routed.applied,
      ignored: routed.ignored,
    }),
  );
  if (isCountTokens && route.backend === "ollama") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(estimateOllamaCountTokens(payload)));
    return;
  }
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const abort = attachCancellation(req, res);
  const anthropicUrl = isCountTokens ? options.anthropicCountTokensUrl : options.anthropicUrl;
  const ollamaPath = isCountTokens ? CLAUDE_COUNT_TOKENS_PATH : CLAUDE_MESSAGES_PATH;
  const upstreamUrl = route.backend === "anthropic" ? anthropicUrl : `${options.ollamaUrl}${ollamaPath}`;
  let headers =
    route.backend === "anthropic"
      ? pickHeaders(req, ANTHROPIC_FORWARD_HEADERS)
      : pickHeaders(req, OLLAMA_MESSAGES_FORWARD_HEADERS);
  if (route.backend === "anthropic") {
    const incomingAuth = incomingAnthropicCredential(headers);
    const fromDesktop = isDesktopGatewayCredential(incomingAuth, options.desktopToken);
    try {
      headers = resolveAnthropicUpstreamHeaders(headers, {
        desktopToken: options.desktopToken,
        reader: options.authReader,
      });
    } catch (error) {
      const message =
        error instanceof ClaudeAnthropicAuthError
          ? error.message
          : "cob claude could not resolve Anthropic credentials";
      anthropicError(res, 401, "authentication_error", message);
      return;
    }
    if (fromDesktop) {
      options.logLine(`[cob claude] anthropic auth ${describeAnthropicAuthKind(headers)}\n`);
    }
    if (!hasAnthropicAuth(headers)) {
      anthropicError(
        res,
        401,
        "authentication_error",
        "cob claude forwards Claude Code OAuth; Authorization or x-api-key is required for Anthropic routes",
      );
      return;
    }
  }
  if (!headers["content-type"]) headers["content-type"] = "application/json";
  if (!headers.accept) headers.accept = "application/json";

  const headersMs = route.backend === "anthropic" ? HEADERS_TIMEOUT_MS : OLLAMA_HEADERS_TIMEOUT_MS;
  const upstream = await fetchWithHeadersTimeout(
    options.fetchImpl,
    upstreamUrl,
    { method: "POST", headers, body, signal: abort.signal },
    headersMs,
  );

  const responseHeaders: Record<string, string> = {};
  const contentType = upstream.headers.get("content-type");
  if (contentType) responseHeaders["content-type"] = contentType;
  const requestId = upstream.headers.get("request-id");
  if (requestId) responseHeaders["request-id"] = requestId;

  res.writeHead(upstream.status, responseHeaders);
  if (!upstream.body) {
    res.end();
    return;
  }
  await relayPassthrough(Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream), res, {
    idleMs: IDLE_MS,
    abort,
  });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function hasAnthropicAuth(headers: Record<string, string>): boolean {
  return Boolean(headers.authorization || headers["x-api-key"]);
}

async function handleCobShutdown(
  req: IncomingMessage,
  res: ServerResponse,
  options: { healthNonce?: string; onShutdown?: () => void },
): Promise<void> {
  if (!options.healthNonce) {
    anthropicError(res, 404, "not_found_error", "cob claude shutdown requires a runtime identity nonce");
    return;
  }
  let raw: Buffer;
  try {
    raw = await readLimitedBody(req, { maxBytes: 1024 });
  } catch (error) {
    if (error instanceof BodyAbortedError) return;
    anthropicError(res, 400, "invalid_request_error", "cob claude shutdown body is not valid JSON");
    return;
  }
  let nonce = "";
  try {
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    if (parsed && typeof parsed === "object" && typeof (parsed as { nonce?: unknown }).nonce === "string") {
      nonce = (parsed as { nonce: string }).nonce;
    }
  } catch {
    // nonce stays empty; comparison below rejects
  }
  if (!timingSafeTokenEqual(nonce, options.healthNonce)) {
    anthropicError(res, 403, "permission_error", "cob claude shutdown nonce rejected");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }), () => {
    if (options.onShutdown) {
      options.onShutdown();
      return;
    }
    setImmediate(() => process.kill(process.pid, "SIGTERM"));
  });
}

async function listClaudeOllamaTags(
  ollamaUrl: string,
  override?: (url: string) => Promise<OllamaTag[]>,
): Promise<OllamaTag[]> {
  try {
    return override ? await override(ollamaUrl) : await loadOllamaTags(ollamaUrl, 2_000);
  } catch {
    return [];
  }
}

function pickHeaders(req: IncomingMessage, allowlist: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of allowlist) {
    const value = req.headers[name];
    if (typeof value === "string" && value.length > 0) headers[name] = value;
  }
  return headers;
}

function anthropicError(res: ServerResponse, status: number, type: string, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

async function defaultFetch(
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: Buffer;
    signal?: AbortSignal;
  },
): Promise<Response> {
  return fetch(input, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
  });
}
