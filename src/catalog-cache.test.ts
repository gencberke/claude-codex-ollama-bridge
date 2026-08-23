import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { writeFileAtomic } from "./atomic.js";
import {
  catalogFileIdentityKey,
  loadCatalogFile,
  resetCatalogFileCache,
} from "./catalog.js";

function writeCatalog(path: string, slugs: string[]): void {
  writeFileSync(path, `${JSON.stringify({ models: slugs.map((slug) => ({ slug })) })}\n`);
}

describe("catalog file identity cache", () => {
  it("reuses the parsed catalog on an unchanged identity and reloads after replace", () => {
    resetCatalogFileCache();
    const dir = mkdtempSync(join(tmpdir(), "cob-catalog-cache-"));
    const path = join(dir, "cob-catalog.json");
    writeCatalog(path, ["gpt-old"]);
    const first = loadCatalogFile(path);
    const firstIdentity = catalogFileIdentityKey(path);
    const second = loadCatalogFile(path);
    assert.equal(second, first);
    assert.equal(catalogFileIdentityKey(path), firstIdentity);
    assert.deepEqual(first.models.map((model) => model.slug), ["gpt-old"]);

    writeFileAtomic(path, `${JSON.stringify({ models: [{ slug: "gpt-old" }, { slug: "gpt-new" }] })}\n`);
    const replaced = loadCatalogFile(path);
    assert.notEqual(replaced, first);
    assert.deepEqual(
      replaced.models.map((model) => model.slug),
      ["gpt-old", "gpt-new"],
    );

    writeCatalog(path, ["gpt-rewritten"]);
    const rewritten = loadCatalogFile(path);
    assert.deepEqual(rewritten.models.map((model) => model.slug), ["gpt-rewritten"]);

    writeFileSync(path, "not-json");
    assert.throws(() => loadCatalogFile(path), /catalog JSON|JSON/);

    rmSync(path);
    assert.throws(() => loadCatalogFile(path));
    writeCatalog(path, ["gpt-restored"]);
    const restored = loadCatalogFile(path);
    assert.deepEqual(restored.models.map((model) => model.slug), ["gpt-restored"]);
    resetCatalogFileCache();
    mkdirSync(dir, { recursive: true });
  });
});
