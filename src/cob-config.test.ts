import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CobConfigError,
  parseCobToml,
  parseCompactionProvider,
  parseOllamaCompactEffort,
  parseOllamaCompactModel,
  parseOllamaThreadCompaction,
  renderCobToml,
  resolveCobConfig,
  resolveCompactionPolicy,
  resolveSpawnableOllamaSlugs,
  writeCobToml,
} from "./cob-config.js";

describe("cob.toml compaction policy", () => {
  it("rejects legacy ollama and disabled providers", () => {
    assert.throws(
      () => parseCobToml(`[compaction]\nprovider = "ollama"\n`),
      (error: unknown) => error instanceof CobConfigError && error.code === "compaction_provider_unsupported",
    );
    assert.throws(
      () => parseCompactionProvider("disabled"),
      (error: unknown) => error instanceof CobConfigError && error.code === "compaction_provider_unsupported",
    );
  });

  it("accepts native provider and spawnable subagent models", () => {
    const parsed = parseCobToml(`
[compaction]
provider = "native"
model = "codex-mini"

[subagents]
models = [
  "ollama/deepseek-v4-flash:cloud",
]
`);
    assert.equal(parsed.compaction.provider, "native");
    assert.equal(parsed.compaction.model, "codex-mini");
    assert.equal(parsed.compaction.ollamaThreads, "summarize");
    assert.deepEqual(parsed.subagents.models, ["ollama/deepseek-v4-flash:cloud"]);
  });

  it("parses Ollama-thread summarize policy without reusing the native model", () => {
    const parsed = parseCobToml(`
[compaction]
provider = "native"
model = "codex-mini"
ollama_threads = "summarize"
ollama_model = "ollama/deepseek-v4-flash:0731-cloud"
`);
    assert.equal(parsed.compaction.ollamaThreads, "summarize");
    assert.equal(parsed.compaction.ollamaModel, "ollama/deepseek-v4-flash:0731-cloud");
    assert.equal(parsed.compaction.model, "codex-mini");
    assert.throws(
      () => parseOllamaCompactModel("codex-mini"),
      (error: unknown) => error instanceof CobConfigError && error.code === "invalid_compaction_ollama_model",
    );
    assert.throws(
      () => parseOllamaThreadCompaction("ollama"),
      (error: unknown) => error instanceof CobConfigError && error.code === "invalid_compaction_ollama_threads",
    );
  });

  it("parses optional compact effort and catalog context experiments without changing defaults", () => {
    const defaults = resolveCobConfig({ env: {} });
    assert.equal(defaults.compaction.ollamaEffort, undefined);
    assert.equal(defaults.catalog?.advertiseCloudMaxContext, undefined);
    assert.equal(defaults.catalog?.activeContextWindow, undefined);
    assert.equal(defaults.catalog?.autoCompactTokenLimit, undefined);
    const parsed = parseCobToml(`
[compaction]
ollama_effort = "low"

[catalog]
advertise_cloud_max_context = true
active_context_window = 256000
auto_compact_token_limit = 230400
`);
    assert.equal(parsed.compaction.ollamaEffort, "low");
    assert.equal(parsed.catalog?.advertiseCloudMaxContext, true);
    assert.equal(parsed.catalog?.activeContextWindow, 256000);
    assert.equal(parsed.catalog?.autoCompactTokenLimit, 230400);
    assert.throws(
      () => parseOllamaCompactEffort("medium"),
      (error: unknown) => error instanceof CobConfigError && error.code === "invalid_compaction_ollama_effort",
    );
    assert.throws(
      () => parseOllamaCompactEffort("xhigh"),
      (error: unknown) => error instanceof CobConfigError && error.code === "invalid_compaction_ollama_effort",
    );
  });

  it("prefers flags over env over file over default native", () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-toml-"));
    const path = join(dir, "cob.toml");
    writeCobToml(path, {
      compaction: { provider: "native", model: "codex-mini" },
      subagents: { models: ["ollama/deepseek-v4-flash:cloud"] },
    });
    const fromFile = resolveCompactionPolicy({
      paths: { cobConfig: path },
      env: {},
    });
    assert.equal(fromFile.provider, "native");
    assert.equal(fromFile.model, "codex-mini");
    const fromEnv = resolveCompactionPolicy({
      paths: { cobConfig: path },
      env: { COB_COMPACTION_MODEL: "o3" },
    });
    assert.equal(fromEnv.model, "o3");
    const fromFlag = resolveCobConfig({
      paths: { cobConfig: path },
      provider: "native",
      model: "codex-mini",
      env: { COB_COMPACTION_MODEL: "o3" },
    });
    assert.equal(fromFlag.compaction.provider, "native");
    assert.equal(fromFlag.compaction.model, "codex-mini");
  });

  it("defaults to native GPT compact and Ollama summarize", () => {
    const policy = resolveCobConfig({ env: {} });
    assert.equal(policy.compaction.provider, "native");
    assert.equal(policy.compaction.model, undefined);
    assert.equal(policy.compaction.ollamaThreads, "summarize");
    assert.equal(policy.catalog?.supportsSearchTool, true);
    assert.equal(policy.catalog?.applyPatch, false);
    assert.deepEqual(resolveSpawnableOllamaSlugs(policy), ["ollama/deepseek-v4-flash:0731-cloud"]);
  });

  it("keeps Gate 5 default-off and preserves an explicit false through render/resolve", () => {
    const defaults = parseCobToml("[catalog]\n");
    assert.equal(defaults.catalog?.applyPatch, false);
    const explicitFalse = parseCobToml("[catalog]\napply_patch = false\n");
    assert.equal(explicitFalse.catalog?.applyPatch, false);

    const dir = mkdtempSync(join(tmpdir(), "cob-toml-patch-off-"));
    const path = join(dir, "cob.toml");
    writeCobToml(path, {
      compaction: { provider: "native" },
      subagents: {},
      catalog: { supportsSearchTool: true, applyPatch: false },
    });
    assert.match(readFileSync(path, "utf8"), /apply_patch = false/);
    const resolved = resolveCobConfig({ paths: { cobConfig: path }, env: {} });
    assert.equal(resolved.catalog?.applyPatch, false);
    writeCobToml(path, resolved);
    assert.match(readFileSync(path, "utf8"), /apply_patch = false/);
  });

  it("parses and resolves Gate 5 true only when explicitly selected", () => {
    const parsed = parseCobToml("[catalog]\napply_patch = true\n");
    assert.equal(parsed.catalog?.applyPatch, true);
    const dir = mkdtempSync(join(tmpdir(), "cob-toml-patch-on-"));
    const path = join(dir, "cob.toml");
    writeCobToml(path, {
      compaction: { provider: "native" },
      subagents: {},
      catalog: { supportsSearchTool: true, applyPatch: true },
    });
    const text = readFileSync(path, "utf8");
    assert.match(text, /apply_patch = true/);
    assert.equal(resolveCobConfig({ paths: { cobConfig: path }, env: {} }).catalog?.applyPatch, true);
    assert.equal(resolveCobConfig({ paths: { cobConfig: path }, applyPatch: false, env: {} }).catalog?.applyPatch, false);
    assert.equal(resolveCobConfig({ paths: { cobConfig: path }, applyPatch: true, env: {} }).catalog?.applyPatch, true);
    assert.throws(
      () => parseCobToml("[catalog]\napply_patch = \"yes\"\n"),
      (error: unknown) => error instanceof CobConfigError && error.code === "invalid_cob_toml",
    );
  });

  it("keeps the Gate 1-3 native plaintext experiment disabled and fingerprint-gated", () => {
    const defaults = resolveCobConfig({ env: {} });
    assert.equal(defaults.experimental?.nativePlaintextSpawn.enabled, false);
    const digest = "a".repeat(64);
    const parsed = parseCobToml(`[experimental]\nnative_plaintext_spawn = true\nnative_plaintext_spawn_schema_sha256 = "${digest}"\n`);
    assert.deepEqual(parsed.experimental?.nativePlaintextSpawn, { enabled: true, schemaSha256: digest });
    const rendered = renderCobToml(parsed);
    assert.match(rendered, /native_plaintext_spawn = true/);
    assert.match(rendered, new RegExp(digest));
    assert.throws(
      () => parseCobToml(`[experimental]\nnative_plaintext_spawn_schema_sha256 = "short"\n`),
      (error: unknown) => error instanceof CobConfigError && error.code === "invalid_cob_toml",
    );
  });

  it("treats an explicit empty spawn list as none spawnable", () => {
    const parsed = parseCobToml(`[subagents]\nmodels = []\n`);
    assert.deepEqual(parsed.subagents.models, []);
    assert.deepEqual(resolveSpawnableOllamaSlugs(parsed), []);
  });

  it("round-trips write/read", () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-toml-write-"));
    const path = join(dir, "cob.toml");
    writeCobToml(path, {
      compaction: { provider: "native", model: "codex-mini" },
      subagents: { models: ["ollama/deepseek-v4-flash:cloud"] },
    });
    const text = readFileSync(path, "utf8");
    assert.match(text, /provider = "native"/);
    assert.match(text, /ollama_threads = "summarize"/);
    assert.match(text, /model = "codex-mini"/);
    assert.match(text, /ollama\/deepseek-v4-flash:cloud/);
    assert.match(text, /supports_search_tool = true/);
    const roundTrip = parseCobToml(text);
    assert.equal(roundTrip.compaction.ollamaThreads, "summarize");
    assert.equal(roundTrip.catalog?.supportsSearchTool, true);
  });

  it("honors explicit false and does not treat it as the new default", () => {
    const parsed = parseCobToml(`[catalog]\nsupports_search_tool = false\n`);
    assert.equal(parsed.catalog?.supportsSearchTool, false);
    const dir = mkdtempSync(join(tmpdir(), "cob-toml-search-off-"));
    const path = join(dir, "cob.toml");
    writeCobToml(path, {
      compaction: { provider: "native" },
      subagents: {},
      catalog: { supportsSearchTool: false, applyPatch: false },
    });
    const text = readFileSync(path, "utf8");
    assert.match(text, /supports_search_tool = false/);
    const resolved = resolveCobConfig({ paths: { cobConfig: path }, env: {} });
    assert.equal(resolved.catalog?.supportsSearchTool, false);
    writeCobToml(path, resolved);
    assert.match(readFileSync(path, "utf8"), /supports_search_tool = false/);
  });

  it("parses catalog.supports_search_tool and prefers flags over file", () => {
    const parsed = parseCobToml(`
[catalog]
supports_search_tool = true
`);
    assert.equal(parsed.catalog?.supportsSearchTool, true);
    const dir = mkdtempSync(join(tmpdir(), "cob-toml-search-"));
    const path = join(dir, "cob.toml");
    writeCobToml(path, {
      compaction: { provider: "native" },
      subagents: {},
      catalog: { supportsSearchTool: true, applyPatch: false },
    });
    const fromFile = resolveCobConfig({ paths: { cobConfig: path }, env: {} });
    assert.equal(fromFile.catalog?.supportsSearchTool, true);
    const fromEnv = resolveCobConfig({
      paths: { cobConfig: path },
      env: { COB_SUPPORTS_SEARCH_TOOL: "false" },
    });
    assert.equal(fromEnv.catalog?.supportsSearchTool, false);
    assert.throws(
      () => parseCobToml(`[catalog]\nsupports_search_tool = "yes"\n`),
      (error: unknown) => error instanceof CobConfigError && error.code === "invalid_cob_toml",
    );
  });
});
