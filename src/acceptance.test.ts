import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_SPAWNABLE_OLLAMA_SLUGS } from "./codex/config/schema.js";
import { writeCobToml } from "./codex/config/toml.js";
import { loadBundledCatalog, mergeCatalog, serializeCatalog } from "./codex/catalog.js";
import { loadOllamaTags } from "./core/ollama/tags.js";
import { NATIVE_RESPONSES_URL } from "./codex/constants.js";
import { DEFAULT_OLLAMA_URL } from "./core/ollama/constants.js";
import { listenGateway } from "./codex/gateway.js";
import { isForbiddenOllamaHeader } from "./codex/ollama.js";
import { assertValidOllamaFollowUpInput, ollamaCompactHandoffSkeleton } from "./codex/compaction.js";
import { writeCobProfile } from "./codex/profile.js";
import { resolvePaths } from "./codex/paths.js";
import { ollamaUpstreamModel } from "./codex/route.js";
import type { CatalogFile } from "./codex/types.js";
import type { JsonObject } from "./core/json.js";
import { isRecord } from "./core/json.js";

const CATALOG: CatalogFile = {
  models: [
    { slug: "gpt-5.6-luna" },
    { slug: "codex-mini" },
    { slug: "ollama/deepseek-v4-flash:cloud" },
  ],
};

