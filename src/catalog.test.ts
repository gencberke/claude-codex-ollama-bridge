import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertOllamaRowsSafe,
  assignFeaturedPriorities,
  buildOllamaEntry,
  isVerifiedCloudOllamaTag,
  listVisibleTopSlugs,
  ollamaCatalogWindows,
  mergeCatalog,
  mergeCatalogWithFallback,
} from "./codex/catalog/catalog.js";
import { assertConsumersAcceptCatalog, CatalogConsumerRejectedError } from "./codex/catalog/validator.js";
import { loadBundledCatalog } from "./codex/catalog/source.js";
import { loadOllamaTags } from "./core/ollama/tags.js";
import { GPT_IDENTITY_FIELDS, OLLAMA_BASE_INSTRUCTIONS, OLLAMA_ISOLATED_COMPACT_TOKEN_LIMIT } from "./codex/constants.js";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogFile } from "./codex/types.js";
import type { JsonObject } from "./core/json.js";
import type { OllamaTag } from "./core/ollama/tags.js";
import type { CodexBinaryRecord } from "./codex/catalog/source.js";

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
      { effort: "low", description: "Fast responses with lighter reasoning" },
      { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
      { effort: "high", description: "Greater reasoning depth for complex problems" },
      { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
      { effort: "max", description: "Maximum reasoning depth for the hardest problems" },
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
    model_messages: { instructions_template: "NATIVE_TEMPLATE_DO_NOT_COPY" },
    use_responses_lite: true,
    ...partial,
  };
}

function bundled(): CatalogFile {
  return {
    models: [
      native({ slug: "gpt-5.6-sol", priority: 1, multi_agent_version: "v2" }),
      native({ slug: "gpt-5.6-terra", priority: 2 }),
      native({ slug: "gpt-5.6-luna", priority: 3 }),
      native({ slug: "gpt-5.5", priority: 7 }),
      native({ slug: "gpt-5.4", priority: 16, visibility: "hide" }),
    ],
  };
}

const tags: OllamaTag[] = [
  {
    name: "deepseek-v4-flash:cloud",
    capabilities: ["completion", "tools", "thinking"],
    details: { context_length: 1048576, parameter_size: "304B" },
  },
  {
    name: "deepseek-v4-flash:0731-cloud",
    capabilities: ["completion", "tools", "thinking"],
    details: { context_length: 1048576, parameter_size: "304B" },
  },
];

