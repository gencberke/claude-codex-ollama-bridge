import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { zstdCompressSync } from "node:zlib";
import { listenGateway } from "./gateway.js";
import { pickForwardHeaders } from "./native.js";
import { NATIVE_RESPONSES_URL } from "./constants.js";
import { MAX_RAW_BODY_BYTES } from "./limits.js";
import { assertValidOllamaFollowUpInput, ollamaCompactHandoffSkeleton, ollamaFollowUpInputError } from "./compaction.js";
import { normalizeOllamaResponse, prepareOllamaPayload, rejectOllamaRequest, sanitizeOllamaPayload } from "./ollama.js";
import type { CatalogFile } from "./types.js";

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
      assert.match(joined, /tool_bytes=exec_command:/);
      assert.match(joined, /\[cob\] ollama usage in=12 out=3/);
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
      assert.match(joined, /multi_agent_v1__spawn_agent:/);
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

  it("strips plaintext encrypted_content instead of failing closed", () => {
    const prepared = prepareOllamaPayload({
      model: "ollama/deepseek-v4-flash:cloud",
      input: [{ type: "reasoning", encrypted_content: "1. The user asks to reply with pong." }],
    });
    assert.equal("status" in prepared && "body" in prepared, false);
    assert.equal(JSON.stringify(prepared).includes("encrypted_content"), false);
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
      assert.equal(failLine, "[cob] ollama compact failed code=compaction_summary_invalid");
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
      assert.match(logs.join("\n"), /ollama compact failed code=compaction_summary_incomplete/);
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
      assert.equal(response.status, 200, await response.text());
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

  it("idles between SSE chunks and still emits one error terminal plus [DONE]", { timeout: 3_000 }, async () => {
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
      assert.match(text, /idle_timeout|Upstream idle timeout/);
      assert.match(text, /data: \[DONE\]/);
      assert.ok(text.indexOf("idle_timeout") < text.indexOf("data: [DONE]") || text.includes("data: [DONE]"));
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