describe("acceptance matrix (mock)", () => {
  it("sends a native GPT turn only to native", async () => {
    let nativeHits = 0;
    let ollamaHits = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: CATALOG,
      nativeFetch: async () => {
        nativeHits += 1;
        return new Response(JSON.stringify({ ok: "native" }), { status: 200 });
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
        body: JSON.stringify({ model: "gpt-5.6-luna", input: "hi" }),
      });
      assert.equal(response.ok, true);
      assert.equal(nativeHits, 1);
      assert.equal(ollamaHits, 0);
    } finally {
      await closeServer(server);
    }
  });

  it("passes a native v2 compaction trigger through unchanged", async () => {
    const requestBody = JSON.stringify({
      model: "gpt-5.6-luna",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "old" }] }, { type: "compaction_trigger" }],
      stream: false,
    });
    let seenUrl: string | undefined;
    let seenBody: Buffer | undefined;
    let ollamaHits = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: CATALOG,
      nativeFetch: async (url, init) => {
        seenUrl = url;
        seenBody = init.body;
        return new Response(JSON.stringify({ ok: "native" }), { status: 200 });
      },
      ollamaFetch: async () => {
        ollamaHits += 1;
        return new Response("must not hit Ollama", { status: 500 });
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
      });
      assert.equal(response.status, 200);
      assert.equal(seenUrl, NATIVE_RESPONSES_URL);
      assert.equal(seenBody?.toString("utf8"), requestBody);
      assert.equal(ollamaHits, 0);
    } finally {
      await closeServer(server);
    }
  });

  it("sends an Ollama turn only to Ollama", async () => {
    let nativeHits = 0;
    let ollamaHits = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: CATALOG,
      nativeFetch: async () => {
        nativeHits += 1;
        return new Response("nope", { status: 500 });
      },
      ollamaFetch: async () => {
        ollamaHits += 1;
        return new Response(JSON.stringify({ ok: "ollama" }), { status: 200 });
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer secret" },
        body: JSON.stringify({ model: "ollama/deepseek-v4-flash:cloud", input: "hi" }),
      });
      assert.equal(response.ok, true);
      assert.equal(nativeHits, 0);
      assert.equal(ollamaHits, 1);
    } finally {
      await closeServer(server);
    }
  });

  it("sends an Ollama v2 compaction trigger to the Ollama summarizer and continues on the handoff", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-acceptance-v2-"));
    let nativeHits = 0;
    let ollamaHits = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      stateDir,
      catalog: CATALOG,
      nativeFetch: async () => {
        nativeHits += 1;
        return new Response("native must not compact Ollama threads", { status: 500 });
      },
      ollamaFetch: async (_url, init) => {
        ollamaHits += 1;
        const parsed: unknown = JSON.parse(init.body.toString("utf8"));
        assertValidOllamaFollowUpInput(isRecord(parsed) ? parsed.input : parsed);
        assert.equal(JSON.stringify(parsed).includes("encrypted_content"), false);
        assert.equal(JSON.stringify(parsed).includes("compaction_trigger"), false);
        assert.equal(JSON.stringify(parsed).includes("output_text"), false);
        if (ollamaHits === 1) {
          assert.match(JSON.stringify(parsed), /long task/);
          return new Response(
            JSON.stringify({
              id: "ollama-sum-1",
              object: "response",
              status: "completed",
              output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: ollamaCompactHandoffSkeleton({ Goal: "handoff summary" }) }] }],
            }),
            { status: 200 },
          );
        }
        assert.equal(JSON.stringify(parsed).includes("long task"), false);
        assert.match(JSON.stringify(parsed), /handoff summary/);
        assert.match(JSON.stringify(parsed), /continue/);
        return new Response(
          JSON.stringify({
            id: "ollama-follow-1",
            object: "response",
            status: "completed",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
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
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "long task" }] }, { type: "compaction_trigger" }],
        }),
      });
      assert.equal(compact.ok, true, await compact.clone().text());
      assert.equal(nativeHits, 0);
      assert.equal(ollamaHits, 1);
      const body: unknown = await compact.json();
      assert.equal(JSON.stringify(body).includes("cob1.1."), true);
      assert.equal(JSON.stringify(body).includes("gAAAAA"), false);

      const follow = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          input: [
            (body as { output?: unknown[] }).output?.[0],
            { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
          ],
        }),
      });
      assert.equal(follow.ok, true, await follow.text());
      assert.equal(ollamaHits, 2);
      assert.equal(nativeHits, 0);
    } finally {
      await closeServer(server);
    }
  });

  it("routes a Codex-shaped V1 Ollama child spawn without ChatGPT headers", async () => {
    let nativeHits = 0;
    let nativeCompact = 0;
    const ollamaRequests: { headers: Record<string, string>; body: JsonObject }[] = [];
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: CATALOG,
      compaction: { provider: "native", model: "codex-mini" },
      nativeFetch: async (_url) => {
        nativeHits += 1;
        return new Response("native should not receive the Ollama child", { status: 500 });
      },
      ollamaFetch: async (_url, init) => {
        const parsed: unknown = JSON.parse(init.body.toString("utf8"));
        ollamaRequests.push({
          headers: { ...init.headers },
          body: isRecord(parsed) ? parsed : {},
        });
        const input = isRecord(parsed) && Array.isArray(parsed.input) ? parsed.input : [];
        const continuation = input.some((item) => isRecord(item) && item.type === "function_call_output");
        if (continuation) {
          return new Response(
            JSON.stringify({
              object: "response",
              model: "deepseek-v4-flash:cloud",
              output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            object: "response",
            model: "deepseek-v4-flash:cloud",
            output: [
              {
                type: "function_call",
                name: "shell",
                call_id: "call_1",
                arguments: { command: "echo hi", model: "keep-me" },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    try {
      const childHeaders = {
        "content-type": "application/json",
        authorization: "Bearer secret-chatgpt",
        "chatgpt-account-id": "acct",
        session_id: "sess",
        "x-openai-subagent": "true",
        originator: "codex_cli_rs",
      };
      const first = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: childHeaders,
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "run echo hi" }] }],
          tools: [
            {
              type: "function",
              name: "shell",
              parameters: { type: "object", properties: { command: { type: "string" } } },
            },
          ],
        }),
      });
      assert.equal(first.status, 200);
      assert.equal(nativeHits, 0);
      assert.equal(ollamaRequests.length, 1);
      assertNoChatgptHeaders(ollamaRequests[0]!.headers);
      assert.equal(ollamaRequests[0]!.body.model, "deepseek-v4-flash:cloud");
      assert.equal(Array.isArray(ollamaRequests[0]!.body.tools), true);
      const firstJson = (await first.json()) as {
        output: { arguments?: { model?: string } }[];
      };
      assert.equal(firstJson.output[0]?.arguments?.model, "keep-me");

      const follow = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: childHeaders,
        body: JSON.stringify({
          model: "ollama/deepseek-v4-flash:cloud",
          input: [
            {
              type: "function_call",
              name: "shell",
              call_id: "call_1",
              arguments: { command: "echo hi", model: "keep-me" },
            },
            { type: "function_call_output", call_id: "call_1", output: "hi" },
          ],
        }),
      });
      assert.equal(follow.status, 200);
      assert.equal(nativeHits, 0);
      assert.equal(ollamaRequests.length, 2);
      assertNoChatgptHeaders(ollamaRequests[1]!.headers);

      const compact = await fetch(`http://127.0.0.1:${port}/v1/responses/compact`, {
        method: "POST",
        headers: childHeaders,
        body: JSON.stringify({ model: "ollama/deepseek-v4-flash:cloud", input: [] }),
      });
      assert.equal(compact.status, 400);
      assert.equal(nativeCompact, 0);
      assert.equal(ollamaRequests.length, 2);
      assert.equal((await compact.json() as { error?: { code?: string } }).error?.code, "legacy_compaction_unavailable");
    } finally {
      await closeServer(server);
    }
  });

  it("does not retry a 429 and keeps Retry-After on the Ollama route", async () => {
    let attempts = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: CATALOG,
      ollamaFetch: async () => {
        attempts += 1;
        return new Response("quota exceeded", {
          status: 429,
          headers: { "retry-after": "3" },
        });
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ollama/deepseek-v4-flash:cloud", input: "hi" }),
      });
      const payload = (await response.json()) as { error?: { code?: string; retry_after?: string } };
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("retry-after"), "3");
      assert.equal(payload.error?.code, "ollama_quota_exhausted");
      assert.equal(payload.error?.retry_after, "3");
      assert.equal(attempts, 1);
    } finally {
      await closeServer(server);
    }
  });

  it("rejects an undeclared Ollama function_call before Codex sees a completed turn", async () => {
    let ollamaHits = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: CATALOG,
      ollamaFetch: async () => {
        ollamaHits += 1;
        return new Response(
          JSON.stringify({
            id: "resp_undeclared",
            object: "response",
            status: "completed",
            output: [{ type: "function_call", name: "apply_patch", arguments: "{}" }],
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
          tools: [{ type: "function", name: "shell", parameters: { type: "object", properties: {} } }],
          input: "hi",
        }),
      });
      const payload = (await response.json()) as { error?: { type?: string; code?: string } };
      assert.equal(response.status, 502);
      assert.equal(payload.error?.type, "upstream_error");
      assert.equal(payload.error?.code, "ollama_undeclared_tool_call");
      assert.equal(ollamaHits, 1);
    } finally {
      await closeServer(server);
    }
  });
});

