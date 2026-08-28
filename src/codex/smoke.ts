import { createServer, type AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeCatalog, listVisibleTopSlugs } from "./catalog/catalog.js";
import { loadBundledCatalog } from "./catalog/source.js";
import { assertCodexAcceptsCatalog } from "./catalog/validator.js";
import { OLLAMA_BASE_INSTRUCTIONS } from "./constants.js";
import { DEFAULT_OLLAMA_SPAWN_MODEL } from "../core/ollama/default-model.js";
import { listenGateway } from "./gateway.js";
import { restoreCob } from "./lifecycle.js";
import { resolvePaths } from "./paths.js";
import { renderCobProfile } from "./profile.js";
import { routeModel } from "./route.js";
import type { CatalogFile } from "./types.js";
import type { OllamaTag } from "../core/ollama/tags.js";

export type SmokeOptions = {
  live?: boolean;
  ollamaUrl?: string;
};

export async function runSmoke(opts: SmokeOptions = {}): Promise<void> {
  const failures: string[] = [];
  const pass = (name: string) => console.log(`ok  ${name}`);
  const fail = (name: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
    console.error(`not ok  ${name}: ${message}`);
  };

  try {
    await t1BundledParse();
    pass("T1 bundled fixture parse + Ollama overlay hygiene");
  } catch (error) {
    fail("T1", error);
  }

  try {
    t2Roster();
    pass("T2 featured top-5 roster");
  } catch (error) {
    fail("T2", error);
  }

  try {
    await t4EncryptedNeverHitsOllama();
    pass("T4 encrypted_content returns 400 and never reaches Ollama");
  } catch (error) {
    fail("T4", error);
  }

  try {
    await gptToGptGuardrail();
    pass("GPT→GPT native passthrough guardrail");
  } catch (error) {
    fail("GPT→GPT", error);
  }

  try {
    await restoreLeavesRootUntouched();
    pass("restore leaves root config.toml byte-identical");
  } catch (error) {
    fail("restore", error);
  }

  try {
    profilePinsContract();
    pass("cob profile pins openai provider and V1");
  } catch (error) {
    fail("profile", error);
  }

  if (opts.live) {
    try {
      await t3LiveOllama(opts.ollamaUrl ?? "http://127.0.0.1:11434");
      pass("T3 live Ollama Responses via gateway");
    } catch (error) {
      fail("T3 live", error);
    }
  } else {
    console.log("skip T3 Codex spawn (pass --live to ping Ollama through the gateway)");
  }

  if (failures.length > 0) {
    throw new Error(`${failures.length} smoke check(s) failed`);
  }
  console.log("all smoke checks passed");
}

async function t1BundledParse(): Promise<CatalogFile> {
  const bundled = loadBundledCatalog();
  if (bundled.models.length === 0) throw new Error("bundled catalog empty");
  const tags: OllamaTag[] = [
    {
      name: DEFAULT_OLLAMA_SPAWN_MODEL,
      capabilities: ["completion", "tools", "thinking"],
      details: { context_length: 1048576, parameter_size: "304B" },
    },
  ];
  const merged = mergeCatalog(bundled, tags);
  const ollama = merged.models.find((model) => model.slug === `ollama/${DEFAULT_OLLAMA_SPAWN_MODEL}`);
  if (!ollama) throw new Error("missing ollama overlay");
  if (ollama.base_instructions !== OLLAMA_BASE_INSTRUCTIONS) {
    throw new Error("Ollama row must use cob-owned instructions, not GPT text");
  }
  if ("model_messages" in ollama) {
    throw new Error("Ollama row copied GPT model_messages");
  }
  const native = merged.models.find((model) => model.slug === "gpt-5.6-luna");
  if (!native) throw new Error("native luna row missing");
  if (!("base_instructions" in native) && !("model_messages" in native)) {
    throw new Error("native rows were stripped; they must stay verbatim");
  }
  assertCodexAcceptsCatalog(merged);
  return merged;
}

function t2Roster(): void {
  const bundled = loadBundledCatalog();
  const merged = mergeCatalog(bundled, [
    {
      name: "deepseek-v4-flash:cloud",
      capabilities: ["completion", "tools", "thinking"],
      details: { context_length: 1048576 },
    },
    {
      name: DEFAULT_OLLAMA_SPAWN_MODEL,
      capabilities: ["completion", "tools", "thinking"],
      details: { context_length: 1048576 },
    },
  ]);
  const top = listVisibleTopSlugs(merged.models);
  if (top.join(",") !== `gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna,ollama/${DEFAULT_OLLAMA_SPAWN_MODEL}`) {
    throw new Error(`featured window should be sol, terra, luna, the default Ollama child; got ${top.join(", ")}`);
  }
  if (top.includes("gpt-5.5") || top.includes("ollama/deepseek-v4-flash:cloud")) {
    throw new Error(`picker leaked a hidden slug: ${top.join(", ")}`);
  }
}