describe("catalog merge", () => {
  it("copies native rows verbatim including GPT identity fields", () => {
    const merged = mergeCatalog(bundled(), tags);
    const luna = merged.models.find((model) => model.slug === "gpt-5.6-luna");
    assert.equal(luna?.base_instructions, "NATIVE_INSTRUCTIONS_DO_NOT_COPY");
    assert.deepEqual(luna?.model_messages, {
      instructions_template: "NATIVE_TEMPLATE_DO_NOT_COPY",
    });
  });

  it("does not copy GPT identity fields onto Ollama rows", () => {
    const merged = mergeCatalog(bundled(), tags);
    assertOllamaRowsSafe(merged);
    const ollama = merged.models.find((model) => model.slug === "ollama/deepseek-v4-flash:0731-cloud");
    assert.ok(ollama);
    assert.equal(ollama.base_instructions, OLLAMA_BASE_INSTRUCTIONS);
    for (const field of GPT_IDENTITY_FIELDS.filter((name) => name !== "base_instructions")) {
      assert.equal(field in ollama, false, field);
    }
    assert.equal(ollama.multi_agent_version, "v1");
    assert.equal(ollama.context_window, 256000);
    assert.equal(ollama.max_context_window, 256000);
    assert.equal(ollama.display_name, "ollama/deepseek-v4-flash:0731-cloud");
    assert.equal(ollama.supports_parallel_tool_calls, false);
    assert.equal(ollama.supports_search_tool, false);
    assert.equal(ollama.shell_type, "unified_exec");
    assert.equal("apply_patch_tool_type" in ollama, false);
    assert.equal("tool_mode" in ollama, false);
    assert.equal(ollama.support_verbosity, false);
  });

  it("lists sol, terra, luna, then spawnable 0731 and hides the rest", () => {
    const merged = mergeCatalog(bundled(), tags, {
      spawnableOllamaSlugs: ["ollama/deepseek-v4-flash:0731-cloud"],
    });
    const top = listVisibleTopSlugs(merged.models);
    assert.deepEqual(top, [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "ollama/deepseek-v4-flash:0731-cloud",
    ]);
    const hiddenNative = merged.models.find((model) => model.slug === "gpt-5.5");
    const hiddenOllama = merged.models.find((model) => model.slug === "ollama/deepseek-v4-flash:cloud");
    assert.equal(hiddenNative?.visibility, "hide");
    assert.equal(hiddenOllama?.visibility, "hide");
  });

  it("keeps original bundled fields on native rows except rewritten priority", () => {
    const original = bundled().models.find((model) => model.slug === "gpt-5.6-luna");
    const merged = mergeCatalog(bundled(), tags);
    const luna = merged.models.find((model) => model.slug === "gpt-5.6-luna");
    assert.ok(original && luna);
    const { priority: _op, visibility: _ov, ...origRest } = original;
    const { priority: _mp, visibility: _mv, ...mergedRest } = luna;
    assert.deepEqual(mergedRest, origRest);
    assert.equal(luna.visibility, "list");
    assert.equal(luna.priority, 2);
  });

  it("advertises DeepSeek thinking efforts and caps 1M context at 256k", () => {
    const skeleton = bundled().models[2]!;
    const entry = buildOllamaEntry(tags[1]!, skeleton, 3);
    const efforts = (entry.supported_reasoning_levels as { effort: string }[]).map((level) => level.effort);
    assert.deepEqual(efforts, ["none", "low", "high", "max"]);
    assert.equal(entry.default_reasoning_level, "high");
    assert.equal(entry.context_window, 256000);
    assert.equal(entry.display_name, entry.slug);
    assert.equal(efforts.includes("xhigh"), false);
    assert.equal(efforts.includes("medium"), false);
  });

  it("uses the GLM-5.3 Flash ladder when the row is explicitly selected", () => {
    const merged = mergeCatalog(
      bundled(),
      [
        {
          name: "glm-5.3-flash:cloud",
          capabilities: ["completion", "tools", "thinking", "vision"],
          details: { context_length: 1048576, parameter_size: "321B" },
        },
        ...tags,
      ],
      { spawnableOllamaSlugs: ["ollama/glm-5.3-flash:cloud"] },
    );
    const entry = merged.models.find((model) => model.slug === "ollama/glm-5.3-flash:cloud");
    assert.ok(entry);
    assert.deepEqual(
      (entry.supported_reasoning_levels as { effort: string }[]).map((level) => level.effort),
      ["low", "high", "max"],
    );
    assert.equal(entry.default_reasoning_level, "max");
    assert.equal(entry.visibility, "list");
    assert.deepEqual(listVisibleTopSlugs(merged.models), [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "ollama/glm-5.3-flash:cloud",
    ]);
  });

  it("does not inflate small Ollama context windows to 256k", () => {
    const skeleton = bundled().models[2]!;
    const entry = buildOllamaEntry(
      { name: "qwen2.5:7b", capabilities: ["completion"], details: { context_length: 8192 } },
      skeleton,
      20,
    );
    assert.equal(entry.context_window, 8192);
    assert.equal(entry.max_context_window, 8192);
  });

  it("keeps the 256k active window when exposing a verified cloud maximum", () => {
    assert.equal(isVerifiedCloudOllamaTag(tags[1]!), true);
    assert.equal(isVerifiedCloudOllamaTag({ name: "qwen2.5:7b" }), false);
    const windows = ollamaCatalogWindows({
      tagLength: 1048576,
      cloud: true,
      advertiseCloudMax: true,
    });
    assert.equal(windows.contextWindow, 256000);
    assert.equal(windows.maxContextWindow, 1048576);
    const entry = buildOllamaEntry(tags[1]!, bundled().models[2]!, 3, { advertiseCloudMaxContext: true });
    assert.equal(entry.context_window, 256000);
    assert.equal(entry.max_context_window, 1048576);
    assert.equal("auto_compact_token_limit" in entry, false);
    const local = buildOllamaEntry(
      { name: "qwen2.5:7b", capabilities: ["completion"], details: { context_length: 1048576 } },
      bundled().models[2]!,
      20,
      { advertiseCloudMaxContext: true },
    );
    assert.equal(local.context_window, 256000);
    assert.equal(local.max_context_window, 256000);
  });

  it("omits auto_compact_token_limit unless the native skeleton already has it", () => {
    const skeleton = bundled().models[2]!;
    assert.equal("auto_compact_token_limit" in skeleton, false);
    const omitted = buildOllamaEntry(tags[1]!, skeleton, 3, {
      autoCompactTokenLimit: OLLAMA_ISOLATED_COMPACT_TOKEN_LIMIT,
    });
    assert.equal("auto_compact_token_limit" in omitted, false);
    const isolated = buildOllamaEntry(tags[1]!, { ...skeleton, auto_compact_token_limit: 180000 }, 3, {
      autoCompactTokenLimit: OLLAMA_ISOLATED_COMPACT_TOKEN_LIMIT,
    });
    assert.equal(isolated.auto_compact_token_limit, 230400);
    assert.equal(isolated.context_window, 256000);
  });

  it("encodes slash-containing Ollama ids instead of failing the merge", () => {
    const merged = mergeCatalog(bundled(), [
      ...tags,
      {
        name: "library/qwen2.5:7b",
        capabilities: ["completion"],
        details: { context_length: 32768 },
      },
    ]);
    const slugged = merged.models.find((model) => model.slug === "ollama/library%2Fqwen2.5:7b");
    assert.ok(slugged);
    assert.deepEqual(slugged.supported_reasoning_levels, []);
    assert.equal("default_reasoning_level" in slugged, false);
    assert.equal(slugged.visibility, "hide");
    assert.equal(merged.models.some((model) => model.slug === "ollama/deepseek-v4-flash:cloud"), true);
  });

  it("does not advertise reasoning on completion-only Ollama tags", () => {
    const merged = mergeCatalog(bundled(), [
      {
        name: "qwen2.5:7b",
        capabilities: ["completion"],
        details: { context_length: 32768 },
      },
    ]);
    const qwen = merged.models.find((model) => model.slug === "ollama/qwen2.5:7b");
    assert.ok(qwen);
    assert.deepEqual(qwen.supported_reasoning_levels, []);
    assert.equal("default_reasoning_level" in qwen, false);
    assert.equal(qwen.visibility, "hide");
    assert.equal(qwen.context_window, 32768);
  });

  it("rejects Ollama rows that advertise medium or xhigh", () => {
    assert.throws(
      () =>
        assertOllamaRowsSafe({
          models: [
            {
              slug: "ollama/deepseek-v4-flash:0731-cloud",
              base_instructions: OLLAMA_BASE_INSTRUCTIONS,
              supported_reasoning_levels: [{ effort: "medium", description: "legacy" }],
              default_reasoning_level: "medium",
              supports_parallel_tool_calls: false,
              supports_search_tool: false,
              multi_agent_version: "v1",
              shell_type: "disabled",
            },
          ],
        }),
      /unsupported reasoning effort/,
    );
  });

  it("rejects Ollama rows that advertise a default reasoning level without levels", () => {
    assert.throws(
      () =>
        assertOllamaRowsSafe({
          models: [
            {
              slug: "ollama/qwen2.5:7b",
              base_instructions: OLLAMA_BASE_INSTRUCTIONS,
              supported_reasoning_levels: [],
              default_reasoning_level: "medium",
              supports_parallel_tool_calls: false,
              supports_search_tool: false,
              multi_agent_version: "v1",
              shell_type: "disabled",
            },
          ],
        }),
      /default_reasoning_level/,
    );
  });

  it("rejects the unavailable none level on the always-on GLM row", () => {
    assert.throws(
      () =>
        assertOllamaRowsSafe({
          models: [
            {
              slug: "ollama/glm-5.3-flash:cloud",
              base_instructions: OLLAMA_BASE_INSTRUCTIONS,
              supported_reasoning_levels: [{ effort: "none", description: "disabled" }],
              default_reasoning_level: "none",
              supports_parallel_tool_calls: false,
              supports_search_tool: false,
              multi_agent_version: "v1",
              shell_type: "disabled",
            },
          ],
        }),
      /model-specific reasoning ladder/,
    );
  });

  it("advertises unified_exec shell only on fresh exact tools evidence", () => {
    const entry = buildOllamaEntry(tags[0]!, bundled().models[2]!, 20);
    assert.equal(entry.shell_type, "unified_exec");
    const noTools = buildOllamaEntry(
      { name: "qwen2.5:7b", capabilities: ["completion"], details: { context_length: 8192 } },
      bundled().models[2]!,
      20,
    );
    assert.equal(noTools.shell_type, "disabled");
    const variant = buildOllamaEntry(
      { name: "qwen2.5:7b", capabilities: ["completion", "Tools"], details: { context_length: 8192 } },
      bundled().models[2]!,
      20,
    );
    assert.equal(variant.shell_type, "disabled");
  });

  it("accepts exactly unified_exec and disabled shell types on Ollama rows", () => {
    const row = {
      slug: "ollama/deepseek-v4-flash:0731-cloud",
      base_instructions: OLLAMA_BASE_INSTRUCTIONS,
      supports_parallel_tool_calls: false,
      supports_search_tool: false,
      multi_agent_version: "v1",
      shell_type: "unified_exec",
    };
    assert.doesNotThrow(() => assertOllamaRowsSafe({ models: [row] }));
    for (const invalid of ["shell_command", "unified", "", 7]) {
      assert.throws(
        () => assertOllamaRowsSafe({ models: [{ ...row, shell_type: invalid }] }),
        /exactly disabled or unified_exec/,
        String(invalid),
      );
    }
  });

  it("does not pad the picker with gpt-5.5 when gpt-5.6 is absent", () => {
    const priorities = assignFeaturedPriorities(
      bundled().models,
      ["deepseek-v4-flash:0731-cloud"],
      ["ollama/deepseek-v4-flash:0731-cloud"],
    );
    assert.equal(priorities.get("gpt-5.6-sol"), 0);
    assert.equal(priorities.get("gpt-5.6-terra"), 1);
    assert.equal(priorities.get("gpt-5.6-luna"), 2);
    assert.equal(priorities.get("ollama/deepseek-v4-flash:0731-cloud"), 3);
    assert.equal(priorities.get("gpt-5.5"), 17);
  });

  it("hides non-spawnable Ollama rows while keeping them in the catalog", () => {
    const merged = mergeCatalog(bundled(), tags, {
      spawnableOllamaSlugs: ["ollama/deepseek-v4-flash:cloud"],
    });
    const top = listVisibleTopSlugs(merged.models);
    assert.equal(top.includes("ollama/deepseek-v4-flash:cloud"), true);
    assert.equal(top.includes("ollama/deepseek-v4-flash:0731-cloud"), false);
    const extra = merged.models.find((model) => model.slug === "ollama/deepseek-v4-flash:0731-cloud");
    assert.ok(extra);
    assert.equal(extra.visibility, "hide");
  });

  it("keeps gpt-5.6-sol listed when multiple Ollama models are spawnable", () => {
    const merged = mergeCatalog(bundled(), tags, {
      spawnableOllamaSlugs: ["ollama/deepseek-v4-flash:cloud", "ollama/deepseek-v4-flash:0731-cloud"],
    });
    const top = listVisibleTopSlugs(merged.models);
    assert.deepEqual(top, [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "ollama/deepseek-v4-flash:cloud",
      "ollama/deepseek-v4-flash:0731-cloud",
    ]);
  });

  it("rebuilds previous Ollama rows instead of cloning leaked capabilities on discovery failure", () => {
    const previous = mergeCatalog(bundled(), tags);
    const leaked = previous.models.find((model) => model.slug === "ollama/deepseek-v4-flash:cloud");
    assert.ok(leaked);
    leaked.apply_patch_tool_type = "freeform";
    leaked.tool_mode = "code_mode_only";
    leaked.shell_type = "unified_exec";
    leaked.supported_reasoning_levels = [
      { effort: "high", description: "leaked" },
      { effort: "medium", description: "ok" },
    ];
    leaked.default_reasoning_level = "max";
    const fallback = mergeCatalogWithFallback(bundled(), [], previous, true);
    const rebuilt = fallback.models.find((model) => model.slug === "ollama/deepseek-v4-flash:cloud");
    assert.ok(rebuilt);
    assert.equal("apply_patch_tool_type" in rebuilt, false);
    assert.equal("tool_mode" in rebuilt, false);
    // Discovery fallback evidence cannot keep a previous positive unified_exec.
    assert.equal(rebuilt.shell_type, "disabled");
    assert.deepEqual(
      (rebuilt.supported_reasoning_levels as { effort: string }[]).map((level) => level.effort),
      ["none", "low", "high", "max"],
    );
    assert.equal(rebuilt.default_reasoning_level, "high");
    assert.equal(rebuilt.base_instructions, OLLAMA_BASE_INSTRUCTIONS);
    assert.equal(rebuilt.display_name, "ollama/deepseek-v4-flash:cloud");
    assert.equal(rebuilt.context_window, 256000);
  });

  it("keeps the previously visible spawn row during a default migration fallback", () => {
    const previous = mergeCatalog(bundled(), tags, {
      spawnableOllamaSlugs: ["ollama/deepseek-v4-flash:0731-cloud"],
    });
    const fallback = mergeCatalogWithFallback(bundled(), [], previous, true, {
      spawnableOllamaSlugs: ["ollama/glm-5.3-flash:cloud"],
    });
    const deepseek = fallback.models.find(
      (model) => model.slug === "ollama/deepseek-v4-flash:0731-cloud",
    );
    const extra = fallback.models.find((model) => model.slug === "ollama/deepseek-v4-flash:cloud");
    assert.ok(deepseek);
    assert.equal(deepseek.visibility, "list");
    assert.equal(deepseek.priority, 3);
    assert.equal(extra?.visibility, "hide");
    assert.deepEqual(listVisibleTopSlugs(fallback.models), [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "ollama/deepseek-v4-flash:0731-cloud",
    ]);
    assert.equal(
      fallback.models.some((model) => model.slug === "ollama/glm-5.3-flash:cloud"),
      false,
    );
  });

  it("advertises supports_search_tool on Ollama rows only when opted in", () => {
    const off = mergeCatalog(bundled(), tags);
    const hidden = off.models.find((model) => model.slug === "ollama/deepseek-v4-flash:0731-cloud");
    assert.equal(hidden?.supports_search_tool, false);
    assert.throws(
      () =>
        assertOllamaRowsSafe({
          models: [
            {
              slug: "ollama/deepseek-v4-flash:0731-cloud",
              base_instructions: OLLAMA_BASE_INSTRUCTIONS,
              supports_parallel_tool_calls: false,
              supports_search_tool: true,
              multi_agent_version: "v1",
              shell_type: "disabled",
            },
          ],
        }),
      /must not advertise search/,
    );
    const on = mergeCatalog(bundled(), tags, { supportsSearchTool: true });
    const listed = on.models.find((model) => model.slug === "ollama/deepseek-v4-flash:0731-cloud");
    assert.equal(listed?.supports_search_tool, true);
    assertOllamaRowsSafe(on, { allowSearchTool: true });
  });

  it("advertises Gate 5 apply_patch only on configured Ollama spawn rows", () => {
    const spawnable = ["ollama/deepseek-v4-flash:0731-cloud"] as const;
    const on = mergeCatalog(bundled(), tags, {
      spawnableOllamaSlugs: spawnable,
      applyPatch: true,
    });
    const spawn = on.models.find((model) => model.slug === spawnable[0]);
    const nonSpawn = on.models.find((model) => model.slug === "ollama/deepseek-v4-flash:cloud");
    const nativeSol = on.models.find((model) => model.slug === "gpt-5.6-sol");
    assert.equal(spawn?.apply_patch_tool_type, "freeform");
    assert.equal("apply_patch_tool_type" in (nonSpawn ?? {}), false);
    assert.equal(nativeSol?.apply_patch_tool_type, "freeform");
    assert.equal(spawn?.shell_type, "unified_exec");
    assert.equal(spawn?.multi_agent_version, "v1");
    assertOllamaRowsSafe(on, {
      allowApplyPatch: true,
      spawnableOllamaSlugs: spawnable,
    });
  });

  it("rejects apply_patch unless the safety opt-in and configured spawn row both match", () => {
    const row = {
      slug: "ollama/deepseek-v4-flash:0731-cloud",
      base_instructions: OLLAMA_BASE_INSTRUCTIONS,
      supports_parallel_tool_calls: false,
      supports_search_tool: false,
      multi_agent_version: "v1",
      shell_type: "disabled",
      apply_patch_tool_type: "freeform",
    };
    assert.throws(
      () => assertOllamaRowsSafe({ models: [row] }),
      /must not advertise apply_patch without explicit opt-in/,
    );
    assert.throws(
      () =>
        assertOllamaRowsSafe(
          { models: [row] },
          { allowApplyPatch: true, spawnableOllamaSlugs: ["ollama/qwen2.5:7b"] },
        ),
      /unless it is a configured spawn row/,
    );
    assert.throws(
      () =>
        assertOllamaRowsSafe(
          { models: [{ ...row, apply_patch_tool_type: "shell" }] },
          { allowApplyPatch: true, spawnableOllamaSlugs: ["ollama/deepseek-v4-flash:0731-cloud"] },
        ),
      /must advertise apply_patch_tool_type = freeform/,
    );
  });
});

