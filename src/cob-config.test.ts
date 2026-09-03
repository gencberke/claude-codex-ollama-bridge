import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CobConfigError,
  parseCompactionProvider,
  parseOllamaCompactEffort,
  parseOllamaCompactModel,
  parseOllamaThreadCompaction,
} from "./codex/config/schema.js";
import { parseCobToml, readCobToml, renderCobToml, writeCobToml } from "./codex/config/toml.js";
import { resolveCobConfig, resolveCompactionPolicy, resolveSpawnableOllamaSlugs } from "./codex/config/resolve.js";

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

  it("round-trips native picker include/exclude overrides and accepts env overrides", () => {
    const parsed = parseCobToml(`
[catalog]
native_include = ["gpt-next-codex"]
native_exclude = [
  "gpt-legacy",
]
`);
    assert.deepEqual(parsed.catalog?.nativeInclude, ["gpt-next-codex"]);
    assert.deepEqual(parsed.catalog?.nativeExclude, ["gpt-legacy"]);
    const rendered = renderCobToml(parsed);
    assert.deepEqual(parseCobToml(rendered).catalog?.nativeInclude, ["gpt-next-codex"]);
    assert.deepEqual(parseCobToml(rendered).catalog?.nativeExclude, ["gpt-legacy"]);

    const fromEnv = resolveCobConfig({
      env: {
        COB_NATIVE_MODEL_INCLUDE: "gpt-a,gpt-b",
        COB_NATIVE_MODEL_EXCLUDE: "gpt-c",
      },
    });
    assert.deepEqual(fromEnv.catalog?.nativeInclude, ["gpt-a", "gpt-b"]);
    assert.deepEqual(fromEnv.catalog?.nativeExclude, ["gpt-c"]);
    const dir = mkdtempSync(join(tmpdir(), "cob-native-models-"));
    const path = join(dir, "cob.toml");
    writeCobToml(path, parsed);
    const envOverFile = resolveCobConfig({
      paths: { cobConfig: path },
      env: {
        COB_NATIVE_MODEL_INCLUDE: "gpt-env",
        COB_NATIVE_MODEL_EXCLUDE: "gpt-env-old",
      },
    });
    assert.deepEqual(envOverFile.catalog?.nativeInclude, ["gpt-env"]);
    assert.deepEqual(envOverFile.catalog?.nativeExclude, ["gpt-env-old"]);
    assert.throws(
      () => parseCobToml('[catalog]\nnative_include = ["ollama/not-native"]\n'),
      (error: unknown) => error instanceof CobConfigError && error.code === "invalid_native_slug",
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

describe("strict cob.toml grammar", () => {
  it("keeps # inside quotes and strips unquoted comments", () => {
    const parsed = parseCobToml('[compaction] # section comment\nmodel = "codex-#mini" # value comment\n');
    assert.equal(parsed.compaction.model, "codex-#mini");
    assert.throws(
      () => parseCobToml('[subagents]\nmodels = ["ollama/a", ollama/b] # trailing\n'),
      (error: unknown) => error instanceof CobConfigError && error.code === "invalid_cob_toml",
    );
  });

  it("keeps a multiline string array and parses escaped quotes", () => {
    const parsed = parseCobToml('[subagents]\nmodels = [\n  "ollama/say-\\"hi\\":cloud",\n]\n');
    assert.deepEqual(parsed.subagents.models, ['ollama/say-"hi":cloud']);
    assert.throws(
      () => parseCobToml('[compaction]\nmodel = "unterminated\n'),
      (error: unknown) => error instanceof CobConfigError && error.code === "invalid_cob_toml",
    );
  });

  it("fails closed on duplicate keys, malformed headers, unknown keys, and stray lines", () => {
    const cases: [string, RegExp][] = [
      ['[catalog]\napply_patch = true\napply_patch = false\n', /duplicate key/],
      ['[compaction\nprovider = "native"\n', /malformed table header/],
      ['[nonsense]\nnope = true\n', /unknown section/],
      ['[catalog]\nnope = true\n', /unknown key/],
      ['just some text\n', /key = value/],
      ['model = "codex-mini"\n', /before any table header/],
      ['[catalog]\napply_patch = notbool\n', /must be a quoted string, boolean, or integer/],
      ['[catalog]\napply_patch = "true"\n', /apply_patch must be a bare true or false/],
      ['[catalog]\napply_patch = 1\n', /apply_patch must be a bare true or false/],
      ['[catalog]\nactive_context_window = "123"\n', /active_context_window must be a bare positive integer/],
      ['[compaction]\nmodel = true\n', /compaction.model must be a quoted string/],
      ['[subagents]\nmodels = "ollama/deepseek-v4-flash:cloud"\n', /must be an array/],
      ['[catalog]\napply_patch = ["true"]\n', /must not be an array/],
      ['[catalog]\napply_patch = [\n  "true",\n]\n', /must not be an array/],
      ['[subagents]\nmodels = [\n  "ollama/a"\n]\n', /must end with a comma/],
      ['[subagents]\nmodels = ["ollama/a",, "ollama/b"]\n', /empty item/],
    ];
    for (const [text, pattern] of cases) {
      assert.throws(
        () => parseCobToml(text),
        (error: unknown) => error instanceof CobConfigError && pattern.test(error.message),
        text,
      );
    }
  });
});

describe("shared ollama slug validator", () => {
  it("rejects non-ollama slugs from the file config", () => {
    const cases: [string, RegExp][] = [
      ['[subagents]\nmodels = ["ollama/"]\n', /model id after ollama\//],
      ['[subagents]\nmodels = ["codex-mini"]\n', /not the native slug/],
      ['[subagents]\nmodels = [" ollama/deepseek-v4-flash:cloud "]\n', /surrounding whitespace/],
      ['[subagents]\nmodels = ["ollama/a\\u0007"]\n', /whitespace or control characters/],
      ['[subagents]\nmodels = ["ollama/a", "ollama/a"]\n', /duplicate spawn model/],
    ];
    for (const [text, pattern] of cases) {
      assert.throws(
        () => parseCobToml(text),
        (error: unknown) => error instanceof CobConfigError && pattern.test(error.message),
        text,
      );
    }
    assert.throws(
      () => parseCobToml('[compaction]\nollama_model = "codex-mini"\n'),
      (error: unknown) => error instanceof CobConfigError && error.code === "invalid_compaction_ollama_model",
    );
    assert.throws(
      () => parseCobToml('[compaction]\nollama_model = " ollama/a "\n'),
      (error: unknown) =>
        error instanceof CobConfigError &&
        error.code === "invalid_compaction_ollama_model" &&
        /surrounding whitespace/.test(error.message),
    );
  });

  it("validates COB_SUBAGENT_MODELS the same way as the file config", () => {
    assert.throws(
      () => resolveCobConfig({ env: { COB_SUBAGENT_MODELS: "codex-mini,ollama/deepseek-v4-flash:cloud" } }),
      (error: unknown) => error instanceof CobConfigError && error.code === "invalid_ollama_slug",
    );
    assert.throws(
      () => resolveCobConfig({ env: { COB_SUBAGENT_MODELS: "ollama/a,ollama/a" } }),
      (error: unknown) => error instanceof CobConfigError && /duplicate spawn model/.test(error.message),
    );
    assert.throws(
      () => resolveCobConfig({ env: { COB_SUBAGENT_MODELS: " ollama/a" } }),
      (error: unknown) =>
        error instanceof CobConfigError &&
        error.code === "invalid_ollama_slug" &&
        /surrounding whitespace/.test(error.message),
    );
    assert.throws(
      () => resolveCobConfig({ env: { COB_SUBAGENT_MODELS: "ollama/a,,ollama/b" } }),
      (error: unknown) => error instanceof CobConfigError && error.code === "invalid_ollama_slug",
    );
    assert.throws(
      () => resolveCobConfig({ env: { COB_COMPACTION_OLLAMA_MODEL: " ollama/a " } }),
      (error: unknown) =>
        error instanceof CobConfigError &&
        error.code === "invalid_compaction_ollama_model" &&
        /surrounding whitespace/.test(error.message),
    );
    const ok = resolveCobConfig({ env: { COB_SUBAGENT_MODELS: "ollama/a,ollama/b" } });
    assert.deepEqual(ok.subagents.models, ["ollama/a", "ollama/b"]);
  });
});

describe("readCobToml fail-closed I/O", () => {
  it("treats a missing file as the default-config case", () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-toml-missing-"));
    assert.equal(readCobToml(join(dir, "cob.toml")), undefined);
  });

  it("fails closed with a typed error when cob.toml exists but cannot be read", () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-toml-eisdir-"));
    const path = join(dir, "cob.toml");
    writeCobToml(path, { compaction: { provider: "native" }, subagents: {} });
    try {
      readCobToml(dir);
      assert.fail("expected EISDIR");
    } catch (error) {
      assert.equal(error instanceof CobConfigError, true);
      assert.equal((error as CobConfigError).code, "cob_config_read_failed");
      const message = (error as CobConfigError).message;
      assert.match(message, /EISDIR/);
      assert.match(message, /cob\.toml|toml-eisdir/);
      assert.equal(message.includes("provider"), false);
    }
    const clutter = join(dir, "cob.toml");
    assert.throws(
      () => readCobToml(join(clutter, "nested", "cob.toml")),
      (error: unknown) => error instanceof CobConfigError && error.code === "cob_config_read_failed",
    );
  });
});
