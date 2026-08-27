import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { zstdCompressSync } from "node:zlib";
import { listenGateway } from "./codex/gateway.js";
import { resetCompactAttemptLog } from "./codex/compact-attempt-log.js";
import { pickForwardHeaders } from "./codex/native.js";
import { NATIVE_RESPONSES_URL, NATIVE_SEARCH_URL } from "./codex/constants.js";
import { MAX_RAW_BODY_BYTES } from "./core/http/body.js";
import { assertValidOllamaFollowUpInput, ollamaCompactHandoffSkeleton, ollamaFollowUpInputError } from "./codex/compaction.js";
import { normalizeOllamaResponse, prepareOllamaPayload, rejectOllamaRequest, sanitizeOllamaPayload } from "./codex/ollama.js";
import { APPLY_PATCH_TOOL_NAME, COB_APPLY_PATCH_ALIAS } from "./codex/experimental/apply-patch.js";
import {
  nativePlaintextSpawnSchemaSha256,
  NATIVE_PLAINTEXT_FOLLOWUP_ALIAS,
  NATIVE_PLAINTEXT_SEND_ALIAS,
} from "./codex/experimental/native-plaintext-spawn.js";
import type { CatalogFile } from "./codex/types.js";
import type { JsonObject } from "./core/json.js";

const TEST_CATALOG: CatalogFile = {
  models: [
    { slug: "gpt-5.6-luna", visibility: "list", priority: 0 },
    { slug: "o3", visibility: "list", priority: 6 },
    { slug: "codex-mini", visibility: "list", priority: 7 },
    { slug: "ollama/deepseek-v4-flash:cloud", visibility: "list", priority: 3 },
    { slug: "ollama/deepseek-v4-flash:0731-cloud", visibility: "list", priority: 3 },
    { slug: "ollama/library%2Fqwen2.5:7b", visibility: "list", priority: 20 },
  ],
};

function gate1Payload(): Record<string, unknown> {
  const spawn = {
    type: "function",
    name: "spawn_agent",
    description: "Spawn a child agent.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", encrypted: true, description: "Task message." },
        model: { type: "string" },
      },
      required: ["message", "model"],
      additionalProperties: false,
    },
    strict: true,
  };
  return {
    model: "gpt-5.6-sol",
    input: [{
      type: "additional_tools",
      role: "developer",
      tools: [
        {
          type: "namespace",
          name: "functions",
          description: "Ordinary functions.",
          tools: [{ type: "function", name: "exec_command" }],
        },
        {
          type: "namespace",
          name: "collaboration",
          description: "Reserved collaboration tools.",
          tools: [
            {
              type: "function",
              name: "followup_task",
              parameters: {
                type: "object",
                properties: {
                  target: { type: "string" },
                  message: { type: "string", encrypted: true },
                },
                required: ["target", "message"],
                additionalProperties: false,
              },
              strict: false,
            },
            { type: "function", name: "interrupt_agent" },
            { type: "function", name: "list_agents" },
            {
              type: "function",
              name: "send_message",
              parameters: {
                type: "object",
                properties: {
                  target: { type: "string" },
                  message: { type: "string", encrypted: true },
                },
                required: ["target", "message"],
                additionalProperties: false,
              },
              strict: true,
            },
            spawn,
            { type: "function", name: "wait_agent" },
          ],
        },
      ],
    }],
  };
}

function gate1SchemaDigest(payload: Record<string, unknown>): string {
  const input = payload.input as JsonObject[];
  const additional = input[0]!;
  const tools = additional.tools as JsonObject[];
  const namespace = tools.find((tool) => tool.name === "collaboration");
  assert.ok(namespace);
  return nativePlaintextSpawnSchemaSha256(namespace);
}

async function errorCode(response: Response): Promise<string | undefined> {
  const parsed: unknown = await response.json().catch(() => null);
  if (!parsed || typeof parsed !== "object" || !("error" in parsed)) return undefined;
  const error = (parsed as { error?: { code?: string } }).error;
  return error?.code;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      server.close((error) => (error ? reject(error) : resolve(addr.port)));
    });
    server.on("error", reject);
  });
}

