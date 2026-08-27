import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { OllamaTag } from "../core/ollama/tags.js";
import { loadOllamaTags } from "../core/ollama/tags.js";
import {
  ClaudeAnthropicAuthError,
  describeAnthropicAuthKind,
  incomingAnthropicCredential,
  isPlaceholderGatewayCredential,
  resolveAnthropicUpstreamHeaders,
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
  const authReader = options.authReader;
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
    listOllamaTags?: (ollamaUrl: string) => Promise<OllamaTag[]>;
    spawnAllowlist: readonly string[];
    logLine: (line: string) => void;
  },
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, surface: "claude" }));
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
    try {
      headers = resolveAnthropicUpstreamHeaders(headers, options.authReader);
    } catch (error) {
      const message =
        error instanceof ClaudeAnthropicAuthError
          ? error.message
          : "cob claude could not resolve Anthropic credentials";
      anthropicError(res, 401, "authentication_error", message);
      return;
    }
    if (isPlaceholderGatewayCredential(incomingAuth)) {
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

function hasAnthropicAuth(headers: Record<string, string>): boolean {
  return Boolean(headers.authorization || headers["x-api-key"]);
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
