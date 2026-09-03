import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolvePaths } from "./codex/paths.js";
import { configApply, configShow } from "./codex/config/control.js";
import { sha256Hex } from "./codex/catalog/source.js";
import { CobConfigError } from "./codex/config/schema.js";

describe("menu-bar config control", () => {
  it("shows a stable effective document and applies only safe fields", async () => {
    const paths = resolvePaths(mkdtempSync(join(tmpdir(), "cob-menu-config-")));
    writeFileSync(paths.rootConfig, "root = true\n");
    writeFileSync(
      paths.cobConfig,
      "[compaction]\nprovider = \"native\"\n\n[experimental]\n# preserve me\nnative_plaintext_spawn = true\n",
    );
    const before = configShow(paths, {});
    assert.equal(before.schema_version, 1);
    assert.equal(before.sources.compaction.provider, "file");
    assert.equal(before.config_revision, sha256Hex(readFileSync(paths.cobConfig)));
    const result = await configApply(
      paths,
      {
        schema_version: 1,
        expected_revision: before.config_revision,
        compaction: { ollama_threads: "native" },
        catalog: { supports_search_tool: false },
      },
      {
        ollamaUrl: "http://127.0.0.1:11434",
        env: {},
        sync: async () => ({ catalog: { models: [] }, wrote: false, ollamaCount: 0 }),
      },
    );
    assert.equal(result.config_changed, true);
    assert.equal(result.catalog_changed, false);
    assert.match(readFileSync(paths.cobConfig, "utf8"), /ollama_threads = "native"/);
    assert.match(readFileSync(paths.cobConfig, "utf8"), /native_plaintext_spawn = true/);
    assert.match(readFileSync(paths.cobConfig, "utf8"), /# preserve me/);
    assert.equal(readFileSync(paths.rootConfig, "utf8"), "root = true\n");
  });

  it("rejects stale, unknown, and environment-controlled patches before mutation", async () => {
    const paths = resolvePaths(mkdtempSync(join(tmpdir(), "cob-menu-config-guard-")));
    writeFileSync(paths.cobConfig, "[compaction]\nprovider = \"native\"\n");
    const show = configShow(paths, {});
    await assert.rejects(
      () => configApply(paths, { schema_version: 1, expected_revision: "0".repeat(64), catalog: {} }, { ollamaUrl: "http://127.0.0.1:11434", env: {} }),
      (error: unknown) => error instanceof CobConfigError && error.code === "config_conflict",
    );
    await assert.rejects(
      () => configApply(paths, { schema_version: 1, expected_revision: show.config_revision, experimental: {} }, { ollamaUrl: "http://127.0.0.1:11434", env: {} }),
      (error: unknown) => error instanceof CobConfigError && error.code === "invalid_config_patch",
    );
    await assert.rejects(
      () => configApply(paths, { schema_version: 1, expected_revision: show.config_revision, catalog: { supports_search_tool: false } }, { ollamaUrl: "http://127.0.0.1:11434", env: { COB_SUPPORTS_SEARCH_TOOL: "true" } }),
      (error: unknown) => error instanceof CobConfigError && error.code === "config_field_environment_locked",
    );
  });

  it("restores the old config when publication fails", async () => {
    const paths = resolvePaths(mkdtempSync(join(tmpdir(), "cob-menu-config-rollback-")));
    const original = "[compaction]\nprovider = \"native\"\n";
    writeFileSync(paths.cobConfig, original);
    const show = configShow(paths, {});
    await assert.rejects(() => configApply(
      paths,
      { schema_version: 1, expected_revision: show.config_revision, compaction: { ollama_threads: "native" } },
      { ollamaUrl: "http://127.0.0.1:11434", env: {}, sync: async () => { throw new Error("publication failed"); } },
    ));
    assert.equal(readFileSync(paths.cobConfig, "utf8"), original);
  });

  it("uses home-independent defaults for a new temporary config", async () => {
    const sentinelHome = mkdtempSync(join(tmpdir(), "cob-menu-live-sentinel-"));
    const sentinel = resolvePaths(sentinelHome);
    writeFileSync(sentinel.cobConfig, "[compaction]\nprovider = \"native\"\nmodel = \"sentinel-native\"\n");
    const paths = resolvePaths(mkdtempSync(join(tmpdir(), "cob-menu-new-home-")));
    const previous = process.env.COB_CODEX_HOME;
    process.env.COB_CODEX_HOME = sentinelHome;
    try {
      const result = await configApply(
        paths,
        { schema_version: 1, expected_revision: null, compaction: { ollama_threads: "native" } },
        { ollamaUrl: "http://127.0.0.1:11434", env: {}, sync: async () => ({ catalog: { models: [] }, wrote: false, ollamaCount: 0 }) },
      );
      assert.equal(result.effective.compaction.model, null);
      assert.doesNotMatch(readFileSync(paths.cobConfig, "utf8"), /sentinel-native/);
    } finally {
      if (previous === undefined) delete process.env.COB_CODEX_HOME;
      else process.env.COB_CODEX_HOME = previous;
    }
  });
});
