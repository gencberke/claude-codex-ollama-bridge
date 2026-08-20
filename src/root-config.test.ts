import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessDesktopOverlay,
  loadRootTomlKeys,
  openaiPortFromToml,
  parseLoopbackBaseUrl,
  parseRootTomlKeys,
  sameFilesystemPath,
  type DesktopOverlayInput,
} from "./root-config.js";

const catalog = "/Users/gencberke/.codex/cob-catalog.json";
const home = "/Users/gencberke/.codex";

function assess(partial: Partial<DesktopOverlayInput> & Pick<DesktopOverlayInput, "keys">) {
  return assessDesktopOverlay({
    cobCatalogPath: catalog,
    cobCatalogExists: true,
    codexHome: home,
    gatewayHealthy: true,
    runtimePort: 18790,
    ...partial,
  });
}

describe("root config.toml parser", () => {
  it("reads cob overlay keys at true root and ignores later tables", () => {
    const keys = parseRootTomlKeys(`
notify = ["/Applications/ChatGPT.app", "turn-ended"]
model = "ollama/deepseek-v4-flash:0731-cloud"
model_reasoning_effort = "medium"
# cob desktop trial
model_provider = "openai"
openai_base_url = "http://127.0.0.1:18790/v1"
model_catalog_json = "/Users/gencberke/.codex/cob-catalog.json"

[features]
remote_compaction_v2 = true
model_provider = "stolen"
openai_base_url = "https://example.invalid/v1"
model_catalog_json = "/tmp/not-cob.json"
`);
    assert.equal(keys.model_provider, "openai");
    assert.equal(keys.openai_base_url, "http://127.0.0.1:18790/v1");
    assert.equal(keys.model_catalog_json, catalog);
    assert.equal(keys.profile, undefined);
  });

  it("does not treat keys after the first table as root overlay", () => {
    const keys = parseRootTomlKeys(`
[features]
model_provider = "openai"
openai_base_url = "http://127.0.0.1:18790/v1"
model_catalog_json = "/Users/gencberke/.codex/cob-catalog.json"
`);
    assert.deepEqual(keys, {});
  });

  it("keeps a hash inside a quoted string and last-wins duplicate root keys", () => {
    const keys = parseRootTomlKeys(`
model_provider = "ollama" # stale
model_provider = "openai"
openai_base_url = "http://127.0.0.1:1/v1"
openai_base_url = "http://127.0.0.1:18790/v1"
model_catalog_json = "/tmp/foo#bar.json"
`);
    assert.equal(keys.model_provider, "openai");
    assert.equal(keys.openai_base_url, "http://127.0.0.1:18790/v1");
    assert.equal(keys.model_catalog_json, "/tmp/foo#bar.json");
  });

  it("skips a multiline root array without swallowing later keys", () => {
    const keys = parseRootTomlKeys(`
notify = [
  "/Applications/ChatGPT.app",
  "turn-ended",
]
openai_base_url = "http://127.0.0.1:18790/v1"
`);
    assert.equal(keys.openai_base_url, "http://127.0.0.1:18790/v1");
  });

  it("returns ENOENT as missing keys, not unreadable", () => {
    const loaded = loadRootTomlKeys(join(tmpdir(), "cob-missing-root-config.toml"));
    assert.equal(loaded.readError, undefined);
    assert.equal(loaded.keys, null);
  });

  it("reads the openai port from a cob profile", () => {
    assert.equal(
      openaiPortFromToml(`model_provider = "openai"\nopenai_base_url = "http://127.0.0.1:19999/v1"\n`),
      19999,
    );
  });
});