describe("Desktop and PATH catalog schemas", () => {
  it("does not add auto_compact_token_limit while current bundled rows omit it", () => {
    const bins = [
      process.env.COB_CODEX_BIN,
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/opt/homebrew/bin/codex",
    ].filter((bin): bin is string => typeof bin === "string" && bin.length > 0 && existsSync(bin));
    if (bins.length === 0) return;
    for (const bin of [...new Set(bins)]) {
      let catalog: CatalogFile;
      try {
        catalog = loadBundledCatalog(bin);
      } catch {
        continue;
      }
      assert.equal(
        catalog.models.some((model) => "auto_compact_token_limit" in model),
        false,
        `${bin} advertised auto_compact_token_limit`,
      );
    }
  });
});

describe("producer failure sanitization", () => {
  it("reports producer failures with bounded, sanitized child output", () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-producer-fail-"));
    const bin = join(dir, "codex");
    writeFileSync(
      bin,
      [
        "#!/bin/sh",
        "printf 'Bearer sk-first-line-secret Authorization: Basic dXNlcjpwYXNz at /Users/alice/.codex/auth.json and /root/.codex/auth.json and C:\\\\Users\\\\alice\\\\.codex\\\\auth.json missing\\nsecond line topsecret-marker\\n' >&2",
        "exit 7",
        "",
      ].join("\n"),
    );
    chmodSync(bin, 0o755);
    try {
      loadBundledCatalog(bin);
      assert.fail("expected the producer to fail");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /failed \(7\)/);
      assert.ok(!message.includes("sk-first-line-secret"), "credential-looking tokens must be redacted");
      assert.ok(!message.includes("dXNlcjpwYXNz"), "basic-auth credentials must be redacted");
      assert.ok(!message.includes("/Users/alice"), "user home paths must be redacted");
      assert.match(message, /\/Users\/<user>\//, "the Users redaction branch must be exercised");
      assert.ok(!message.includes("/root/.codex"), "root home paths must be redacted");
      assert.match(message, /\/root\/<user>\//, "the root redaction branch must be exercised");
      assert.ok(!message.includes("C:\\Users\\alice"), "Windows user paths must be redacted");
      assert.match(message, /C:\\Users\\<user>/, "the Windows redaction branch must be exercised");
      assert.ok(!message.includes("second line"), "only the first output line may be reported");
      assert.ok(!message.includes("topsecret-marker"), "beyond-the-cap producer output must not leak");
      assert.match(message, /auth\.json/, "harmless context stays for diagnosis");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("consumer catalog validation", () => {
  it("accepts a candidate from every distinct consumer and names the failing consumer", () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-catalog-consumers-"));
    const accept = join(dir, "accept");
    const reject = join(dir, "reject");
    writeFileSync(accept, "#!/bin/sh\nprintf '%s\\n' 'ok'\n");
    writeFileSync(reject, "#!/bin/sh\necho 'bad field context_window' >&2\nexit 1\n");
    chmodSync(accept, 0o755);
    chmodSync(reject, 0o755);
    const file = { dev: "1", ino: "1", size: 1, mtime_ms: 1 };
    const consumers: CodexBinaryRecord[] = [
      { kind: "desktop", path: accept, version: "desktop", file: { ...file, ino: "1" } },
      { kind: "path", path: reject, version: "path", file: { ...file, ino: "2" } },
    ];
    assert.doesNotThrow(() => assertConsumersAcceptCatalog({ models: [{ slug: "gpt-x" }] }, [consumers[0]!]));
    assert.throws(
      () => assertConsumersAcceptCatalog({ models: [{ slug: "gpt-x" }] }, consumers),
      (error: unknown) => {
        assert.ok(error instanceof CatalogConsumerRejectedError);
        assert.equal(error.consumer.path, reject);
        assert.match(error.message, /rejected cob catalog \(path .*bad field context_window/);
        return true;
      },
    );
  });
});

describe("Ollama tag discovery", () => {
  it("times out hung Ollama /api/tags instead of holding the cob lock forever", async () => {
    const { createServer } = await import("node:http");
    const hung = createServer(() => undefined);
    await new Promise<void>((resolve) => {
      hung.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = hung.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      await assert.rejects(
        () => loadOllamaTags(`http://127.0.0.1:${port}`, 80),
        /timed out after 80ms/,
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        hung.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