describe("acceptance matrix (live Codex)", () => {
  it(
    "drives a GPT parent that spawns an Ollama V1 child through cob",
    {
      skip: process.env.COB_LIVE_SUBAGENT ? false : "set COB_LIVE_SUBAGENT=1 to run the live Codex spawn harness",
      timeout: 180_000,
    },
    async () => {
      await runLiveGptParentOllamaChild();
    },
  );
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      server.close((error) => (error ? reject(error) : resolve(addr.port)));
    });
    server.on("error", reject);
  });
}

function closeServer(server: { close: (cb: (error?: Error) => void) => void }): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function assertNoChatgptHeaders(headers: Record<string, string>): void {
  for (const name of Object.keys(headers)) {
    assert.equal(isForbiddenOllamaHeader(name), false, name);
  }
}

async function runLiveGptParentOllamaChild(): Promise<void> {
  const codex = spawnSync("codex", ["--version"], { encoding: "utf8" });
  if (codex.status !== 0) {
    throw new Error("COB_LIVE_SUBAGENT requires the codex CLI on PATH");
  }
  const realHome = join(homedir(), ".codex");
  const authPath = join(realHome, "auth.json");
  if (!existsSync(authPath)) {
    throw new Error("COB_LIVE_SUBAGENT requires ~/.codex/auth.json (run `codex login`)");
  }

  const ollamaUrl = (process.env.COB_OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(/\/$/, "");
  let tags: Awaited<ReturnType<typeof loadOllamaTags>>;
  try {
    tags = await loadOllamaTags(ollamaUrl);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`COB_LIVE_SUBAGENT could not reach Ollama at ${ollamaUrl}: ${detail}`);
  }
  if (tags.length === 0) {
    throw new Error(`COB_LIVE_SUBAGENT found no Ollama models at ${ollamaUrl}`);
  }

  const requested = process.env.COB_LIVE_SUBAGENT_MODEL ?? DEFAULT_SPAWNABLE_OLLAMA_SLUGS[0]!;
  const requestedId = requested.startsWith("ollama/") ? requested.slice("ollama/".length) : requested;
  const tag = tags.find((item) => item.name === requestedId);
  if (!tag) {
    throw new Error(
      `COB_LIVE_SUBAGENT spawnable model ${requested} is not in Ollama /api/tags (have ${tags.map((item) => item.name).join(", ")})`,
    );
  }
  const spawnableSlug = `ollama/${tag.name}`;
  const upstreamModel = ollamaUpstreamModel(spawnableSlug);

  const bundled = loadBundledCatalog();
  const catalog = mergeCatalog(bundled, tags, { spawnableOllamaSlugs: [spawnableSlug] });
  capLiveOllamaContext(catalog);
  const parentSlug =
    bundled.models.find((model) => model.slug === "gpt-5.6-luna")?.slug ??
    bundled.models.find((model) => typeof model.slug === "string" && !String(model.slug).startsWith("ollama/"))
      ?.slug;
  if (typeof parentSlug !== "string") {
    throw new Error("COB_LIVE_SUBAGENT could not find a native GPT parent slug in the bundled catalog");
  }

  let dir: string | undefined;
  let server: Awaited<ReturnType<typeof listenGateway>> | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "cob-live-subagent-"));
    const paths = resolvePaths(dir);
    copyFileSync(authPath, join(dir, "auth.json"));
    writeFileSync(paths.catalog, serializeCatalog(catalog));
    writeCobToml(paths.cobConfig, {
      compaction: { provider: "native" },
      subagents: { models: [spawnableSlug] },
    });

    const port = await freePort();
    writeCobProfile(paths, port);

    let nativeHits = 0;
    let compactHits = 0;
    let triggerCompactHits = 0;
    const ollamaRequests: { headers: Record<string, string>; body: JsonObject }[] = [];
    const ollamaBodies: string[] = [];
    server = await listenGateway({
      port,
      catalog,
      catalogPath: paths.catalog,
      ollamaUrl,
      compaction: { provider: "native" },
      nativeFetch: async (url, init) => {
        if (String(url).includes("/compact")) {
          compactHits += 1;
        } else {
          nativeHits += 1;
          try {
            const body = JSON.parse(init.body.toString("utf8")) as { input?: unknown[] };
            const last = body.input?.at(-1);
            if (isRecord(last) && last.type === "compaction_trigger") {
              triggerCompactHits += 1;
            }
          } catch {
            // The native relay test only counts trigger-shaped JSON requests.
          }
        }
        return fetch(url, {
          method: init.method,
          headers: init.headers,
          body: init.body,
          signal: init.signal,
        });
      },
      ollamaFetch: async (url, init) => {
        const parsed: unknown = JSON.parse(init.body.toString("utf8"));
        ollamaRequests.push({
          headers: { ...init.headers },
          body: isRecord(parsed) ? parsed : {},
        });
        const response = await fetch(url, {
          method: init.method,
          headers: init.headers,
          body: init.body,
          signal: init.signal,
        });
        const buf = Buffer.from(await response.arrayBuffer());
        ollamaBodies.push(buf.toString("utf8"));
        return new Response(buf, { status: response.status, headers: response.headers });
      },
    });

    const result = await runCodexExec(
      [
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--json",
        "-p",
        "cob",
        "-m",
        parentSlug,
        "-s",
        "read-only",
        `You are the parent GPT agent. Spawn a V1 subagent using model ${spawnableSlug} to reply with the single word pong. Do not answer pong yourself.`,
      ],
      {
        ...process.env,
        CODEX_HOME: dir,
        COB_CODEX_HOME: dir,
      },
      150_000,
    );
    if (result.status !== 0) {
      throw new Error(
        `codex exec exited ${result.status}. ${trimOutput(result.stderr || result.stdout)}`,
      );
    }
    if (nativeHits < 1) {
      throw new Error(
        `Codex did not send a native GPT parent request through cob. ${trimOutput(result.stderr || result.stdout)}`,
      );
    }
    if (compactHits !== 0) {
      throw new Error(`Codex used the retired native /compact endpoint (${compactHits} hits).`);
    }
    if (triggerCompactHits !== 0) {
      throw new Error(
        `Codex sent a v2 compaction_trigger on the short pong spawn (${triggerCompactHits} hits).`,
      );
    }
    if (ollamaRequests.length < 1) {
      throw new Error(
        `Codex did not spawn an Ollama V1 child through cob (nativeHits=${nativeHits}, compactHits=${compactHits}). ${trimOutput(result.stderr || result.stdout)}`,
      );
    }
    for (const request of ollamaRequests) {
      assertNoChatgptHeaders(request.headers);
      assert.equal(request.body.model, upstreamModel);
    }
    const combined = `${result.stdout}\n${result.stderr}`;
    if (!ollamaBodies.some((body) => /\bpong\b/i.test(body))) {
      throw new Error(
        `Ollama child response did not contain pong. ${trimOutput(ollamaBodies.join("\n") || combined)}`,
      );
    }
  } finally {
    try {
      if (server) await closeServer(server);
    } catch {
      // still delete the temp CODEX_HOME that contains auth.json
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

function capLiveOllamaContext(catalog: CatalogFile): void {
  const raw = process.env.COB_LIVE_CONTEXT_WINDOW;
  if (!raw) return;
  const tokens = Number(raw);
  if (!Number.isInteger(tokens) || tokens <= 0) {
    throw new Error("COB_LIVE_CONTEXT_WINDOW must be a positive integer token count");
  }
  for (const model of catalog.models) {
    if (!String(model.slug).startsWith("ollama/")) continue;
    model.context_window = tokens;
    model.max_context_window = tokens;
  }
}

function runCodexExec(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Codex exec treats an open stdin pipe as more prompt input and waits for
    // EOF. Isolation is CODEX_HOME=temp plus -p cob; --ignore-user-config
    // skips $CODEX_HOME/config.toml and can drop the cob profile overlay.
    const child = spawn("codex", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, 1_000);
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish(() => reject(error));
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      if (timedOut) {
        finish(() =>
          reject(new Error(`codex exec timed out after ${timeoutMs}ms\n${trimOutput(stderr || stdout)}`)),
        );
        return;
      }
      finish(() => resolve({ status, stdout, stderr }));
    });
  });
}

function trimOutput(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > 800 ? `${trimmed.slice(0, 800)}…` : trimmed;
}