describe("desktop overlay assessment", () => {
  it("is ok when root keys match the live gateway and cob catalog", () => {
    const result = assess({
      keys: {
        model_provider: "openai",
        openai_base_url: "http://127.0.0.1:18790/v1",
        model_catalog_json: catalog,
      },
    });
    assert.equal(result.state, "ok");
    assert.match(result.lines[0] ?? "", /^desktop overlay: ok$/);
    assert.equal(result.lines.some((line) => /backup/.test(line)), false);
  });

  it("is ready when the overlay is correct but the gateway is down", () => {
    const result = assess({
      keys: {
        model_provider: "openai",
        openai_base_url: "http://127.0.0.1:18790/v1",
        model_catalog_json: catalog,
      },
      gatewayHealthy: false,
      runtimePort: undefined,
      profilePort: 18790,
    });
    assert.equal(result.state, "ready");
    assert.match(result.lines[0] ?? "", /gateway stopped; run cob start/);
  });

  it("reports missing overlay keys without writing a restore path cob owns", () => {
    const result = assess({ keys: {}, runtimePort: 18790 });
    assert.equal(result.state, "broken");
    const text = result.lines.join("\n");
    assert.match(text, /openai_base_url is missing/);
    assert.match(text, /model_catalog_json is missing/);
    assert.match(text, /cob restore does not revert config.toml/);
  });

  it("treats a non-openai provider and a wrong port as broken", () => {
    const result = assess({
      keys: {
        model_provider: "ollama",
        openai_base_url: "http://127.0.0.1:19999/v1",
        model_catalog_json: catalog,
      },
      runtimePort: 18790,
    });
    assert.equal(result.state, "broken");
    const text = result.lines.join("\n");
    assert.match(text, /model_provider = "ollama"/);
    assert.match(text, /port 19999 does not match live gateway on 18790/);
  });

  it("compares the port to cob.config.toml when no runtime exists", () => {
    const result = assess({
      keys: {
        openai_base_url: "http://127.0.0.1:18790/v1",
        model_catalog_json: catalog,
      },
      runtimePort: undefined,
      profilePort: 19999,
      gatewayHealthy: false,
    });
    assert.equal(result.state, "broken");
    assert.match(result.lines.join("\n"), /does not match cob\.config\.toml port 19999/);
  });

  it("flags a catalog path that is not the cob catalog", () => {
    const result = assess({
      keys: {
        openai_base_url: "http://127.0.0.1:18790/v1",
        model_catalog_json: "/tmp/other-catalog.json",
      },
    });
    assert.equal(result.state, "broken");
    assert.match(result.lines.join("\n"), /not the cob catalog/);
  });

  it("does not tell the user to restore a backup when only the cob catalog file is missing", () => {
    const result = assess({
      keys: {
        openai_base_url: "http://127.0.0.1:18790/v1",
        model_catalog_json: catalog,
      },
      cobCatalogExists: false,
    });
    assert.equal(result.state, "broken");
    const text = result.lines.join("\n");
    assert.match(text, /cob catalog file is missing/);
    assert.doesNotMatch(text, /Restore your backup/);
  });

  it("warns that root profile = cob is ignored", () => {
    const result = assess({
      keys: {
        openai_base_url: "http://127.0.0.1:18790/v1",
        model_catalog_json: catalog,
        profile: "cob",
      },
    });
    assert.equal(result.state, "ok");
    assert.match(result.lines.join("\n"), /profile = "cob" is ignored/);
  });

  it("reports absent and unreadable root configs", () => {
    assert.equal(assess({ keys: null }).state, "absent");
    assert.equal(assess({ keys: null, readError: "EACCES" }).state, "unreadable");
  });

  it("rejects a non-loopback openai_base_url", () => {
    const parsed = parseLoopbackBaseUrl("https://chatgpt.com/v1");
    assert.equal(parsed.ok, false);
    const result = assess({
      keys: {
        openai_base_url: "https://chatgpt.com/v1",
        model_catalog_json: catalog,
      },
    });
    assert.equal(result.state, "broken");
    assert.match(result.lines.join("\n"), /must be loopback/);
  });

  it("treats ~ and relative catalog paths as the cob catalog", () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-root-path-"));
    const catalogPath = join(dir, "cob-catalog.json");
    writeFileSync(catalogPath, "{}\n");
    assert.equal(sameFilesystemPath("cob-catalog.json", catalogPath, dir), true);
    const tilde = `~/.codex/cob-catalog.json`;
    const homeCatalog = join(homedir(), ".codex", "cob-catalog.json");
    assert.equal(sameFilesystemPath(tilde, homeCatalog, homedir()), true);
  });
});
