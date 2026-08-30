import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { chmodSync } from "node:fs";
import { writeFileAtomic } from "./core/atomic.js";
import {
  catalogFileIdentityKey,
  loadCatalogFile,
  resetCatalogFileCache,
  writeCatalogIfChanged,
} from "./codex/catalog/file.js";

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

describe("catalog first-write taxonomy", () => {
  const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

  it("treats only ENOENT as first write", () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-catalog-write-"));
    const path = join(dir, "cob-catalog.json");
    const wrote = writeCatalogIfChanged(path, { models: [{ slug: "gpt-first" }] });
    assert.equal(wrote, true);
    assert.deepEqual(loadCatalogFile(path).models.map((model) => model.slug), ["gpt-first"]);
    const updated = writeCatalogIfChanged(path, { models: [{ slug: "gpt-first" }] });
    assert.equal(updated, false);
    resetCatalogFileCache();
  });

  (runningAsRoot ? it.skip : it)(
    "fail-closed when an existing catalog is unreadable instead of overwriting it",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "cob-catalog-eacces-"));
      const path = join(dir, "cob-catalog.json");
      writeCatalog(path, ["gpt-keep"]);
      chmodSync(path, 0o000);
      try {
        assert.throws(
          () => writeCatalogIfChanged(path, { models: [{ slug: "gpt-drop" }] }),
          /catalog file/,
        );
        chmodSync(path, 0o600);
        const previous = readFileSync(path, "utf8");
        assert.match(previous, /gpt-keep/);
        assert.doesNotMatch(previous, /gpt-drop/);
      } finally {
        chmodSync(path, 0o600);
        resetCatalogFileCache();
      }
    },
  );
});
