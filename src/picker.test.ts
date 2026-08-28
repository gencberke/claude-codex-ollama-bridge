import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo } from "node:net";
import { mergeCatalog, listVisibleTopSlugs, serializeCatalog } from "./codex/catalog/catalog.js";
import { listenGateway } from "./codex/gateway.js";
import { renderCobProfile } from "./codex/profile.js";
import { resolvePaths } from "./codex/paths.js";
import { restoreCob } from "./codex/lifecycle.js";
import type { CatalogFile } from "./codex/types.js";
import type { JsonObject } from "./core/json.js";
import type { OllamaTag } from "./core/ollama/tags.js";

function native(partial: JsonObject): JsonObject {
  return {
    display_name: String(partial.slug),
    description: "native",
    visibility: "list",
    supported_in_api: true,
    context_window: 272000,
    max_context_window: 272000,
    effective_context_window_percent: 95,
    input_modalities: ["text", "image"],
    supported_reasoning_levels: [
      { effort: "low", description: "Fast" },
      { effort: "medium", description: "Balanced" },
    ],
    default_reasoning_level: "medium",
    default_reasoning_summary: "none",
    support_verbosity: true,
    default_verbosity: "low",
    apply_patch_tool_type: "freeform",
    shell_type: "shell_command",
    tool_mode: "code_mode_only",
    supports_parallel_tool_calls: true,
    supports_image_detail_original: true,
    supports_search_tool: true,
    truncation_policy: { mode: "tokens", limit: 10000 },
    experimental_supported_tools: [],
    multi_agent_version: "v1",
    base_instructions: "NATIVE_INSTRUCTIONS_DO_NOT_COPY",
    ...partial,
  };
}

function bundled(): CatalogFile {
  return {
    models: [
      native({ slug: "gpt-5.6-sol", priority: 1 }),
      native({ slug: "gpt-5.6-terra", priority: 2 }),
      native({ slug: "gpt-5.6-luna", priority: 3 }),
      native({ slug: "gpt-5.5", priority: 7 }),
    ],
  };
}

const tags: OllamaTag[] = [
  { name: "deepseek-v4-flash:cloud", capabilities: ["completion", "tools"] },
  { name: "deepseek-v4-flash:0731-cloud", capabilities: ["completion", "tools", "thinking"] },
  { name: "library/qwen2.5:7b", capabilities: ["completion"] },
];

function codexAvailable(): boolean {
  const result = spawnSync("codex", ["--version"], { encoding: "utf8" });
  return result.status === 0;
}

describe("picker visibility", () => {
  it("lists native and Ollama rows from an isolated cob catalog without touching root config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-picker-"));
    const paths = resolvePaths(dir);
    const original = 'model = "gpt-5.6-luna"\n';
    writeFileSync(paths.rootConfig, original);
    const catalog = mergeCatalog(bundled(), tags, {
      spawnableOllamaSlugs: ["ollama/deepseek-v4-flash:0731-cloud"],
    });
    writeFileSync(paths.catalog, serializeCatalog(catalog));
    writeFileSync(paths.profile, renderCobProfile({ port: 18790, catalogPath: paths.catalog }));

    const top = listVisibleTopSlugs(catalog.models);
    assert.deepEqual(top, [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "ollama/deepseek-v4-flash:0731-cloud",
    ]);
    assert.equal(top.includes("gpt-5.5"), false);
    assert.equal(top.includes("ollama/deepseek-v4-flash:cloud"), false);

    if (codexAvailable()) {
      const listed = spawnSync(
        "codex",
        ["debug", "models", "-c", `model_catalog_json=${JSON.stringify(paths.catalog)}`],
        { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
      );
      assert.equal(listed.status, 0, listed.stderr || listed.stdout);
      assert.match(listed.stdout, /gpt-5\.6-sol/);
      assert.match(listed.stdout, /ollama\/deepseek-v4-flash:0731-cloud/);
    }

    let nativeHits = 0;
    let ollamaModel: string | undefined;
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog,
      nativeFetch: async () => {
        nativeHits += 1;
        return new Response(JSON.stringify({ ok: "native" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      ollamaFetch: async (_url, init) => {
        const parsed: unknown = JSON.parse(init.body.toString("utf8"));
        ollamaModel =
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
      const ollama = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ollama/library%2Fqwen2.5:7b", input: "hi" }),
      });
      assert.equal(ollama.ok, true, await ollama.text());
      assert.equal(ollamaModel, "library/qwen2.5:7b");

      const gpt = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6-luna", input: "hi" }),
      });
      assert.equal(gpt.ok, true, await gpt.text());
      assert.equal(nativeHits, 1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }

    await restoreCob(paths);
    assert.equal(readFileSync(paths.rootConfig, "utf8"), original);
  });
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
