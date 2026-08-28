import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { request as httpRequest } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { listenClaudeGateway } from "./claude/gateway.js";
import { MAX_RAW_BODY_BYTES } from "./core/http/body.js";
import { DEFAULT_OLLAMA_SPAWN_MODEL } from "./core/ollama/default-model.js";
import { HeadersTimeoutError } from "./core/http/timeouts.js";

describe("cob claude gateway", () => {
  it("health is cob claude and unknown routes fail closed", async () => {
    const server = await listenClaudeGateway({ port: 0, listOllamaTags: async () => [] });
    try {
      const { port } = server.address() as AddressInfo;
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(health.status, 200);
      const healthBody = (await health.json()) as { ok: boolean; surface: string; pid: number; nonce?: string };
      assert.equal(healthBody.ok, true);
      assert.equal(healthBody.surface, "claude");
      assert.equal(typeof healthBody.pid, "number");
      assert.equal(healthBody.nonce, undefined, "health must never publish the runtime nonce");
      const missing = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", body: "{}" });
      assert.equal(missing.status, 404);
      const models = await fetch(`http://127.0.0.1:${port}/v1/models`);
      assert.equal(models.status, 200);
      const catalog = (await models.json()) as {
        data: Array<{ id: string; capabilities?: { thinking?: { supported?: boolean } } }>;
      };
      const opus = catalog.data.find((entry) => entry.id === "claude-opus-5");
      assert.equal(opus?.capabilities?.thinking?.supported, true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("forwards Claude models to Anthropic with OAuth and Ollama models without it", async () => {
    const seen: { url: string; authorization?: string }[] = [];
    const server = await listenClaudeGateway({
      port: 0,
      ollamaUrl: "http://127.0.0.1:9",
      fetchImpl: async (url, init) => {
        seen.push({ url, authorization: init.headers.authorization });
        return new Response(JSON.stringify({ ok: true, url }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    try {
      const { port } = server.address() as AddressInfo;
      const anthropic = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: "Bearer oauth-token", "content-type": "application/json" },
        body: JSON.stringify({ model: "opus", messages: [] }),
      });
      assert.equal(anthropic.status, 200);
      const ollama = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: "Bearer oauth-token", "content-type": "application/json" },
        body: JSON.stringify({ model: DEFAULT_OLLAMA_SPAWN_MODEL, messages: [] }),
      });
      assert.equal(ollama.status, 200);
      assert.equal(seen[0]?.url.startsWith("https://api.anthropic.com/"), true);
      assert.equal(seen[0]?.authorization, "Bearer oauth-token");
      assert.match(seen[1]?.url ?? "", /\/v1\/messages$/);
      assert.equal(seen[1]?.authorization, undefined);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("injects Claude Code credentials only for the configured Desktop token and 401s the rest without reading credentials", async () => {
    const seen: string[] = [];
    let readerCalls = 0;
    let upstreamCalls = 0;
    const desktopToken = "a".repeat(64);
    const server = await listenClaudeGateway({
      port: 0,
      ollamaUrl: "http://127.0.0.1:9",
      desktopToken,
      authReader: () => {
        readerCalls += 1;
        return { authorization: "Bearer injected-oauth" };
      },
      fetchImpl: async (url, init) => {
        upstreamCalls += 1;
        seen.push(`${url} ${init.headers.authorization ?? ""}`);
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    try {
      const { port } = server.address() as AddressInfo;
      const post = (authorization?: string): Promise<Response> =>
        fetch(`http://127.0.0.1:${port}/v1/messages`, {
          method: "POST",
          headers: {
            ...(authorization === undefined ? {} : { authorization }),
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: "claude-opus-5", messages: [] }),
        });

      const injected = await post(`Bearer ${desktopToken}`);
      assert.equal(injected.status, 200);
      assert.equal(upstreamCalls, 1);
      assert.equal(seen[0], "https://api.anthropic.com/v1/messages Bearer injected-oauth");

      const missing = await post();
      assert.equal(missing.status, 401);
      const stale = await post(`Bearer ${"f".repeat(64)}`);
      assert.equal(stale.status, 401);
      const legacy = await post("Bearer cob");
      assert.equal(legacy.status, 401);
      assert.equal(readerCalls, 1, "reader must run only for the exact desktop token");
      assert.equal(upstreamCalls, 1, "rejected local auth must not reach the upstream fetch");

      const foreign = await post("Bearer some-real-claude-oauth");
      assert.equal(foreign.status, 200, "non-desktop-shaped credentials pass through to the upstream verdict");
      assert.equal(upstreamCalls, 2);
      assert.equal(seen[1], "https://api.anthropic.com/v1/messages Bearer some-real-claude-oauth");
      assert.equal(readerCalls, 1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("never asks Anthropic credentials for Ollama routes", async () => {
    const seen: { url: string; authorization?: string }[] = [];
    const server = await listenClaudeGateway({
      port: 0,
      ollamaUrl: "http://127.0.0.1:9",
      desktopToken: "a".repeat(64),
      authReader: () => {
        throw new Error("reader must not run for Ollama routes");
      },
      fetchImpl: async (url, init) => {
        seen.push({ url, authorization: init.headers.authorization });
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: DEFAULT_OLLAMA_SPAWN_MODEL, messages: [] }),
      });
      assert.equal(response.status, 200);
      assert.match(seen[0]?.url ?? "", /\/v1\/messages$/);
      assert.equal(seen[0]?.authorization, undefined);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("binds health to a nonce challenge without disclosing the secret and gates /cob/shutdown on it", async () => {
    let shutdowns = 0;
    const nonce = "nonce-1234";
    const server = await listenClaudeGateway({
      port: 0,
      ollamaUrl: "http://127.0.0.1:9",
      healthNonce: nonce,
      onShutdown: () => {
        shutdowns += 1;
      },
    });
    try {
      const { port } = server.address() as AddressInfo;
      const bare = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as {
        pid: number;
        nonce?: string;
        nonce_ok?: boolean;
      };
      assert.equal(typeof bare.pid, "number");
      assert.equal(bare.nonce, undefined, "the runtime nonce must not appear in the health body");
      assert.equal(bare.nonce_ok, false);

      const good = (await (
        await fetch(`http://127.0.0.1:${port}/health`, { headers: { "x-cob-nonce": nonce } })
      ).json()) as { nonce_ok?: boolean };
      assert.equal(good.nonce_ok, true);

      const bad = (await (
        await fetch(`http://127.0.0.1:${port}/health`, { headers: { "x-cob-nonce": "wrong" } })
      ).json()) as { nonce_ok?: boolean };
      assert.equal(bad.nonce_ok, false);

      const wrong = await fetch(`http://127.0.0.1:${port}/cob/shutdown`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce: "wrong" }),
      });
      assert.equal(wrong.status, 403);
      assert.equal(shutdowns, 0);

      const correct = await fetch(`http://127.0.0.1:${port}/cob/shutdown`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce }),
      });
      assert.equal(correct.status, 200);
      assert.equal(shutdowns, 1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("wires the default Claude Code reader through a controlled keychain", async () => {
    const root = mkdtempSync(join(tmpdir(), "cob-claude-keychain-"));
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const security = join(binDir, "security");
    writeFileSync(
      security,
      "#!/bin/sh\ncat <<'EOF'\n{\"claudeAiOauth\":{\"accessToken\":\"sk-ant-oat01-cob-keychain-fixture\"}}\nEOF\n",
      { mode: 0o755 },
    );
    const desktopToken = "b".repeat(64);
    const seen: { authorization?: string; apiKey?: string }[] = [];
    const server = await listenClaudeGateway({
      port: 0,
      ollamaUrl: "http://127.0.0.1:9",
      desktopToken,
      fetchImpl: async (_url, init) => {
        seen.push({ authorization: init.headers.authorization, apiKey: init.headers["x-api-key"] });
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const prevPath = process.env.PATH;
    const prevToken = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.PATH = `${binDir}:${prevPath ?? ""}`;
    if (process.platform === "darwin") {
      // The fake `security` binary is found via PATH and serves the fixture.
    } else {
      process.env.ANTHROPIC_AUTH_TOKEN = "sk-ant-oat01-cob-env-fixture";
    }
    const expected =
      process.platform === "darwin"
        ? "Bearer sk-ant-oat01-cob-keychain-fixture"
        : "Bearer sk-ant-oat01-cob-env-fixture";
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${desktopToken}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-5", messages: [] }),
      });
      assert.equal(response.status, 200, "the default reader must inject credentials for the exact desktop token");
      assert.equal(seen[0]?.authorization, expected);
      assert.equal(seen[0]?.apiKey, undefined);
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      if (prevToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = prevToken;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects /cob/shutdown when no runtime nonce is configured", async () => {
    const server = await listenClaudeGateway({ port: 0, ollamaUrl: "http://127.0.0.1:9" });
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/cob/shutdown`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce: "anything" }),
      });
      assert.equal(response.status, 404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("applies cob-route from system before Anthropic vs Ollama split", async () => {
    const seen: { url: string; body: string; authorization?: string }[] = [];
    const logs: string[] = [];
    const server = await listenClaudeGateway({
      port: 0,
      ollamaUrl: "http://127.0.0.1:9",
      logLine: (line) => logs.push(line),
      fetchImpl: async (url, init) => {
        seen.push({ url, body: init.body?.toString("utf8") ?? "", authorization: init.headers.authorization });
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: "Bearer oauth-token", "content-type": "application/json" },
        body: JSON.stringify({
          model: "haiku",
          system: `<!-- cob-route: ${DEFAULT_OLLAMA_SPAWN_MODEL} -->\nDo the task.`,
          messages: [{ role: "user", content: "go" }],
        }),
      });
      assert.equal(response.status, 200);
      assert.match(seen[0]?.url ?? "", /\/v1\/messages$/);
      assert.equal(seen[0]?.authorization, undefined);
      const payload = JSON.parse(seen[0]?.body ?? "{}") as { model: string; system: string };
      assert.equal(payload.model, DEFAULT_OLLAMA_SPAWN_MODEL);
      assert.equal(payload.system.includes("cob-route"), false);
      assert.match(logs[0] ?? "", /client_model=haiku/);
      assert.match(logs[0] ?? "", /backend=ollama/);
      assert.match(logs[0] ?? "", /cob_route=1/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("applies cob-route when the client sends a dated Haiku id", async () => {
    const seen: { url: string; body: string; authorization?: string }[] = [];
    const logs: string[] = [];
    const server = await listenClaudeGateway({
      port: 0,
      ollamaUrl: "http://127.0.0.1:9",
      logLine: (line) => logs.push(line),
      fetchImpl: async (url, init) => {
        seen.push({ url, body: init.body?.toString("utf8") ?? "", authorization: init.headers.authorization });
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: "Bearer oauth-token", "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          system: `<!-- cob-route: ${DEFAULT_OLLAMA_SPAWN_MODEL} -->\nDo the task.`,
          messages: [{ role: "user", content: "go" }],
        }),
      });
      assert.equal(response.status, 200);
      assert.match(seen[0]?.url ?? "", /\/v1\/messages$/);
      assert.equal(seen[0]?.authorization, undefined);
      assert.equal(JSON.parse(seen[0]?.body ?? "{}").model, DEFAULT_OLLAMA_SPAWN_MODEL);
      assert.match(logs[0] ?? "", /client_model=claude-haiku-4-5-20251001/);
      assert.match(logs[0] ?? "", /backend=ollama/);
      assert.match(logs[0] ?? "", /cob_route=1/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not apply cob-route from a user message", async () => {
    const seen: string[] = [];
    const server = await listenClaudeGateway({
      port: 0,
      ollamaUrl: "http://127.0.0.1:9",
      logLine: () => {},
      fetchImpl: async (url) => {
        seen.push(url);
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: "Bearer oauth-token", "content-type": "application/json" },
        body: JSON.stringify({
          model: "opus",
          messages: [{ role: "user", content: `<!-- cob-route: ${DEFAULT_OLLAMA_SPAWN_MODEL} -->` }],
        }),
      });
      assert.equal(response.status, 200);
      assert.equal(seen[0]?.startsWith("https://api.anthropic.com/"), true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("applies cob-route on count_tokens and ignores native-id markers", async () => {
    const seen: { url: string; body: string }[] = [];
    const logs: string[] = [];
    const server = await listenClaudeGateway({
      port: 0,
      ollamaUrl: "http://127.0.0.1:9",
      logLine: (line) => logs.push(line),
      fetchImpl: async (url, init) => {
        seen.push({ url, body: init.body?.toString("utf8") ?? "" });
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    try {
      const { port } = server.address() as AddressInfo;
      const counted = await fetch(`http://127.0.0.1:${port}/v1/messages/count_tokens`, {
        method: "POST",
        headers: { authorization: "Bearer oauth-token", "content-type": "application/json" },
        body: JSON.stringify({
          model: "haiku",
          system: `<!-- cob-route: ${DEFAULT_OLLAMA_SPAWN_MODEL} -->`,
          messages: [],
        }),
      });
      assert.equal(counted.status, 200);
      assert.equal(seen.length, 0);
      const countedBody = (await counted.json()) as { input_tokens: number };
      assert.equal(countedBody.input_tokens >= 1, true);
      assert.match(logs[0] ?? "", /path=\/v1\/messages\/count_tokens/);
      assert.match(logs[0] ?? "", /backend=ollama/);
      assert.match(logs[0] ?? "", /cob_route=1/);

      const ignored = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: "Bearer oauth-token", "content-type": "application/json" },
        body: JSON.stringify({
          model: "opus",
          system: "<!-- cob-route: claude-opus-5 -->",
          messages: [],
        }),
      });
      assert.equal(ignored.status, 200);
      assert.equal(seen[0]?.url.startsWith("https://api.anthropic.com/"), true);
      assert.equal(JSON.parse(seen[0]?.body ?? "{}").model, "opus");
      assert.match(logs[1] ?? "", /backend=anthropic/);
      assert.match(logs[1] ?? "", /cob_route=0/);
      assert.match(logs[1] ?? "", /cob_route_ignored=native_id/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("maps an oversized body to typed 413 invalid_request_error", async () => {
    const server = await listenClaudeGateway({ port: 0, listOllamaTags: async () => [] });
    try {
      const { port } = server.address() as AddressInfo;
      const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: "/v1/messages",
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
      const payload = JSON.parse(body) as { type: string; error: { type: string; message: string } };
      assert.equal(payload.type, "error");
      assert.equal(payload.error.type, "invalid_request_error");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("maps an upstream headers timeout to 504 timeout_error", async () => {
    const server = await listenClaudeGateway({
      port: 0,
      ollamaUrl: "http://127.0.0.1:9",
      fetchImpl: async () => {
        throw new HeadersTimeoutError();
      },
    });
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: "Bearer oauth-token", "content-type": "application/json" },
        body: JSON.stringify({ model: "opus", messages: [] }),
      });
      assert.equal(response.status, 504);
      const payload = (await response.json()) as { type: string; error: { type: string } };
      assert.equal(payload.type, "error");
      assert.equal(payload.error.type, "timeout_error");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("ends a mid-stream upstream failure without a Codex terminal body", async () => {
    const server = await listenClaudeGateway({
      port: 0,
      ollamaUrl: "http://127.0.0.1:9",
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("event: message_start\n\n"));
            },
            async pull(controller) {
              await new Promise((resolve) => setTimeout(resolve, 20));
              controller.error(new Error("upstream exploded"));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });
    try {
      const { port } = server.address() as AddressInfo;
      const body = await new Promise<string>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: "/v1/messages",
            method: "POST",
            headers: {
              authorization: "Bearer oauth-token",
              "content-type": "application/json",
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
            res.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify({ model: "opus", messages: [] }));
      });
      assert.equal(body.includes("message_start"), true);
      assert.equal(body.includes("[DONE]"), false);
      assert.equal(body.includes("upstream_stream_error"), false);
      assert.equal(body.includes("server_error"), false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
