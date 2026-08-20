import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderCobProfile } from "./profile.js";
import { restoreCob } from "./lifecycle.js";
import { resolvePaths } from "./paths.js";

describe("cob profile", () => {
  it("pins openai provider, keeps V1 child spawn, and enables native remote compaction v2", () => {
    const text = renderCobProfile({
      port: 18790,
      catalogPath: "/Users/gencberke/.codex/cob-catalog.json",
    });
    assert.match(text, /^model_provider = "openai"$/m);
    assert.match(text, /^openai_base_url = "http:\/\/127\.0\.0\.1:18790\/v1"$/m);
    assert.match(text, /multi_agent_v2 = false/);
    assert.match(text, /remote_compaction_v2 = true/);
    assert.doesNotMatch(text, /\[model_providers/);
  });

  it("restore deletes overlay files and leaves root config bytes identical", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-profile-"));
    const paths = resolvePaths(dir);
    const original = 'model = "gpt-5.6-luna"\n[features]\nmulti_agent_v2 = false\n';
    writeFileSync(paths.rootConfig, original);
    writeFileSync(paths.profile, "stale\n");
    writeFileSync(paths.catalog, "{}\n");
    writeFileSync(paths.cobConfig, "[compaction]\nprovider = \"native\"\n");
    const result = await restoreCob(paths);
    assert.equal(result.rootConfigUnchanged, true);
    assert.equal(readFileSync(paths.rootConfig, "utf8"), original);
    assert.throws(() => readFileSync(paths.profile));
    assert.throws(() => readFileSync(paths.catalog));
    assert.throws(() => readFileSync(paths.cobConfig));
  });
});
