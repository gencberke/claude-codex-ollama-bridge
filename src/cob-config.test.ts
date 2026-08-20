import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CobConfigError,
  parseCobToml,
  parseCompactionProvider,
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
    assert.equal(policy.catalog?.supportsSearchTool, false);
    assert.deepEqual(resolveSpawnableOllamaSlugs(policy), ["ollama/deepseek-v4-flash:0731-cloud"]);
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
    assert.match(text, /supports_search_tool = false/);
    const roundTrip = parseCobToml(text);
    assert.equal(roundTrip.compaction.ollamaThreads, "summarize");
    assert.equal(roundTrip.catalog?.supportsSearchTool, false);
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
      catalog: { supportsSearchTool: true },
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