describe("gateway", () => {
  it("rejects Chat Completions on the Ollama path without translating", () => {
    const rejection = rejectOllamaRequest({
      model: "ollama/deepseek-v4-flash:cloud",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(rejection?.status, 400);
    assert.equal(rejection?.body.error.code, "chat_completions_unsupported");
  });

  it("accepts a valid previous_response_id for local state resolution", () => {
    const rejection = rejectOllamaRequest({
      model: "ollama/deepseek-v4-flash:cloud",
      input: "hi",
      previous_response_id: "resp_123",
    });
    assert.equal(rejection, undefined);
  });

  it("rejects malformed previous_response_id values", () => {
    for (const value of ["", 0, null, {}, false]) {
      const rejection = rejectOllamaRequest({
        model: "ollama/deepseek-v4-flash:cloud",
        input: "hi",
        previous_response_id: value,
      });
      assert.equal(rejection?.body.error.code, "previous_response_id_invalid");
    }
  });

  it("strips the ollama/ prefix and ChatGPT-only fields before Ollama", () => {
    const sanitized = sanitizeOllamaPayload({
      model: "ollama/deepseek-v4-flash:cloud",
      input: "hi",
      store: true,
      service_tier: "priority",
    });
    assert.equal(sanitized.model, "deepseek-v4-flash:cloud");
    assert.equal("store" in sanitized, false);
    assert.equal("service_tier" in sanitized, false);
    assert.deepEqual(Object.keys(sanitized).sort(), ["input", "model", "reasoning"].sort());
  });

  it("maps Codex medium and xhigh reasoning onto DeepSeek high before Ollama", () => {
    const fromReasoning = sanitizeOllamaPayload({
      model: "ollama/deepseek-v4-flash:0731-cloud",
      input: "hi",
      reasoning: { effort: "medium", summary: "auto" },
    });
    assert.deepEqual(fromReasoning.reasoning, { effort: "high", summary: "auto" });

    const fromTopLevel = sanitizeOllamaPayload({
      model: "ollama/deepseek-v4-flash:0731-cloud",
      input: "hi",
      reasoning_effort: "xhigh",
    });
    assert.equal("reasoning_effort" in fromTopLevel, false);
    assert.deepEqual(fromTopLevel.reasoning, { effort: "high" });

    const passthrough = sanitizeOllamaPayload({
      model: "ollama/deepseek-v4-flash:0731-cloud",
      input: "hi",
      reasoning: { effort: "max" },
    });
    assert.deepEqual(passthrough.reasoning, { effort: "max" });
  });

  it("decodes slash-encoded Ollama slugs before the upstream call", () => {
    const sanitized = sanitizeOllamaPayload({
      model: "ollama/library%2Fqwen2.5:7b",
      input: "hi",
    });
    assert.equal(sanitized.model, "library/qwen2.5:7b");
  });

  it("forwards GPT requests to native and Ollama requests without ChatGPT headers", async () => {
    const seen: { nativeAuth?: string; ollamaAuth?: string; ollamaUrl?: string; ollamaModel?: string } = {};
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      nativeFetch: async (_url, init) => {
        seen.nativeAuth = init.headers.authorization;
        return new Response(JSON.stringify({ ok: "native" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      ollamaFetch: async (url, init) => {
        seen.ollamaUrl = url;
        seen.ollamaAuth = init.headers.authorization;
        const parsed: unknown = JSON.parse(init.body.toString("utf8"));
        seen.ollamaModel =
          parsed && typeof parsed === "object" && "model" in parsed && typeof parsed.model === "string"
            ? parsed.model
            : undefined;
        return new Response(JSON.stringify({ ok: "ollama" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    try {
      const native = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer secret-chatgpt",
          "chatgpt-account-id": "acct",
        },
        body: JSON.stringify({ model: "o3", input: "hi" }),
      });
      assert.equal(native.ok, true);
      assert.equal(seen.nativeAuth, "Bearer secret-chatgpt");

      const ollama = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer secret-chatgpt",
          "chatgpt-account-id": "acct",
        },
        body: JSON.stringify({ model: "ollama/deepseek-v4-flash:cloud", input: "hi" }),
      });
      assert.equal(ollama.ok, true);
      assert.equal(seen.ollamaAuth, undefined);
      assert.equal(seen.ollamaUrl?.endsWith("/v1/responses"), true);
      assert.equal(seen.ollamaModel, "deepseek-v4-flash:cloud");

      const slashed = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ollama/library%2Fqwen2.5:7b", input: "hi" }),
      });
      assert.equal(slashed.ok, true, await slashed.text());
      assert.equal(seen.ollamaModel, "library/qwen2.5:7b");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("does not relay a successful Ollama response whose body is not JSON", async () => {
    const secret = "SECRET_OLLAMA_HTML_BODY";
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      ollamaFetch: async () => new Response(`<html>${secret}</html>`, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ollama/deepseek-v4-flash:cloud", input: "hi" }),
      });
      const text = await response.text();
      assert.equal(response.status, 502);
      const body = JSON.parse(text) as { error?: { code?: string } };
      assert.equal(body.error?.code, "ollama_response_invalid_json");
      assert.equal(text.includes(secret), false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("does not relay malformed data lines on the Gate 5 Ollama SSE path", async () => {
    const secret = "SECRET_MALFORMED_SSE_DATA";
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      applyPatch: true,
      ollamaFetch: async () => new Response(`data: ${secret}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          input: "hi",
          tools: [{
            type: "custom",
            name: APPLY_PATCH_TOOL_NAME,
            format: { type: "grammar", syntax: "lark", definition: "start: /[^\\n]*/" },
          }],
        }),
      });
      const text = await response.text();
      // Headers are committed before streaming, so the provider-safe failure
      // is an SSE terminal while retaining the upstream 2xx status.
      assert.equal(response.status, 200);
      assert.match(text, /upstream_stream_error/);
      assert.match(text, /SSE data payload is invalid/);
      assert.equal(text.includes(secret), false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("forwards only standalone search to the native Codex endpoint with redacted logs", async () => {
    const secretQuery = "private-search-query";
    const requestBody = JSON.stringify({
      id: "search-session",
      model: "ollama/deepseek-v4-flash:0731-cloud",
      commands: { search_query: [{ q: secretQuery }] },
      settings: { external_web_access: "indexed" },
    });
    const seen: {
      url?: string;
      headers?: Record<string, string>;
      body?: string;
      nativeHits: number;
      ollamaHits: number;
    } = { nativeHits: 0, ollamaHits: 0 };
    const lines: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      nativeFetch: async (url, init) => {
        seen.nativeHits += 1;
        seen.url = url;
        seen.headers = { ...init.headers };
        seen.body = init.body.toString("utf8");
        return new Response(JSON.stringify({ output: "search-ok", results: [] }), {
          status: 200,
          headers: { "content-type": "application/json", "x-request-id": "req_search" },
        });
      },
      ollamaFetch: async () => {
        seen.ollamaHits += 1;
        return new Response("ollama must not receive standalone search", { status: 500 });
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/alpha/search`, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: "Bearer search-secret",
          "chatgpt-account-id": "acct-search-secret",
          "content-type": "application/json",
          "content-encoding": "zstd",
          cookie: "session=must-not-forward",
          originator: "codex_cli_rs",
          "x-codex-turn-metadata": "turn-metadata",
          "x-evil": "must-not-forward",
        },
        body: zstdCompressSync(Buffer.from(requestBody, "utf8")),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-request-id"), "req_search");
      assert.deepEqual(await response.json(), { output: "search-ok", results: [] });
      assert.equal(seen.nativeHits, 1);
      assert.equal(seen.ollamaHits, 0);
      assert.equal(seen.url, NATIVE_SEARCH_URL);
      assert.equal(seen.body, requestBody);
      assert.equal(seen.headers?.authorization, "Bearer search-secret");
      assert.equal(seen.headers?.["chatgpt-account-id"], "acct-search-secret");
      assert.equal(seen.headers?.originator, "codex_cli_rs");
      assert.equal(seen.headers?.["x-codex-turn-metadata"], "turn-metadata");
      assert.equal(seen.headers?.accept, "application/json");
      assert.equal(seen.headers?.["content-type"], "application/json");
      assert.equal(seen.headers?.["content-encoding"], undefined);
      assert.equal(seen.headers?.cookie, undefined);
      assert.equal(seen.headers?.["x-evil"], undefined);
      const logs = lines.join("\n");
      assert.match(logs, /POST \/v1\/alpha\/search/);
      assert.match(logs, /target=native-search/);
      assert.equal(logs.includes(secretQuery), false);
      assert.equal(logs.includes("search-secret"), false);
      assert.equal(logs.includes("turn-metadata"), false);
    } finally {
      console.error = originalError;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("preserves standalone search errors and never retries them through Ollama", async () => {
    let nativeHits = 0;
    let ollamaHits = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      nativeFetch: async () => {
        nativeHits += 1;
        return new Response(JSON.stringify({ error: { code: "search_rate_limited", message: "later" } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "11" },
        });
      },
      ollamaFetch: async () => {
        ollamaHits += 1;
        return new Response("no", { status: 500 });
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/alpha/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "search-session", model: "gpt-5.6-luna", commands: {} }),
      });
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("retry-after"), "11");
      assert.deepEqual(await response.json(), { error: { code: "search_rate_limited", message: "later" } });
      assert.equal(nativeHits, 1);
      assert.equal(ollamaHits, 0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("keeps every non-allowlisted search-like path and method closed", async () => {
    let nativeHits = 0;
    let ollamaHits = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      nativeFetch: async () => {
        nativeHits += 1;
        return new Response("unexpected native request", { status: 500 });
      },
      ollamaFetch: async () => {
        ollamaHits += 1;
        return new Response("unexpected Ollama request", { status: 500 });
      },
    });
    try {
      for (const path of ["/alpha/search", "/v1/alpha/search/", "/v1/alpha/search/child", "/v1/alpha/other"]) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        assert.equal(response.status, 404, path);
        assert.equal(await errorCode(response), "not_found", path);
      }
      const wrongMethod = await fetch(`http://127.0.0.1:${port}/v1/alpha/search`);
      assert.equal(wrongMethod.status, 404);
      assert.equal(await errorCode(wrongMethod), "not_found");
      assert.equal(nativeHits, 0);
      assert.equal(ollamaHits, 0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("logs numeric request buckets without tool schemas or previous_response_id values", async () => {
    const lines: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    };
    const port = await freePort();
    const stateDir = mkdtempSync(join(tmpdir(), "cob-metrics-"));
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      stateDir,
      ollamaFetch: async () =>
        new Response(
          JSON.stringify({
            id: "resp_metrics",
            object: "response",
            output: [{ type: "message", content: "secret-output" }],
            usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15, cached_input_tokens: 0 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          reasoning: { effort: "high" },
          tools: [
            {
              type: "function",
              name: "exec_command",
              description: "schema-secret",
            },
          ],
          input: [{ type: "message", role: "user", content: "hey" }],
        }),
      });
      assert.equal(response.ok, true);
      const joined = lines.join("\n");
      assert.match(joined, /target=ollama/);
      assert.match(joined, /tools_n=1/);
      assert.match(joined, /effort=high/);
      assert.match(joined, /prev_id=0/);
      assert.match(joined, /tool_bytes_top=\d+/);
      assert.equal(joined.includes("exec_command"), false);
      assert.match(joined, /\[cob\] ollama usage in=12 out=3/);
      assert.match(joined, /\[cob\] ollama wire [^\n]*b_instr=\d+/);
      assert.match(joined, /\[cob\] ollama wire [^\n]*b_input=\d+/);
      assert.match(joined, /\[cob\] ollama wire [^\n]*input_n=\d+/);
      assert.match(joined, /\[cob\] ollama wire [^\n]*input_by=message:user:1/);
      assert.equal(joined.includes("schema-secret"), false);
      assert.equal(joined.includes("secret-output"), false);
    } finally {
      console.error = originalError;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("promotes deferred search leaves on the Ollama wire and logs them separately from ingress", async () => {
    const lines: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    };
    let ollamaTools: { name?: string }[] = [];
    const port = await freePort();
    const stateDir = mkdtempSync(join(tmpdir(), "cob-promote-"));
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      stateDir,
      ollamaFetch: async (_url, init) => {
        const parsed: unknown = JSON.parse(init.body.toString("utf8"));
        ollamaTools =
          parsed && typeof parsed === "object" && "tools" in parsed && Array.isArray((parsed as { tools: unknown }).tools)
            ? ((parsed as { tools: { name?: string }[] }).tools)
            : [];
        return new Response(
          JSON.stringify({
            id: "resp_promote",
            object: "response",
            output: [
              {
                type: "function_call",
                name: "multi_agent_v1__spawn_agent",
                call_id: "spawn-1",
                arguments: JSON.stringify({
                  task: "read README",
                  model: "ollama/deepseek-v4-flash:0731-cloud",
                }),
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          tools: [{ type: "tool_search", description: "Find tools." }],
          input: [
            { type: "message", role: "user", content: "spawn a helper" },
            {
              type: "tool_search_call",
              call_id: "search-1",
              execution: "client",
              arguments: { query: "spawn_agent" },
            },
            {
              type: "tool_search_output",
              call_id: "search-1",
              status: "completed",
              execution: "client",
              tools: [
                {
                  type: "namespace",
                  name: "multi_agent_v1",
                  tools: [
                    {
                      type: "function",
                      name: "spawn_agent",
                      description: "Spawn a sub-agent.",
                      parameters: { type: "object", properties: { task: { type: "string" } } },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      });
      assert.equal(response.ok, true);
      const body = (await response.json()) as {
        output?: { name?: string; namespace?: string; type?: string }[];
      };
      assert.equal(ollamaTools.some((tool) => tool.name === "multi_agent_v1__spawn_agent"), true);
      assert.equal(ollamaTools.some((tool) => tool.name === "spawn_agent"), false);
      assert.equal(body.output?.[0]?.type, "function_call");
      assert.equal(body.output?.[0]?.name, "spawn_agent");
      assert.equal(body.output?.[0]?.namespace, "multi_agent_v1");
      const joined = lines.join("\n");
      assert.match(joined, /\[cob\] POST [^\n]*tools_n=1/);
      assert.match(joined, /\[cob\] ollama wire [^\n]*tools_n=2/);
      assert.match(joined, /\[cob\] ollama wire [^\n]*promoted_n=1/);
      assert.match(joined, /\[cob\] ollama wire [^\n]*b_input=\d+/);
      assert.match(joined, /\[cob\] ollama wire [^\n]*input_n=\d+/);
      assert.match(joined, /tool_bytes_top=\d+(?:,\d+)*/);
      assert.equal(joined.includes("multi_agent_v1__spawn_agent"), false);
      assert.equal(joined.includes("Spawn a sub-agent"), false);
    } finally {
      console.error = originalError;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("returns 400 for encrypted Ollama child tasks", async () => {
    let ollamaHits = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      ollamaFetch: async () => {
        ollamaHits += 1;
        return new Response("nope", { status: 500 });
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses/compact`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          input: [{ encrypted_content: "gAAAAAthis-is-ciphertext-and-must-not-be-forwarded" }],
        }),
      });
      assert.equal(response.status, 400);
      assert.equal(ollamaHits, 0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("rejects plaintext-looking encrypted_content instead of guessing", () => {
    const prepared = prepareOllamaPayload({
      model: "ollama/deepseek-v4-flash:cloud",
      input: [{ type: "reasoning", encrypted_content: "1. The user asks to reply with pong." }],
    });
    assert.equal("status" in prepared && "body" in prepared, true);
    assert.equal((prepared as { body: { error: { code: string } } }).body.error.code, "encrypted_content_unsupported");
  });

  it("rejects sibling encrypted_* fields and cob envelopes on the Ollama request", () => {
    const args = prepareOllamaPayload({
      model: "ollama/deepseek-v4-flash:cloud",
      input: [{ type: "function_call", name: "exec_command", encrypted_function_args: ["secret"] }],
    });
    assert.equal((args as { body: { error: { code: string } } }).body.error.code, "encrypted_content_unsupported");
    const envelope = prepareOllamaPayload({
      model: "ollama/deepseek-v4-flash:cloud",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "cob1.1.abc" }] }],
    });
    assert.equal((envelope as { body: { error: { code: string } } }).body.error.code, "encrypted_content_unsupported");
  });

  it("rejects object encrypted_content instead of forwarding it to Ollama", () => {
    const prepared = prepareOllamaPayload({
      model: "ollama/deepseek-v4-flash:cloud",
      input: [{ type: "reasoning", encrypted_content: { blob: "x" } }],
    });
    assert.equal("status" in prepared, true);
    assert.equal((prepared as { status: number }).status, 400);
    assert.equal((prepared as { body: { error: { code: string } } }).body.error.code, "encrypted_content_unsupported");
  });

  it("rejects an unresolved compaction item instead of inventing a developer note", () => {
    const prepared = prepareOllamaPayload({
      model: "ollama/deepseek-v4-flash:cloud",
      input: [{ type: "compaction", encrypted_content: { blob: "x" } }],
    });
    assert.equal("status" in prepared && "body" in prepared, true);
    assert.equal((prepared as { body: { error: { code: string } } }).body.error.code, "compaction_context_required");
  });

  it("returns the same object when an Ollama SSE event needs no rewrite", () => {
    const event = { type: "response.output_text.delta", delta: "hi" };
    assert.equal(normalizeOllamaResponse(event, "ollama/deepseek-v4-flash:cloud"), event);
  });

  it("rewrites bare Ollama model ids and drops response encrypted_content", () => {
    const normalized = normalizeOllamaResponse(
      {
        model: "deepseek-v4-flash:cloud",
        output: [{ type: "reasoning", encrypted_content: "plain", summary: [{ text: "plain" }] }],
      },
      "ollama/deepseek-v4-flash:cloud",
    );
    assert.deepEqual(normalized, {
      model: "ollama/deepseek-v4-flash:cloud",
      output: [{ type: "reasoning", summary: [{ text: "plain" }] }],
    });
  });

  it("does not rewrite nested tool argument model fields on the Ollama response path", () => {
    const normalized = normalizeOllamaResponse(
      {
        object: "response",
        model: "deepseek-v4-flash:cloud",
        output: [
          {
            type: "function_call",
            name: "spawn",
            arguments: { model: "keep-me", prompt: "hi" },
          },
        ],
      },
      "ollama/deepseek-v4-flash:cloud",
    );
    const record = normalized as {
      model: string;
      output: { arguments: { model: string } }[];
    };
    assert.equal(record.model, "ollama/deepseek-v4-flash:cloud");
    assert.equal(record.output[0]?.arguments.model, "keep-me");

    const event = normalizeOllamaResponse(
      {
        type: "response.created",
        response: {
          object: "response",
          model: "deepseek-v4-flash:cloud",
          output: [{ type: "function_call", arguments: { model: "keep-me" } }],
        },
      },
      "ollama/deepseek-v4-flash:cloud",
    ) as { response: { model: string; output: { arguments: { model: string } }[] } };
    assert.equal(event.response.model, "ollama/deepseek-v4-flash:cloud");
    assert.equal(event.response.output[0]?.arguments.model, "keep-me");
  });

  it("forwards new x-codex-* and x-openai-* headers on the native path", () => {
    const forwarded = pickForwardHeaders({
      authorization: "Bearer z",
      "x-codex-new-spawn-header": "keep",
      "x-openai-internal-codex-responses-lite": "true",
      "x-evil": "drop",
    });
    assert.equal(forwarded["x-codex-new-spawn-header"], "keep");
    assert.equal(forwarded["x-openai-internal-codex-responses-lite"], "true");
    assert.equal(forwarded["x-evil"], undefined);
  });

  it("returns 426 so Codex falls back from WebSocket to HTTP", async () => {
    const port = await freePort();
    const server = await listenGateway({ port });
    try {
      const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: "/v1/responses",
            method: "GET",
            headers: {
              connection: "Upgrade",
              upgrade: "websocket",
              "sec-websocket-version": "13",
              "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => {
              resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
            });
          },
        );
        req.on("error", reject);
        req.end();
      });
      assert.equal(status, 426);
      const parsed: unknown = JSON.parse(body);
      const code =
        parsed && typeof parsed === "object" && "error" in parsed
          ? (parsed as { error?: { code?: string } }).error?.code
          : undefined;
      assert.equal(code, "upgrade_required");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("decompresses Codex zstd bodies before routing", async () => {
    const seen: { nativeEncoding?: string; nativeBody?: string; ollamaBody?: string } = {};
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      nativeFetch: async (_url, init) => {
        seen.nativeEncoding = init.headers["content-encoding"];
        seen.nativeBody = init.body.toString("utf8");
        return new Response(JSON.stringify({ ok: "native" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      ollamaFetch: async (_url, init) => {
        seen.ollamaBody = init.body.toString("utf8");
        return new Response(JSON.stringify({ ok: "ollama" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    try {
      const gpt = JSON.stringify({ model: "gpt-5.6-luna", input: "hi" });
      const native = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-encoding": "zstd",
          "x-openai-internal-codex-responses-lite": "true",
        },
        body: zstdCompressSync(Buffer.from(gpt, "utf8")),
      });
      assert.equal(native.ok, true, await native.text());
      assert.equal(seen.nativeEncoding, undefined);
      assert.equal(seen.nativeBody, gpt);

      const ollamaPayload = JSON.stringify({
        model: "ollama/deepseek-v4-flash:0731-cloud",
        input: "pong",
      });
      const ollama = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-encoding": "zstd",
        },
        body: zstdCompressSync(Buffer.from(ollamaPayload, "utf8")),
      });
      assert.equal(ollama.ok, true, await ollama.text());
      assert.equal(JSON.parse(seen.ollamaBody ?? "{}").model, "deepseek-v4-flash:0731-cloud");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("fail-closes unreadable bodies instead of forwarding them native", async () => {
    let nativeHits = 0;
    let ollamaHits = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      nativeFetch: async () => {
        nativeHits += 1;
        return new Response(JSON.stringify({ ok: "native" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      ollamaFetch: async () => {
        ollamaHits += 1;
        return new Response("nope", { status: 500 });
      },
    });
    try {
      const garbage = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: Buffer.from([0x00, 0x01, 0x02, 0xff]),
      });
      assert.equal(garbage.status, 400);
      assert.equal(await errorCode(garbage), "invalid_json");

      const compressed = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "content-encoding": "zstd" },
        body: Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0xff]),
      });
      assert.equal(compressed.status, 400);
      assert.equal(await errorCode(compressed), "invalid_encoding");

      const compactGarbage = await fetch(`http://127.0.0.1:${port}/v1/responses/compact`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: Buffer.from([0x00, 0x01, 0x02, 0xff]),
      });
      assert.equal(compactGarbage.status, 400);
      assert.equal(await errorCode(compactGarbage), "invalid_json");

      const missing = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "hi" }),
      });
      assert.equal(missing.status, 400);
      assert.equal(await errorCode(missing), "missing_model");

      const unknown = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "not-in-any-catalog", input: "hi" }),
      });
      assert.equal(unknown.status, 400);
      assert.equal(await errorCode(unknown), "unknown_model");

      assert.equal(nativeHits, 0);
      assert.equal(ollamaHits, 0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("does not treat catalog-missing GPT slugs as native", async () => {
    let nativeHits = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      nativeFetch: async () => {
        nativeHits += 1;
        return new Response(JSON.stringify({ ok: "native" }), { status: 200 });
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6-luna", input: "hi" }),
      });
      assert.equal(response.status, 400);
      assert.equal(await errorCode(response), "unknown_model");
      assert.equal(nativeHits, 0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("rejects the legacy compact endpoint without contacting either provider", async () => {
    let nativeHits = 0;
    let ollamaHits = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      nativeFetch: async () => {
        nativeHits += 1;
        return new Response(JSON.stringify({ ok: "native" }), { status: 200 });
      },
      ollamaFetch: async () => {
        ollamaHits += 1;
        return new Response(JSON.stringify({ ok: "ollama" }), { status: 200 });
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses/compact`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "codex-mini", input: "compact this" }),
      });
      assert.equal(response.status, 400);
      assert.equal(await errorCode(response), "legacy_compaction_unavailable");
      assert.equal(nativeHits, 0);
      assert.equal(ollamaHits, 0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("routes an Ollama v2 trigger through the Ollama summarizer and replays the handoff", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-v2-summarize-"));
    const seen: { url?: string; body?: Record<string, unknown> } = {};
    let ollamaHits = 0;
    let nativeHits = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      stateDir,
      catalog: TEST_CATALOG,
      nativeFetch: async () => {
        nativeHits += 1;
        return new Response("native must not compact Ollama threads", { status: 500 });
      },
      ollamaFetch: async (url, init) => {
        ollamaHits += 1;
        seen.url = url;
        seen.body = JSON.parse(init.body.toString("utf8")) as Record<string, unknown>;
        assertValidOllamaFollowUpInput(seen.body.input);
        assert.equal(JSON.stringify(seen.body).includes("compaction_trigger"), false);
        assert.equal(JSON.stringify(seen.body).includes("encrypted_content"), false);
        assert.equal("tools" in seen.body, false);
        if (ollamaHits === 1) {
          assert.match(JSON.stringify(seen.body.input), /long task/);
          assert.equal(seen.body.stream, false);
          return new Response(
            JSON.stringify({
              id: "ollama-sum-1",
              object: "response",
              status: "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: ollamaCompactHandoffSkeleton({ Goal: "keep going" }) }],
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        assert.equal(JSON.stringify(seen.body).includes("long task"), false);
        assert.match(JSON.stringify(seen.body.input), /keep going/);
        assert.match(JSON.stringify(seen.body.input), /continue/);
        return new Response(
          JSON.stringify({
            id: "ollama-after-compact",
            object: "response",
            status: "completed",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "continued" }] }],
          }),
          { status: 200 },
        );
      },
    });
    try {
      const compact = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "long task" }] },
            { type: "reasoning", id: "rs_859731" },
            {
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "working" }],
            },
            { type: "compaction_trigger" },
          ],
        }),
      });
      const compactText = await compact.text();
      assert.equal(compact.status, 200, compactText);
      assert.match(compactText, /cob1\.1\./);
      assert.equal(compactText.includes("gAAAAA"), false);
      assert.equal(nativeHits, 0);
      assert.equal(ollamaHits, 1);
      assert.match(String(seen.url), /\/v1\/responses$/);
      assert.equal(seen.body?.model, "deepseek-v4-flash:cloud");
      const compactBody = JSON.parse(compactText) as {
        output?: { type?: string; encrypted_content?: string }[];
      };
      assert.equal(compactBody.output?.[0]?.type, "compaction");

      const follow = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          input: [
            compactBody.output?.[0],
            { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
          ],
        }),
      });
      assert.equal(follow.status, 200, await follow.text());
      assert.equal(ollamaHits, 2);
      assert.equal(nativeHits, 0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("fails closed when the Ollama summarizer calls a tool after a no-tools compact request", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-compact-tool-"));
    const seen: { body?: Record<string, unknown> } = {};
    let ollamaHits = 0;
    let nativeHits = 0;
    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    const port = await freePort();
    const server = await listenGateway({
      port,
      stateDir,
      catalog: TEST_CATALOG,
      nativeFetch: async () => {
        nativeHits += 1;
        return new Response("native must not compact Ollama threads", { status: 500 });
      },
      ollamaFetch: async (_url, init) => {
        ollamaHits += 1;
        seen.body = JSON.parse(init.body.toString("utf8")) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            id: "sum-tool",
            object: "response",
            status: "completed",
            output: [{ type: "function_call", name: "exec_command", arguments: "{}" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:0731-cloud",
          tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "task" }] },
            { type: "function_call", call_id: "c1", name: "exec_command", arguments: "{}" },
            { type: "function_call_output", call_id: "c1", output: "ok" },
            { type: "compaction_trigger" },
          ],
        }),
      });
      const body = (await response.json()) as {
        error?: { code?: string; message?: string; requires_full_context?: boolean };
      };
      assert.equal(response.status, 400);
      assert.equal(body.error?.code, "compaction_summary_invalid");
      assert.equal(
        body.error?.message,
        "Ollama compact summarizer called a tool; cob refuses to treat that as a handoff",
      );
      assert.equal(body.error?.requires_full_context, true);
      assert.equal(nativeHits, 0);
      assert.equal(ollamaHits, 1);
      assert.equal("tools" in (seen.body ?? {}), false);
      assert.equal(JSON.stringify(seen.body).includes("compaction_trigger"), false);
      const summarizerInput = Array.isArray(seen.body?.input) ? seen.body.input : [];
      assert.equal(
        summarizerInput.some(
          (item) => typeof item === "object" && item !== null && (item as { type?: string }).type === "function_call",
        ),
        false,
      );
      assert.match(JSON.stringify(summarizerInput), /compact item function_call/);
      assert.match(JSON.stringify(summarizerInput), /compact item function_call_output/);
      const failLine = logs.find((line) => line.includes("ollama compact failed"));
      assert.match(
        failLine ?? "",
        /^\[cob\] ollama compact failed code=compaction_summary_invalid compact_group=[0-9a-f]{8} compact_attempt=\d+$/,
      );
      assert.equal((failLine ?? "").includes("exec_command"), false);
      assert.equal(existsSync(join(stateDir, "checkpoints")), false);
      assert.equal(existsSync(join(stateDir, "compact-archive")), false);
    } finally {
      console.error = originalError;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("fails closed on an incomplete handoff skeleton without resending history", async () => {
    let ollamaHits = 0;
    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      nativeFetch: async () => new Response("nope", { status: 500 }),
      ollamaFetch: async () => {
        ollamaHits += 1;
        return new Response(
          JSON.stringify({
            id: "incomplete-sum",
            object: "response",
            status: "completed",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "plain recap" }] }],
          }),
          { status: 200 },
        );
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "task" }] },
            { type: "compaction_trigger" },
          ],
        }),
      });
      const body = (await response.json()) as {
        error?: { code?: string; requires_full_context?: boolean };
      };
      assert.equal(response.status, 400);
      assert.equal(body.error?.code, "compaction_summary_incomplete");
      assert.equal(body.error?.requires_full_context, true);
      assert.equal(ollamaHits, 1);
      assert.match(logs.join("\n"), /ollama compact failed code=compaction_summary_incomplete compact_group=[0-9a-f]{8} compact_attempt=/);
    } finally {
      console.error = originalError;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("groups Codex compact re-POSTs in logs without cob retrying", async () => {
    resetCompactAttemptLog();
    let ollamaHits = 0;
    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      nativeFetch: async () => new Response("nope", { status: 500 }),
      ollamaFetch: async () => {
        ollamaHits += 1;
        return new Response(
          JSON.stringify({
            id: `incomplete-sum-${ollamaHits}`,
            object: "response",
            status: "completed",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "plain recap" }] }],
          }),
          { status: 200 },
        );
      },
    });
    const compactBody = JSON.stringify({
      model: "ollama/deepseek-v4-flash:cloud",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "same-thread compact" }] },
        { type: "compaction_trigger" },
      ],
    });
    try {
      const first = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: compactBody,
      });
      const second = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: compactBody,
      });
      assert.equal(first.status, 400);
      assert.equal(second.status, 400);
      assert.equal(ollamaHits, 2);
      const failLines = logs.filter((line) => line.includes("ollama compact failed"));
      assert.equal(failLines.length, 2);
      assert.match(failLines[0] ?? "", /compact_attempt=1/);
      assert.match(failLines[1] ?? "", /compact_attempt=2/);
      const groupA = /compact_group=([0-9a-f]{8})/.exec(failLines[0] ?? "")?.[1];
      const groupB = /compact_group=([0-9a-f]{8})/.exec(failLines[1] ?? "")?.[1];
      assert.equal(groupA, groupB);
      assert.equal(failLines.join("\n").includes("same-thread compact"), false);
    } finally {
      console.error = originalError;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("sends opt-in low summarizer effort without changing the omitted default", async () => {
    const seen: { body?: Record<string, unknown> } = {};
    const stateDir = mkdtempSync(join(tmpdir(), "cob-compact-effort-"));
    const port = await freePort();
    const server = await listenGateway({
      port,
      stateDir,
      catalog: {
        models: TEST_CATALOG.models.map((model) =>
          model.slug === "ollama/deepseek-v4-flash:cloud"
            ? {
                ...model,
                supported_reasoning_levels: [
                  { effort: "none" },
                  { effort: "low" },
                  { effort: "high" },
                  { effort: "max" },
                ],
              }
            : model,
        ),
      },
      compaction: { provider: "native", ollamaEffort: "low" },
      nativeFetch: async () => new Response("nope", { status: 500 }),
      ollamaFetch: async (_url, init) => {
        seen.body = JSON.parse(init.body.toString("utf8")) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            id: "sum-low",
            object: "response",
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: ollamaCompactHandoffSkeleton({ Goal: "low effort" }) }],
              },
            ],
          }),
          { status: 200 },
        );
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "task" }] },
            { type: "compaction_trigger" },
          ],
        }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(seen.body?.reasoning, { effort: "low" });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("fails closed when the Ollama summarizer returns empty text", async () => {
    let nativeHits = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      nativeFetch: async () => {
        nativeHits += 1;
        return new Response("nope", { status: 500 });
      },
      ollamaFetch: async () =>
        new Response(
          JSON.stringify({
            id: "empty-sum",
            object: "response",
            status: "completed",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "   " }] }],
          }),
          { status: 200 },
        ),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "task" }] },
            { type: "compaction_trigger" },
          ],
        }),
      });
      assert.equal(response.status, 400);
      assert.equal(await errorCode(response), "compaction_summary_empty");
      assert.equal(nativeHits, 0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("routes an Ollama v2 trigger to native responses and replays its opaque state safely", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-v2-compaction-"));
    const seen: { url?: string; body?: Record<string, unknown> } = {};
    let ollamaHits = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      stateDir,
      catalog: TEST_CATALOG,
      compaction: { provider: "native", model: "codex-mini", ollamaThreads: "native" },
      nativeFetch: async (url, init) => {
        seen.url = url;
        seen.body = JSON.parse(init.body.toString("utf8")) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            id: "compact-v2-1",
            object: "response",
            status: "completed",
            model: "codex-mini",
            output: [{ type: "compaction", id: "compact-item-1", encrypted_content: "gAAAAAopaque" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
      ollamaFetch: async (_url, init) => {
        ollamaHits += 1;
        const body = JSON.parse(init.body.toString("utf8")) as Record<string, unknown>;
        assertValidOllamaFollowUpInput(body.input);
        assert.equal(JSON.stringify(body).includes("gAAAAAopaque"), false);
        return new Response(
          JSON.stringify({
            id: "ollama-after-compact",
            object: "response",
            status: "completed",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "continued" }] }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    try {
      const compact = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "long task" }] },
            { type: "reasoning", id: "rs_859731" },
            {
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "working" }],
            },
            { type: "compaction_trigger" },
          ],
        }),
      });
      const compactText = await compact.text();
      assert.equal(compact.status, 200, compactText);
      assert.match(compactText, /gAAAAAopaque/);
      assert.equal(seen.url, NATIVE_RESPONSES_URL);
      assert.equal(seen.body?.model, "codex-mini");
      assert.equal("previous_response_id" in (seen.body ?? {}), false);
      assert.deepEqual((seen.body?.input as unknown[]).at(-1), { type: "compaction_trigger" });
      const compactInput = seen.body?.input as {
        role?: string;
        type?: string;
        id?: string;
        summary?: unknown;
        content?: { type: string }[];
      }[];
      assert.equal(compactInput.some((item) => item.type === "reasoning" && !item.summary), false);
      assert.equal(JSON.stringify(seen.body).includes("rs_859731"), false);
      assert.equal(compactInput[0]?.role, "user");
      assert.equal(compactInput[0]?.content?.[0]?.type, "input_text");
      assert.equal(compactInput[1]?.role, "assistant");
      assert.equal(compactInput[1]?.content?.[0]?.type, "output_text");
      assert.equal(ollamaHits, 0);

      const follow = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          input: [
            { type: "compaction", id: "compact-item-1", encrypted_content: "gAAAAAopaque" },
            { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
          ],
        }),
      });
      assert.equal(follow.status, 200, await follow.text());
      assert.equal(ollamaHits, 1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("streams an Ollama v2 compaction through native responses unchanged", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-v2-compaction-sse-"));
    const seen: { url?: string; model?: string; stream?: unknown } = {};
    let ollamaHits = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      stateDir,
      catalog: TEST_CATALOG,
      compaction: { provider: "native", model: "codex-mini", ollamaThreads: "native" },
      nativeFetch: async (url, init) => {
        seen.url = url;
        const parsed: unknown = JSON.parse(init.body.toString("utf8"));
        if (parsed && typeof parsed === "object") {
          const record = parsed as { model?: string; stream?: unknown };
          seen.model = record.model;
          seen.stream = record.stream;
        }
        const sse = [
          'data: {"type":"response.created","response":{"id":"compact-sse-1","object":"response","model":"codex-mini","output":[]}}',
          "",
          'data: {"type":"response.completed","response":{"id":"compact-sse-1","object":"response","model":"codex-mini","status":"completed","output":[{"type":"compaction","id":"compact-item-sse","encrypted_content":"gAAAAAsecret"}]}}',
          "",
          "data: [DONE]",
          "",
        ].join("\n");
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
      ollamaFetch: async () => {
        ollamaHits += 1;
        return new Response("nope", { status: 500 });
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          stream: true,
          input: [{ type: "function_call", name: "shell", arguments: "{}" }, { type: "compaction_trigger" }],
        }),
      });
      assert.equal(response.ok, true, await response.clone().text());
      assert.equal(seen.url, NATIVE_RESPONSES_URL);
      assert.equal(seen.model, "codex-mini");
      assert.equal(seen.stream, true);
      assert.equal(ollamaHits, 0);
      const text = await response.text();
      assert.match(text, /gAAAAAsecret/);
      assert.match(text, /response.completed/);
      assert.match(text, /\[DONE\]/);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("streams a cob compaction envelope after the Ollama summarizer", async () => {
    let nativeHits = 0;
    let ollamaHits = 0;
    const stateDir = mkdtempSync(join(tmpdir(), "cob-v2-summarize-sse-"));
    const port = await freePort();
    const server = await listenGateway({
      port,
      stateDir,
      catalog: TEST_CATALOG,
      nativeFetch: async () => {
        nativeHits += 1;
        return new Response("nope", { status: 500 });
      },
      ollamaFetch: async (_url, init) => {
        ollamaHits += 1;
        const body = JSON.parse(init.body.toString("utf8")) as { stream?: unknown };
        assert.equal(body.stream, false);
        return new Response(
          JSON.stringify({
            id: "sum-sse",
            object: "response",
            status: "completed",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: ollamaCompactHandoffSkeleton({ Goal: "short handoff" }) }] }],
          }),
          { status: 200 },
        );
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          stream: true,
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "task" }] },
            { type: "compaction_trigger" },
          ],
        }),
      });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      assert.equal(response.headers.get("content-type"), "text/event-stream");
      assert.equal(nativeHits, 0);
      assert.equal(ollamaHits, 1);
      assert.match(text, /cob1\.1\./);
      assert.match(text, /response.completed/);
      assert.match(text, /\[DONE\]/);
      assert.equal(text.includes("gAAAAA"), false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("does not forward Codex item_reference or web_search_call to the Ollama summarizer", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-v2-summarize-types-"));
    let seen = "";
    const port = await freePort();
    const server = await listenGateway({
      port,
      stateDir,
      catalog: TEST_CATALOG,
      nativeFetch: async () => new Response("nope", { status: 500 }),
      ollamaFetch: async (_url, init) => {
        seen = init.body.toString("utf8");
        return new Response(
          JSON.stringify({
            id: "sum-types",
            object: "response",
            status: "completed",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: ollamaCompactHandoffSkeleton({ Goal: "handoff" }) }] }],
          }),
          { status: 200 },
        );
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "search then compact" }] },
            { type: "item_reference", id: "rs_1" },
            { type: "web_search_call", id: "ws_1", status: "completed", query: "deepseek" },
            { type: "compaction_trigger" },
          ],
        }),
      });
      assert.equal(response.status, 200, await response.text());
      assert.equal(seen.includes('"type":"item_reference"'), false);
      assert.equal(seen.includes('"type":"web_search_call"'), false);
      assert.match(seen, /search then compact/);
      assert.match(seen, /compact item web_search_call/);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("fails closed on unsupported multimodal Ollama compact history", async () => {
    let ollamaHits = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      ollamaFetch: async () => {
        ollamaHits += 1;
        return new Response("nope", { status: 500 });
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_image", image_url: "data:image/png;base64,xx" }],
            },
            { type: "compaction_trigger" },
          ],
        }),
      });
      assert.equal(response.status, 400);
      assert.equal(await errorCode(response), "compaction_unsupported_input");
      assert.equal(ollamaHits, 0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("fails closed when an opaque compaction item has no local checkpoint", async () => {
    let ollamaHits = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      ollamaFetch: async () => {
        ollamaHits += 1;
        return new Response(JSON.stringify({ ok: "ollama" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          input: [
            { type: "compaction", id: "not-archived", encrypted_content: "gAAAAAchatgpt-compact" },
            { type: "function_call_output", call_id: "c1", output: "ok" },
          ],
        }),
      });
      assert.equal(response.status, 400);
      assert.equal(await errorCode(response), "state_checkpoint_missing");
      assert.equal(ollamaHits, 0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("does not require a model on health or shutdown", async () => {
    const port = await freePort();
    const server = await listenGateway({
      port,
      nonce: "secret-nonce",
      compaction: { provider: "native", model: "codex-mini", ollamaThreads: "native" },
    });
    try {
      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      assert.equal(health.ok, true);
      const body: unknown = await health.json();
      assert.equal((body as { compaction?: { provider?: string } }).compaction?.provider, "native");
      assert.equal((body as { service?: string }).service, "cob");
      assert.equal((body as { nonce_ok?: boolean }).nonce_ok, false);
      assert.equal((body as { pid?: number }).pid, process.pid);
      const shutdown = await fetch(`http://127.0.0.1:${port}/cob/shutdown`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(shutdown.status, 403);
      assert.equal(await errorCode(shutdown), "forbidden");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("handles POST /v1/responses even if Upgrade headers are present", async () => {
    let nativeHits = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      nativeFetch: async () => {
        nativeHits += 1;
        return new Response(JSON.stringify({ ok: "native" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    try {
      const payload = JSON.stringify({ model: "gpt-5.6-luna", input: "hi" });
      const { status } = await new Promise<{ status: number }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: "/v1/responses",
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
              connection: "Upgrade",
              upgrade: "websocket",
            },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
          },
        );
        req.on("error", reject);
        req.end(payload);
      });
      assert.equal(status, 200);
      assert.equal(nativeHits, 1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("rejects oversized Content-Length before reading or forwarding", async () => {
    let nativeHits = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      nativeFetch: async () => {
        nativeHits += 1;
        return new Response("nope", { status: 500 });
      },
    });
    try {
      const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: "/v1/responses",
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": String(MAX_RAW_BODY_BYTES + 1),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => {
              resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
            });
          },
        );
        req.on("error", reject);
        req.end();
      });
      assert.equal(status, 413);
      assert.match(body, /payload_too_large/);
      assert.equal(nativeHits, 0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("closes an idle stream without using a total generation timeout", async () => {
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      idleMs: 40,
      nativeFetch: async () => {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"ok":true}\n\n'));
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      const started = Date.now();
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "o3", input: "hi", stream: true }),
      });
      await response.text();
      assert.ok(Date.now() - started < 1500);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("times out a hung non-stream Ollama body", async () => {
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      idleMs: 40,
      ollamaFetch: async () => {
        const stream = new ReadableStream({
          start() {
            // headers exist; body never arrives
          },
        });
        return new Response(stream, { headers: { "content-type": "application/json" } });
      },
    });
    try {
      const started = Date.now();
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ollama/deepseek-v4-flash:cloud", input: "hi" }),
      });
      const payload: unknown = await response.json();
      assert.equal(response.status, 504);
      assert.equal((payload as { error?: { code?: string } }).error?.code, "idle_timeout");
      assert.ok(Date.now() - started < 1500);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("aborts upstream when the client disconnects during upload", async () => {
    let nativeHits = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      nativeFetch: async () => {
        nativeHits += 1;
        return new Response(JSON.stringify({ ok: "native" }), { status: 200 });
      },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest({
          host: "127.0.0.1",
          port,
          path: "/v1/responses",
          method: "POST",
          headers: { "content-type": "application/json" },
        });
        req.on("error", () => resolve());
        req.write('{"model":"gpt-5.6-luna","input":"');
        setTimeout(() => {
          req.destroy();
          setTimeout(resolve, 50);
        }, 20);
        req.on("response", () => reject(new Error("should not complete")));
      });
      assert.equal(nativeHits, 0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("fails closed when Ollama-thread compact references missing local state", async () => {
    let seen: { model?: string; previous_response_id?: string } | undefined;
    let ollamaHits = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      compaction: { provider: "native", model: "codex-mini", ollamaThreads: "native" },
      nativeFetch: async (_url, init) => {
        seen = JSON.parse(init.body.toString("utf8")) as { model?: string; previous_response_id?: string };
        return new Response(
          JSON.stringify({ object: "response.compaction", model: "codex-mini", output: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
      ollamaFetch: async () => {
        ollamaHits += 1;
        return new Response("nope", { status: 500 });
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          previous_response_id: "resp_123",
          input: [{ type: "compaction_trigger" }],
        }),
      });
      assert.equal(response.status, 400);
      assert.equal(await errorCode(response), "state_checkpoint_missing");
      assert.equal(seen, undefined);
      assert.equal(ollamaHits, 0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("reloads catalog from disk so cob sync is visible without restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-catalog-reload-"));
    const catalogPath = join(dir, "cob-catalog.json");
    writeFileSync(catalogPath, `${JSON.stringify({ models: [{ slug: "gpt-old" }] })}\n`);
    let nativeModel: string | undefined;
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalogPath,
      catalog: { models: [{ slug: "gpt-old" }] },
      nativeFetch: async (_url, init) => {
        const parsed: unknown = JSON.parse(init.body.toString("utf8"));
        nativeModel =
          parsed && typeof parsed === "object" && "model" in parsed && typeof parsed.model === "string"
            ? parsed.model
            : undefined;
        return new Response(JSON.stringify({ ok: "native" }), { status: 200 });
      },
    });
    try {
      const missing = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-new", input: "hi" }),
      });
      assert.equal(missing.status, 400);
      assert.equal(await errorCode(missing), "unknown_model");

      writeFileSync(
        catalogPath,
        `${JSON.stringify({ models: [{ slug: "gpt-old" }, { slug: "gpt-new" }] })}\n`,
      );
      const listed = await fetch(`http://127.0.0.1:${port}/v1/models`);
      const body = (await listed.json()) as { data: { id: string }[] };
      assert.equal(body.data.some((model) => model.id === "gpt-new"), true);

      const ok = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-new", input: "hi" }),
      });
      assert.equal(ok.ok, true, await ok.text());
      assert.equal(nativeModel, "gpt-new");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("forwards native request bytes unchanged including unreviewed fields", async () => {
    const requestBody = JSON.stringify({
      model: "gpt-5.6-luna",
      input: "hi",
      foo_future: true,
      conversation: { id: "keep-native" },
    });
    let seen: Buffer | undefined;
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      nativeFetch: async (_url, init) => {
        seen = init.body;
        return new Response(JSON.stringify({ ok: "native" }), { status: 200 });
      },
      ollamaFetch: async () => new Response("must not hit Ollama", { status: 500 }),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
      });
      assert.equal(response.ok, true);
      assert.equal(seen?.toString("utf8"), requestBody);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("fails Gate 1 before the native upstream on a missing or mismatched Sol fingerprint", async () => {
    let nativeHits = 0;
    const catalog: CatalogFile = {
      models: [...TEST_CATALOG.models, { slug: "gpt-5.6-sol", visibility: "list", priority: 0 }],
    };
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog,
      nativePlaintextSpawn: { enabled: true, schemaSha256: "0".repeat(64) },
      nativeFetch: async () => {
        nativeHits += 1;
        return new Response(JSON.stringify({ ok: "must not hit native" }), { status: 500 });
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(gate1Payload()),
      });
      assert.equal(response.status, 409);
      assert.equal(await errorCode(response), "native_plaintext_spawn_schema_mismatch");
      assert.equal(nativeHits, 0);

      const missing = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }),
      });
      assert.equal(missing.status, 409);
      assert.equal(await errorCode(missing), "native_plaintext_spawn_schema_missing");
      assert.equal(nativeHits, 0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("rewrites and restores Gate 2 send_message without cross-mapping the spawn alias", async () => {
    const payload = gate1Payload();
    const digest = gate1SchemaDigest(payload);
    let seen: JsonObject | undefined;
    const message = "line 1\r\nline 2 \"quoted\" 😀 e\u0301";
    const argumentsJson = JSON.stringify({ target: "child-0731", message });
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: {
        models: [...TEST_CATALOG.models, { slug: "gpt-5.6-sol", visibility: "list", priority: 0 }],
      },
      nativePlaintextSpawn: { enabled: true, schemaSha256: digest },
      nativeFetch: async (_url, init) => {
        seen = JSON.parse(init.body.toString("utf8")) as JsonObject;
        return new Response(JSON.stringify({
          type: "response",
          output: [{
            type: "function_call",
            name: NATIVE_PLAINTEXT_SEND_ALIAS,
            call_id: "call_send",
            arguments: argumentsJson,
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
      ollamaFetch: async () => new Response("must not hit Ollama", { status: 500 }),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as JsonObject;
      const mapped = (body.output as JsonObject[])[0]!;
      assert.deepEqual(mapped, {
        type: "function_call",
        name: "send_message",
        namespace: "collaboration",
        call_id: "call_send",
        arguments: argumentsJson,
        encrypted_function_args: [],
      });
      assert.ok(seen);
      const additional = (seen.input as JsonObject[])[0]!;
      const tools = additional.tools as JsonObject[];
      assert.deepEqual(tools.map((tool) => tool.name), [
        "functions",
        "collaboration",
        "cob_plaintext_spawn_agent",
        NATIVE_PLAINTEXT_SEND_ALIAS,
        NATIVE_PLAINTEXT_FOLLOWUP_ALIAS,
      ]);
      const namespace = tools.find((tool) => tool.name === "collaboration")!;
      assert.deepEqual(
        (namespace.tools as JsonObject[]).map((tool) => tool.name),
        ["interrupt_agent", "list_agents", "wait_agent"],
      );
      const sendAlias = tools.find((tool) => tool.name === NATIVE_PLAINTEXT_SEND_ALIAS)!;
      const sendMessage = ((sendAlias.parameters as JsonObject).properties as JsonObject).message as JsonObject;
      assert.equal("encrypted" in sendMessage, false);
      const spawnAlias = tools.find((tool) => tool.name === "cob_plaintext_spawn_agent")!;
      assert.equal(spawnAlias.name, "cob_plaintext_spawn_agent");
      const followupAlias = tools.find((tool) => tool.name === NATIVE_PLAINTEXT_FOLLOWUP_ALIAS)!;
      const followupMessage = ((followupAlias.parameters as JsonObject).properties as JsonObject).message as JsonObject;
      assert.equal("encrypted" in followupMessage, false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("rewrites and restores Gate 3 followup_task while preserving its target", async () => {
    const payload = gate1Payload();
    const digest = gate1SchemaDigest(payload);
    let seen: JsonObject | undefined;
    const message = "follow-up line 1\r\nfollow-up 😀";
    const argumentsJson = JSON.stringify({ target: "child-0731", message });
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: {
        models: [...TEST_CATALOG.models, { slug: "gpt-5.6-sol", visibility: "list", priority: 0 }],
      },
      nativePlaintextSpawn: { enabled: true, schemaSha256: digest },
      nativeFetch: async (_url, init) => {
        seen = JSON.parse(init.body.toString("utf8")) as JsonObject;
        return new Response(JSON.stringify({
          type: "response",
          output: [{
            type: "function_call",
            name: NATIVE_PLAINTEXT_FOLLOWUP_ALIAS,
            call_id: "call_followup",
            arguments: argumentsJson,
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
      ollamaFetch: async () => new Response("must not hit Ollama", { status: 500 }),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as JsonObject;
      assert.deepEqual((body.output as JsonObject[])[0], {
        type: "function_call",
        name: "followup_task",
        namespace: "collaboration",
        call_id: "call_followup",
        arguments: argumentsJson,
        encrypted_function_args: [],
      });
      assert.ok(seen);
      const additional = (seen.input as JsonObject[])[0]!;
      const tools = additional.tools as JsonObject[];
      assert.deepEqual(tools.map((tool) => tool.name), [
        "functions",
        "collaboration",
        "cob_plaintext_spawn_agent",
        NATIVE_PLAINTEXT_SEND_ALIAS,
        NATIVE_PLAINTEXT_FOLLOWUP_ALIAS,
      ]);
      const namespace = tools.find((tool) => tool.name === "collaboration")!;
      assert.deepEqual((namespace.tools as JsonObject[]).map((tool) => tool.name), [
        "interrupt_agent",
        "list_agents",
        "wait_agent",
      ]);
      const followupAlias = tools.find((tool) => tool.name === NATIVE_PLAINTEXT_FOLLOWUP_ALIAS)!;
      const properties = (followupAlias.parameters as JsonObject).properties as JsonObject;
      assert.deepEqual(properties.target, { type: "string" });
      assert.equal("encrypted" in (properties.message as JsonObject), false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("returns and logs only structural diagnostics for rejected Gate 1 responses", async () => {
    const payload = gate1Payload();
    const digest = gate1SchemaDigest(payload);
    const upstreamBodies = [
      "not-json SECRET_ARGUMENT",
      JSON.stringify(["SECRET_ARGUMENT"]),
      JSON.stringify({
        id: "resp_secret",
        output: [{
          type: "function_call",
          name: "collaboration.spawn_agent",
          arguments: JSON.stringify({ message: "SECRET_ARGUMENT" }),
        }],
      }),
    ];
    const expectedCodes = [
      "native_plaintext_spawn_response_invalid_json",
      "native_plaintext_spawn_response_top_level_array",
      "native_plaintext_spawn_canonical_output",
    ];
    const logs: string[] = [];
    const originalError = console.error;
    let nativeHits = 0;
    const port = await freePort();
    console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    const server = await listenGateway({
      port,
      catalog: {
        models: [...TEST_CATALOG.models, { slug: "gpt-5.6-sol", visibility: "list", priority: 0 }],
      },
      nativePlaintextSpawn: { enabled: true, schemaSha256: digest },
      nativeFetch: async () => new Response(upstreamBodies[nativeHits++]!, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    try {
      for (const expectedCode of expectedCodes) {
        const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const text = await response.text();
        const parsed = JSON.parse(text) as {
          error?: {
            code?: string;
            diagnostics?: {
              upstream_status?: number;
              upstream_content_type?: string;
              raw_byte_length?: number;
              json_classification?: string;
              top_level_type?: string;
              top_level_keys?: string[];
              mapper_error_class?: string;
              mapper_error_code?: string;
            };
          };
        };
        assert.equal(response.status, 502);
        assert.equal(parsed.error?.code, expectedCode);
        assert.equal(parsed.error?.diagnostics?.upstream_status, 200);
        assert.equal(parsed.error?.diagnostics?.upstream_content_type, "application/json");
        assert.equal(typeof parsed.error?.diagnostics?.raw_byte_length, "number");
        assert.equal(parsed.error?.diagnostics?.mapper_error_class, "NativePlaintextSpawnError");
        assert.equal(parsed.error?.diagnostics?.mapper_error_code, expectedCode);
        assert.equal(text.includes("SECRET_ARGUMENT"), false);
        assert.equal(text.includes("resp_secret"), false);
      }
      assert.equal(nativeHits, 3);
      const joined = logs.join("\n");
      assert.match(joined, /upstream_status=200/);
      assert.match(joined, /upstream_content_type="application\/json"/);
      assert.match(joined, /json_classification=invalid/);
      assert.match(joined, /json_classification=array/);
      assert.match(joined, /json_classification=object/);
      assert.match(joined, /mapper_error_code="native_plaintext_spawn_canonical_output"/);
      assert.equal(joined.includes("SECRET_ARGUMENT"), false);
      assert.equal(joined.includes("resp_secret"), false);
    } finally {
      console.error = originalError;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("maps headerless native Gate 1 SSE and preserves the protocol terminal", async () => {
    const payload = gate1Payload();
    const digest = gate1SchemaDigest(payload);
    const alias = "cob_plaintext_spawn_agent";
    const message = "line 1\r\nline 2 \"quoted\" 😀 e\u0301";
    const argumentsJson = JSON.stringify({ message });
    const sse = [
      `data: ${JSON.stringify({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", name: alias, call_id: "call_headerless" },
      })}\r\n`,
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "function_call",
          name: alias,
          call_id: "call_headerless",
          arguments: argumentsJson,
        },
      })}\r\n`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_headerless",
          object: "response",
          status: "completed",
          output: [{
            type: "function_call",
            name: alias,
            call_id: "call_headerless",
            arguments: argumentsJson,
          }],
        },
      })}\r\n`,
      "data: [DONE]\r\n",
      "\r\n",
    ].join("\r\n");
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: {
        models: [...TEST_CATALOG.models, { slug: "gpt-5.6-sol", visibility: "list", priority: 0 }],
      },
      nativePlaintextSpawn: { enabled: true, schemaSha256: digest },
      nativeFetch: async () => new Response(Buffer.from(sse, "utf8"), { status: 200 }),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.text();
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "text/event-stream");
      assert.equal(response.headers.get("content-length"), String(Buffer.byteLength(body, "utf8")));
      assert.equal(body.includes(alias), false);
      assert.match(body, /data: \[DONE\]\n/);
      const events = parseSsePayloads(body.replace(/\r\n/g, "\n"));
      const added = events.find(
        (event) => event && typeof event === "object" && (event as { type?: string }).type === "response.output_item.added",
      ) as { item?: Record<string, unknown> } | undefined;
      const done = events.find(
        (event) => event && typeof event === "object" && (event as { type?: string }).type === "response.output_item.done",
      ) as { item?: Record<string, unknown> } | undefined;
      const completed = events.find(
        (event) => event && typeof event === "object" && (event as { type?: string }).type === "response.completed",
      ) as { response?: { output?: Record<string, unknown>[] } } | undefined;
      assert.deepEqual(
        { name: added?.item?.name, namespace: added?.item?.namespace, encrypted: added?.item?.encrypted_function_args },
        { name: "spawn_agent", namespace: "collaboration", encrypted: [] },
      );
      assert.equal(done?.item?.name, "spawn_agent");
      assert.equal(done?.item?.namespace, "collaboration");
      assert.deepEqual(done?.item?.encrypted_function_args, []);
      assert.equal(completed?.response?.output?.[0]?.name, "spawn_agent");
      assert.equal(completed?.response?.output?.[0]?.namespace, "collaboration");
      assert.deepEqual(completed?.response?.output?.[0]?.encrypted_function_args, []);
      assert.equal(completed?.response?.output?.[0]?.arguments, argumentsJson);
      assert.equal(events.filter((event) => event === "[DONE]").length, 1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("fails closed for malformed or canonical headerless Gate 1 SSE without leaking the alias", async () => {
    const payload = gate1Payload();
    const digest = gate1SchemaDigest(payload);
    const alias = "cob_plaintext_spawn_agent";
    const malformed = `data: {"type":"response.completed","response":{"output":[{"type":"function_call","name":"${alias}","arguments":"not-json"}]}}\n\n`;
    const canonical = `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        output: [{ type: "function_call", name: "collaboration.spawn_agent", arguments: "{}" }],
      },
    })}\n\n`;
    let nativeHits = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: {
        models: [...TEST_CATALOG.models, { slug: "gpt-5.6-sol", visibility: "list", priority: 0 }],
      },
      nativePlaintextSpawn: { enabled: true, schemaSha256: digest },
      nativeFetch: async () => new Response(Buffer.from(nativeHits++ === 0 ? malformed : canonical, "utf8"), { status: 200 }),
    });
    try {
      for (const expectedCode of ["native_plaintext_spawn_arguments_invalid", "native_plaintext_spawn_canonical_output"]) {
        const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const text = await response.text();
        assert.equal(response.status, 502);
        assert.equal((JSON.parse(text) as { error?: { code?: string } }).error?.code, expectedCode);
        assert.equal(text.includes(alias), false);
        assert.equal(text.includes("not-json"), false);
        assert.equal(text.includes("collaboration.spawn_agent"), false);
      }
      assert.equal(nativeHits, 2);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("does not leak a Gate alias from bare JSON or malformed SSE data", async () => {
    const payload = gate1Payload();
    const digest = gate1SchemaDigest(payload);
    const alias = NATIVE_PLAINTEXT_FOLLOWUP_ALIAS;
    const bareJson = JSON.stringify({
      type: "response",
      output: [{
        type: "function_call",
        name: alias,
        arguments: JSON.stringify({ target: "child-0731", message: "SECRET_ARGUMENT" }),
      }],
    });
    const malformedData = `data: ${alias} SECRET_ARGUMENT\n\n`;
    let nativeHits = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: {
        models: [...TEST_CATALOG.models, { slug: "gpt-5.6-sol", visibility: "list", priority: 0 }],
      },
      nativePlaintextSpawn: { enabled: true, schemaSha256: digest },
      nativeFetch: async () => new Response(Buffer.from(nativeHits++ === 0 ? bareJson : malformedData, "utf8"), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    });
    try {
      for (const expectedMessage of [/unsupported field/, /SSE data payload is invalid/]) {
        const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const text = await response.text();
        assert.equal(response.status, 200);
        assert.match(text, /upstream_stream_error/);
        assert.match(text, expectedMessage);
        assert.equal(text.includes(alias), false);
        assert.equal(text.includes("SECRET_ARGUMENT"), false);
      }
      assert.equal(nativeHits, 2);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("rejects encrypted or unsupported agent_message input before any Ollama upstream call", async () => {
    let ollamaHits = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      ollamaFetch: async () => {
        ollamaHits += 1;
        return new Response(JSON.stringify({ ok: "must not hit ollama" }), { status: 500 });
      },
    });
    try {
      for (const input of [
        [{ type: "agent_message", content: [{ type: "input_text", text: "ok" }, { type: "output_text", text: "bad" }] }],
        [{ type: "message", encrypted_content: "plain-looking" }],
      ]) {
        const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "ollama/deepseek-v4-flash:cloud", input }),
        });
        assert.equal(response.status, 400);
        assert.ok(["agent_message_unsupported", "encrypted_content_unsupported"].includes((await errorCode(response)) ?? ""));
      }
      assert.equal(ollamaHits, 0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("retains the provider-safe agent_message projection through continuation assembly", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-agent-message-projection-"));
    let sent: JsonObject | undefined;
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      stateDir,
      ollamaFetch: async (_url, init) => {
        sent = JSON.parse(init.body.toString("utf8")) as JsonObject;
        return new Response(
          JSON.stringify({
            id: "agent-message-projection-1",
            object: "response",
            status: "completed",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          input: [{
            type: "agent_message",
            content: [{ type: "input_text", text: "child plaintext nonce" }],
          }],
        }),
      });
      assert.equal(response.status, 200, await response.text());
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    const input = sent?.input;
    assert.ok(Array.isArray(input));
    assert.deepEqual(input[0], {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "child plaintext nonce" }],
    });
    assert.equal(JSON.stringify(input).includes("agent_message"), false);
    assert.equal(checkpointNames(stateDir).length, 1);
  });

  it("snapshots ordinary and tools Ollama outbound keys and rejects unknown fields", async () => {
    const sent: Record<string, unknown>[] = [];
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      ollamaFetch: async (_url, init) => {
        sent.push(JSON.parse(init.body.toString("utf8")) as Record<string, unknown>);
        return new Response(JSON.stringify({ ok: "ollama" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    try {
      const ordinary = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          input: "hi",
          store: false,
          metadata: { x: 1 },
        }),
      });
      assert.equal(ordinary.ok, true, await ordinary.text());

      const tools = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          input: "hi",
          tools: [{ type: "function", name: "shell" }],
          parallel_tool_calls: true,
        }),
      });
      assert.equal(tools.ok, true, await tools.text());

      const unknown = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          input: "hi",
          foo_future: true,
        }),
      });
      assert.equal(unknown.status, 400);
      assert.equal(await errorCode(unknown), "ollama_field_unsupported");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    assert.deepEqual(Object.keys(sent[0]!).sort(), ["input", "model"]);
    assert.deepEqual(Object.keys(sent[1]!).sort(), ["input", "model", "tools"]);
  });

  it("returns a 429 with one Ollama attempt and preserved Retry-After", async () => {
    let attempts = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      ollamaFetch: async () => {
        attempts += 1;
        return new Response(JSON.stringify({ error: { message: "too many concurrent requests" } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "7" },
        });
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ollama/deepseek-v4-flash:cloud", input: "hi" }),
      });
      const payload = (await response.json()) as { error?: { code?: string; retry_after?: string; message?: string } };
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("retry-after"), "7");
      assert.equal(payload.error?.code, "ollama_rate_limited");
      assert.equal(payload.error?.retry_after, "7");
      assert.match(String(payload.error?.message), /retry later|concurrency/i);
      assert.doesNotMatch(String(payload.error?.message), /cob start fixes/);
      assert.equal(attempts, 1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("omits untrusted usage instead of inventing token counts", async () => {
    const lines: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    };
    const port = await freePort();
    const stateDir = mkdtempSync(join(tmpdir(), "cob-nousage-"));
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      stateDir,
      ollamaFetch: async () =>
        new Response(
          JSON.stringify({
            id: "resp_nousage",
            object: "response",
            output: [{ type: "message", content: "secret-output" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ollama/deepseek-v4-flash:cloud", input: "secret-prompt" }),
      });
      assert.equal(response.ok, true, await response.text());
      const joined = lines.join("\n");
      assert.match(joined, /ollama usage omitted/);
      assert.equal(joined.includes("secret-prompt"), false);
      assert.equal(joined.includes("secret-output"), false);
    } finally {
      console.error = originalError;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("times out native and Ollama header waits with upstream_headers_timeout", async () => {
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      nativeHeadersMs: 40,
      ollamaHeadersMs: 200,
      nativeFetch: async (_url, init) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
      ollamaFetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return new Response(JSON.stringify({ ok: "ollama" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    try {
      const native = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "o3", input: "hi" }),
      });
      assert.equal(native.status, 504);
      assert.equal(await errorCode(native), "upstream_headers_timeout");

      const ollama = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ollama/deepseek-v4-flash:cloud", input: "hi" }),
      });
      assert.equal(ollama.ok, true, await ollama.text());
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("succeeds when headers arrive just before the route deadline", async () => {
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      nativeHeadersMs: 80,
      ollamaHeadersMs: 80,
      nativeFetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response(JSON.stringify({ ok: "native" }), { status: 200 });
      },
      ollamaFetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"ok":true}\n\n'));
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      const native = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "o3", input: "hi" }),
      });
      assert.equal(native.ok, true, await native.text());
      const ollama = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ollama/deepseek-v4-flash:cloud", input: "hi", stream: true }),
      });
      assert.equal(ollama.ok, true, await ollama.text());
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("fails a local Ollama refusal immediately instead of waiting the headers deadline", async () => {
    const closed = await freePort();
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      ollamaUrl: `http://127.0.0.1:${closed}`,
      ollamaHeadersMs: 240_000,
    });
    try {
      const started = Date.now();
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ollama/deepseek-v4-flash:cloud", input: "hi" }),
      });
      assert.ok(Date.now() - started < 2000);
      assert.notEqual(await errorCode(response), "upstream_headers_timeout");
      assert.notEqual(response.status, 504);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("ends an idle Ollama SSE without a synthetic error terminal or [DONE]", { timeout: 3_000 }, async () => {
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      idleMs: 40,
      ollamaFetch: async () => {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"delta":"one"}\n\n'));
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      const started = Date.now();
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ollama/deepseek-v4-flash:cloud", input: "hi", stream: true }),
      });
      const text = await response.text();
      assert.ok(Date.now() - started < 1500);
      assert.match(text, /"delta":"one"/);
      assert.equal(text.includes("idle_timeout"), false);
      assert.equal(text.includes("data: [DONE]"), false, text);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("cancels the upstream headers wait when the client aborts", async () => {
    let aborted = false;
    let entered!: () => void;
    const sawFetch = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      ollamaFetch: async (_url, init) => {
        entered();
        return new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
      },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: "/v1/responses",
            method: "POST",
            headers: { "content-type": "application/json" },
          },
          () => reject(new Error("should not complete")),
        );
        req.on("error", () => resolve());
        req.end(JSON.stringify({ model: "ollama/deepseek-v4-flash:cloud", input: "hi" }));
        void sawFetch.then(() => req.destroy());
      });
      const deadline = Date.now() + 500;
      while (!aborted && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(aborted, true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("does not idle-timeout a backpressured client", { timeout: 10_000 }, async () => {
    const idleMs = 80;
    let cancelled = false;
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      idleMs,
      ollamaFetch: async () => {
        const stream = new ReadableStream({
          async pull(controller) {
            controller.enqueue(new TextEncoder().encode(`data: {"ok":true}\n\n${"x".repeat(64 * 1024)}`));
            await new Promise((resolve) => setTimeout(resolve, 5));
          },
          cancel() {
            cancelled = true;
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: "/v1/responses",
            method: "POST",
            headers: { "content-type": "application/json" },
          },
          (res) => {
            res.pause();
            setTimeout(() => {
              try {
                assert.equal(cancelled, false);
                res.destroy();
                resolve();
              } catch (error) {
                reject(error);
              }
            }, idleMs * 4);
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify({ model: "ollama/deepseek-v4-flash:cloud", input: "hi", stream: true }));
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

function checkpointNames(stateDir: string): string[] {
  const dir = join(stateDir, "checkpoints");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json"));
}

function parseSsePayloads(text: string): unknown[] {
  const events: unknown[] = [];
  for (const block of text.split(/\n\n/)) {
    const line = block.split("\n").find((entry) => entry.startsWith("data:"));
    if (!line) continue;
    const payload = line.slice("data:".length).trim();
    if (payload === "[DONE]") {
      events.push("[DONE]");
      continue;
    }
    try {
      events.push(JSON.parse(payload));
    } catch {
      events.push(payload);
    }
  }
  return events;
}

describe("WP8 Ollama response integrity", () => {
  it("rejects an undeclared JSON function_call with 502 and publishes no checkpoint", async () => {
    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    const stateDir = mkdtempSync(join(tmpdir(), "cob-wp8-json-"));
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      stateDir,
      ollamaFetch: async () =>
        new Response(
          JSON.stringify({
            id: "resp_bad",
            object: "response",
            status: "completed",
            output: [{ type: "function_call", name: "apply_patch", arguments: { secret: "must-not-log" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          tools: [{ type: "function", name: "exec_command", parameters: { type: "object", properties: {} } }],
          input: "hi",
        }),
      });
      const body = (await response.json()) as { error?: { type?: string; code?: string; message?: string } };
      assert.equal(response.status, 502);
      assert.equal(body.error?.type, "upstream_error");
      assert.equal(body.error?.code, "ollama_undeclared_tool_call");
      assert.equal(String(body.error?.message).includes("apply_patch"), false);
      assert.deepEqual(checkpointNames(stateDir), []);
      const joined = logs.join("\n");
      assert.match(joined, /\[cob\] ollama guard rejected/);
      assert.equal(joined.includes("must-not-log"), false);
      assert.equal(joined.includes("apply_patch"), false);
    } finally {
      console.error = originalError;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("accepts a declared function_call, restores a promoted alias, and continues from the checkpoint", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-wp8-ok-"));
    let turn = 0;
    const sent: { tools?: { name?: string }[]; input?: unknown }[] = [];
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      stateDir,
      ollamaFetch: async (_url, init) => {
        turn += 1;
        const parsed = JSON.parse(init.body.toString("utf8")) as { tools?: { name?: string }[]; input?: unknown };
        sent.push(parsed);
        if (turn === 1) {
          return new Response(
            JSON.stringify({
              id: "resp_ok",
              object: "response",
              status: "completed",
              output: [
                {
                  type: "function_call",
                  name: "multi_agent_v1__spawn_agent",
                  call_id: "spawn-1",
                  arguments: "{}",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            id: "resp_ok2",
            object: "response",
            status: "completed",
            output: [{ type: "message", role: "assistant", content: "continued" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    try {
      const first = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          tools: [{ type: "tool_search", description: "Find tools." }],
          input: [
            { type: "message", role: "user", content: "spawn" },
            {
              type: "tool_search_call",
              call_id: "search-1",
              execution: "client",
              arguments: { query: "spawn_agent" },
            },
            {
              type: "tool_search_output",
              call_id: "search-1",
              status: "completed",
              execution: "client",
              tools: [
                {
                  type: "namespace",
                  name: "multi_agent_v1",
                  tools: [
                    {
                      type: "function",
                      name: "spawn_agent",
                      description: "Spawn a sub-agent.",
                      parameters: { type: "object", properties: { task: { type: "string" } } },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      });
      assert.equal(first.status, 200, await first.clone().text());
      const firstBody = (await first.json()) as { output?: { name?: string; namespace?: string }[] };
      assert.equal(firstBody.output?.[0]?.name, "spawn_agent");
      assert.equal(firstBody.output?.[0]?.namespace, "multi_agent_v1");
      assert.equal(checkpointNames(stateDir).length, 1);

      const second = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          previous_response_id: "resp_ok",
          input: [{ type: "function_call_output", call_id: "spawn-1", output: "ok" }],
        }),
      });
      assert.equal(second.status, 200, await second.text());
      assert.equal(turn, 2);
      assert.equal(sent[0]?.tools?.some((tool) => tool.name === "multi_agent_v1__spawn_agent"), true);
      assert.equal(checkpointNames(stateDir).length, 2);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("replays a raw apply_patch alias checkpoint and pairs the next custom output", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-g5-continuation-"));
    const patchInput = "*** Begin Patch\n*** End Patch\n";
    const patchTool = {
      type: "custom",
      name: APPLY_PATCH_TOOL_NAME,
      format: { type: "grammar", syntax: "lark", definition: "start: /[^\\n]*/" },
    };
    const sent: JsonObject[] = [];
    let turn = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      stateDir,
      applyPatch: true,
      ollamaFetch: async (_url, init) => {
        turn += 1;
        sent.push(JSON.parse(init.body.toString("utf8")) as JsonObject);
        if (turn === 1) {
          return new Response(
            JSON.stringify({
              id: "resp_patch",
              object: "response",
              status: "completed",
              output: [{
                type: "function_call",
                id: "patch_item",
                call_id: "patch_call",
                name: COB_APPLY_PATCH_ALIAS,
                arguments: JSON.stringify({ input: patchInput }),
              }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            id: "resp_patch_2",
            object: "response",
            status: "completed",
            output: [{ type: "message", role: "assistant", content: "continued" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    try {
      const first = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          tools: [patchTool],
          input: "patch this",
        }),
      });
      assert.equal(first.status, 200, await first.clone().text());
      const firstBody = (await first.json()) as JsonObject;
      assert.equal((firstBody.output as JsonObject[])[0]?.type, "custom_tool_call");
      assert.equal(checkpointNames(stateDir).length, 1);

      const second = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          previous_response_id: "resp_patch",
          tools: [patchTool],
          input: [{
            type: "custom_tool_call_output",
            call_id: "patch_call",
            output: "Applied",
          }],
        }),
      });
      assert.equal(second.status, 200, await second.text());
      assert.equal(turn, 2);
      const replay = (sent[1]?.input as JsonObject[]) ?? [];
      const replayCall = replay.find((item) => item.type === "function_call" && item.name === COB_APPLY_PATCH_ALIAS);
      const replayOutput = replay.find((item) => item.type === "function_call_output" && item.call_id === "patch_call");
      assert.equal(replayCall?.name, COB_APPLY_PATCH_ALIAS);
      assert.equal(replayOutput?.output, "Applied");
      assert.equal(replay.filter((item) => item.type === "custom_tool_call" || item.type === "custom_tool_call_output").length, 0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("rejects conflicting apply_patch JSON identities without a checkpoint or raw relay", async () => {
    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    const patchInput = "*** Begin Patch\nSECRET_HEREDOC\n*** End Patch\n";
    const args = JSON.stringify({ input: patchInput });
    const patchTool = {
      type: "custom",
      name: APPLY_PATCH_TOOL_NAME,
      format: { type: "grammar", syntax: "lark", definition: "start: /[^\\n]*/" },
    };
    const stateDir = mkdtempSync(join(tmpdir(), "cob-g5-conflict-"));
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      stateDir,
      applyPatch: true,
      ollamaFetch: async () =>
        new Response(
          JSON.stringify({
            id: "resp_conflict",
            object: "response",
            status: "completed",
            output: [
              { type: "function_call", id: "item_a", call_id: "shared", name: COB_APPLY_PATCH_ALIAS, arguments: args },
              { type: "function_call", id: "item_b", call_id: "shared", name: COB_APPLY_PATCH_ALIAS, arguments: args },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          tools: [patchTool],
          input: "patch this",
        }),
      });
      const text = await response.text();
      const body = JSON.parse(text) as { error?: { type?: string; code?: string; message?: string } };
      assert.equal(response.status, 502);
      assert.equal(body.error?.type, "upstream_error");
      assert.equal(body.error?.code, "ollama_tool_call_invalid");
      assert.equal(text.includes(COB_APPLY_PATCH_ALIAS), false);
      assert.equal(text.includes("SECRET_HEREDOC"), false);
      assert.equal(text.includes("shared"), false);
      assert.deepEqual(checkpointNames(stateDir), []);
      const joined = logs.join("\n");
      assert.match(joined, /\[cob\] ollama guard rejected/);
      assert.equal(joined.includes("SECRET_HEREDOC"), false);
      assert.equal(joined.includes(COB_APPLY_PATCH_ALIAS), false);
    } finally {
      console.error = originalError;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("rejects an undeclared SSE function_call with one failed terminal and no checkpoint", async () => {
    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    const stateDir = mkdtempSync(join(tmpdir(), "cob-wp8-sse-"));
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      stateDir,
      ollamaFetch: async () => {
        const sse = [
          'data: {"type":"response.created","response":{"id":"resp_sse"}}',
          'data: {"type":"response.output_item.added","item":{"type":"function_call","name":"apply_patch","arguments":"{}"}}',
          'data: {"type":"response.function_call_arguments.delta","delta":"secret-args"}',
          'data: {"type":"response.completed","response":{"id":"resp_sse","object":"response","status":"completed","output":[]}}',
          "data: [DONE]",
        ].join("\n\n");
        return new Response(`${sse}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          stream: true,
          tools: [{ type: "function", name: "exec_command", parameters: { type: "object", properties: {} } }],
          input: "hi",
        }),
      });
      const text = await response.text();
      const events = parseSsePayloads(text);
      const failed = events.find(
        (event) => event && typeof event === "object" && (event as { type?: string }).type === "response.failed",
      ) as { response?: { error?: { message?: string; code?: string } } } | undefined;
      assert.equal(response.headers.get("content-type")?.includes("text/event-stream"), true);
      assert.equal(failed?.response?.error?.code, "ollama_undeclared_tool_call");
      assert.equal(String(failed?.response?.error?.message).includes("apply_patch"), false);
      assert.equal(events.filter((event) => event === "[DONE]").length, 1);
      assert.equal(
        events.some((event) => event && typeof event === "object" && (event as { type?: string }).type === "response.completed"),
        false,
      );
      assert.equal(text.includes("response.output_item.added"), false);
      assert.equal(text.includes("secret-args"), false);
      assert.deepEqual(checkpointNames(stateDir), []);
      const joined = logs.join("\n");
      assert.match(joined, /\[cob\] ollama guard rejected/);
      assert.equal(joined.includes("apply_patch"), false);
      assert.equal(joined.includes("secret-args"), false);
    } finally {
      console.error = originalError;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("does not change a parent checkpoint when a later undeclared JSON turn is refused", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-wp8-parent-"));
    let turn = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: TEST_CATALOG,
      stateDir,
      ollamaFetch: async () => {
        turn += 1;
        if (turn === 1) {
          return new Response(
            JSON.stringify({
              id: "resp_parent",
              object: "response",
              status: "completed",
              output: [{ type: "message", role: "assistant", content: "ok" }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            id: "resp_child",
            object: "response",
            status: "completed",
            output: [{ type: "function_call", name: "apply_patch", arguments: "{}" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    try {
      const first = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ollama/deepseek-v4-flash:cloud", input: "one" }),
      });
      assert.equal(first.status, 200);
      const before = checkpointNames(stateDir);
      assert.equal(before.length, 1);
      const second = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          previous_response_id: "resp_parent",
          tools: [{ type: "function", name: "exec_command", parameters: { type: "object", properties: {} } }],
          input: "two",
        }),
      });
      assert.equal(second.status, 502);
      assert.equal(await errorCode(second), "ollama_undeclared_tool_call");
      assert.deepEqual(checkpointNames(stateDir), before);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
