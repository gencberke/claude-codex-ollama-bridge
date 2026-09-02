import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { attachCancellation } from "../../core/http/cancellation.js";
import {
  BodyAbortedError,
  BodyLimitError,
  readLimitedBody,
  UpstreamLimitError,
} from "../../core/http/body.js";
import { HeadersTimeoutError, IdleTimeoutError } from "../../core/http/timeouts.js";
import { assertLoopbackBindHost } from "../../core/loopback.js";
import { isRecord } from "../../core/json.js";
import { ConversationStateError } from "../state/schema.js";
import { ConversationStateStore } from "../state/store.js";
import {
  handleNativeSearchPost,
  handleResponsesPost,
  headerValue,
  isAbortLike,
  json,
  jsonError,
  resolveCatalog,
  type GatewayOptions,
} from "./responses.js";
import { gatewayDiagnosticJsonlEnabled } from "../diagnostic-event.js";
import { DiagnosticLog } from "../runtime/diagnostic-log.js";

/**
 * Gateway HTTP shell: loopback bind, allowlisted routes, health and shutdown
 * endpoints, and the top-level error mapping. Request dispatch and provider
 * translation live in responses.ts.
 */

export function createGateway(options: GatewayOptions): Server {
  if (options.stateDir === undefined && options.stateStore === undefined) {
    throw new Error(
      "cob gateway requires an explicit stateDir or stateStore; refusing to guess the codex home",
    );
  }
  const gatewayOptions =
    options.stateStore === undefined
      ? {
          ...options,
          stateStore: new ConversationStateStore(
            options.stateDir as string,
            options.stateRetention,
          ),
        }
      : options;
  const diagnosticLog =
    gatewayDiagnosticJsonlEnabled() && options.diagnosticPath
      ? new DiagnosticLog(options.diagnosticPath)
      : undefined;
  const effectiveOptions = {
    ...gatewayOptions,
    ...(diagnosticLog ? { diagnosticSink: diagnosticLog } : {}),
  };
  const server = createServer((req, res) => {
    void handleRequest(req, res, effectiveOptions).catch((error: unknown) => {
      if (isAbortLike(error) || error instanceof BodyAbortedError) {
        if (!res.writableEnded) res.end();
        return;
      }
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof BodyLimitError) {
        jsonError(res, error.status, error.code, error.message);
        return;
      }
      if (error instanceof UpstreamLimitError || error instanceof HeadersTimeoutError || error instanceof IdleTimeoutError) {
        jsonError(res, error.status, error.code, error.message);
        return;
      }
      if (error instanceof ConversationStateError) {
        jsonError(res, error.status, error.code, error.message, { requires_full_context: true });
        return;
      }
      jsonError(res, 500, "server_error", error instanceof Error ? error.message : String(error));
    });
  });
  if (diagnosticLog) {
    server.once("error", () => diagnosticLog.close());
    server.once("close", () => diagnosticLog.close());
  }
  return server;
}

export function listenGateway(options: GatewayOptions): Promise<Server> {
  const host = options.host ?? "127.0.0.1";
  assertLoopbackBindHost(host);
  const server = createGateway(options);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: GatewayOptions,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && (path === "/healthz" || path === "/health")) {
    const compaction = options.compaction ?? { provider: "native", ollamaThreads: "summarize" };
    const presented = headerValue(req.headers["x-cob-nonce"]) ?? "";
    json(res, 200, {
      ok: true,
      service: "cob",
      pid: process.pid,
      nonce_ok: Boolean(options.nonce && presented === options.nonce),
      compaction: {
        provider: compaction.provider,
        model: compaction.model ?? null,
        ollama_threads: compaction.ollamaThreads ?? "summarize",
        ollama_model: compaction.ollamaModel ?? null,
        ollama_effort: compaction.ollamaEffort ?? null,
      },
    });
    return;
  }

  if (req.method === "POST" && path === "/cob/shutdown") {
    await handleShutdown(req, res, options);
    return;
  }

  if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
    const models = (resolveCatalog(options)?.models ?? []).map((model) => ({
      id: model.slug,
      object: "model",
      owned_by: typeof model.slug === "string" && model.slug.startsWith("ollama/") ? "ollama" : "openai",
    }));
    json(res, 200, { object: "list", data: models });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/alpha/search") {
    await handleNativeSearchPost(req, res, options, url.pathname);
    return;
  }

  if (isResponsesPath(path) && req.method !== "POST" && (isWebSocketUpgrade(req) || req.method === "GET")) {
    req.resume();
    jsonError(
      res,
      426,
      "upgrade_required",
      "Responses WebSocket transport is disabled; use HTTP.",
    );
    return;
  }

  if (req.method === "POST" && isCompactPath(path)) {
    await handleResponsesPost(req, res, options, path, "compact");
    return;
  }

  if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
    jsonError(
      res,
      400,
      "chat_completions_unsupported",
      "cob v1 is Responses-only. Use POST /v1/responses.",
    );
    return;
  }

  if (req.method === "POST" && isResponsesPath(path)) {
    await handleResponsesPost(req, res, options, path, "responses");
    return;
  }

  jsonError(res, 404, "not_found", `Unsupported path ${path}`);
}

async function handleShutdown(
  req: IncomingMessage,
  res: ServerResponse,
  options: GatewayOptions,
): Promise<void> {
  const abort = attachCancellation(req, res);
  const raw = await readLimitedBody(req, { signal: abort.signal });
  let nonce = headerValue(req.headers["x-cob-nonce"]) ?? "";
  if (!nonce) {
    try {
      const parsed: unknown = JSON.parse(raw.toString("utf8") || "{}");
      if (isRecord(parsed) && typeof parsed.nonce === "string") {
        nonce = parsed.nonce;
      }
    } catch {
      nonce = "";
    }
  }
  if (!options.nonce || nonce !== options.nonce) {
    jsonError(res, 403, "forbidden", "invalid cob shutdown nonce");
    return;
  }
  json(res, 200, { ok: true, stopping: true });
  setImmediate(() => process.kill(process.pid, "SIGTERM"));
}

function isResponsesPath(path: string): boolean {
  return path === "/v1/responses" || path === "/responses";
}

function isCompactPath(path: string): boolean {
  return path === "/v1/responses/compact" || path === "/responses/compact";
}

function isWebSocketUpgrade(req: IncomingMessage): boolean {
  const upgrade = headerValue(req.headers.upgrade)?.toLowerCase();
  if (upgrade === "websocket") return true;
  const connection = headerValue(req.headers.connection)?.toLowerCase() ?? "";
  return connection.split(",").some((part) => part.trim() === "upgrade") && upgrade === "websocket";
}