async function t4EncryptedNeverHitsOllama(): Promise<void> {
  let ollamaHits = 0;
  const port = await freePort();
  const server = await listenGateway({
    port,
    ollamaUrl: "http://127.0.0.1:9",
    ollamaFetch: async () => {
      ollamaHits += 1;
      return new Response("should not run", { status: 599 });
    },
  });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: `ollama/${DEFAULT_OLLAMA_SPAWN_MODEL}`,
        input: [
          {
            type: "agent_message",
            encrypted_content: "gAAAAAencrypted-child-task-should-never-leave-cob",
          },
        ],
      }),
    });
    if (response.status !== 400) {
      throw new Error(`expected 400, got ${response.status} ${await response.text()}`);
    }
    const body: unknown = await response.json();
    const code =
      body && typeof body === "object" && "error" in body
        ? (body as { error?: { code?: string } }).error?.code
        : undefined;
    if (code !== "encrypted_content_unsupported") {
      throw new Error(`unexpected error code ${code}`);
    }
    if (ollamaHits !== 0) throw new Error("Ollama fetch was invoked");
  } finally {
    await closeServer(server);
  }
}

async function gptToGptGuardrail(): Promise<void> {
  if (routeModel("gpt-5.6-luna", new Set(["gpt-5.6-luna"])) !== "native") throw new Error("luna must stay native");
  if (routeModel(`ollama/${DEFAULT_OLLAMA_SPAWN_MODEL}`, new Set()) !== "ollama") {
    throw new Error("ollama slug must route to ollama");
  }
  let nativeHits = 0;
  let ollamaHits = 0;
  const port = await freePort();
  const server = await listenGateway({
    port,
    catalog: {
      models: [{ slug: "gpt-5.6-luna" }],
    },
    nativeFetch: async (_url, init) => {
      nativeHits += 1;
      const headers = init.headers;
      if (!headers.authorization) throw new Error("authorization was not forwarded");
      if (headers["chatgpt-account-id"] !== "acct_test") {
        throw new Error("chatgpt-account-id was not forwarded");
      }
      return new Response(JSON.stringify({ id: "native-ok", model: "gpt-5.6-luna" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    ollamaFetch: async () => {
      ollamaHits += 1;
      return new Response("nope", { status: 599 });
    },
  });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-test",
        "chatgpt-account-id": "acct_test",
      },
      body: JSON.stringify({ model: "gpt-5.6-luna", input: "hello" }),
    });
    if (!response.ok) throw new Error(`native status ${response.status}`);
    if (nativeHits !== 1) throw new Error("native backend was not called");
    if (ollamaHits !== 0) throw new Error("GPT request leaked to Ollama");
  } finally {
    await closeServer(server);
  }
}

async function restoreLeavesRootUntouched(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cob-smoke-"));
  try {
    const paths = resolvePaths(dir);
    const original = "model = \"gpt-5.6-luna\"\n";
    writeFileSync(paths.rootConfig, original);
    writeFileSync(paths.profile, "model_provider = \"openai\"\n");
    writeFileSync(paths.catalog, "{}\n");
    writeFileSync(paths.catalogMeta, "{}\n");
    await restoreCob(paths);
    const after = readFileSync(paths.rootConfig, "utf8");
    if (after !== original) throw new Error("root config bytes changed");
    try {
      readFileSync(paths.profile);
      throw new Error("profile still present");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      readFileSync(paths.catalogMeta);
      throw new Error("catalog metadata still present");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function profilePinsContract(): void {
  const text = renderCobProfile({ port: 18790, catalogPath: "/tmp/cob-catalog.json" });
  if (!text.includes('model_provider = "openai"')) throw new Error("missing provider pin");
  if (!text.includes("multi_agent_v2 = false")) throw new Error("missing V1 pin");
  if (text.includes("[model_providers")) throw new Error("must not add model_providers table");
}

async function t3LiveOllama(ollamaUrl: string): Promise<void> {
  const port = await freePort();
  const server = await listenGateway({ port, ollamaUrl });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: `ollama/${DEFAULT_OLLAMA_SPAWN_MODEL}`,
        input: "Reply with the single word pong.",
        stream: false,
        store: false,
        max_output_tokens: 32,
      }),
    });
    if (!response.ok) {
      throw new Error(`live ollama ${response.status} ${await response.text()}`);
    }
    const body: unknown = await response.json();
    const raw = JSON.stringify(body);
    if (raw.includes("encrypted_content")) {
      throw new Error("Ollama response still contains encrypted_content after normalize");
    }
    if (typeof body === "object" && body && "model" in body) {
      const model = (body as { model?: string }).model;
      if (model && !model.startsWith("ollama/")) {
        throw new Error(`response model was not rewritten: ${model}`);
      }
    }
  } finally {
    await closeServer(server);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      server.close((error) => {
        if (error) reject(error);
        else resolve(addr.port);
      });
    });
    server.on("error", reject);
  });
}

function closeServer(server: { close: (cb: (error?: Error) => void) => void }): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
