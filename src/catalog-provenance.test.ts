import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import {
  LIVE_DESKTOP_RESTART_HINT,
  assessCatalogProvenance,
  assessV1Roster,
  discoverCodexBins,
  fileIdentityFromFs,
  parseCatalogProvenance,
  resolveCatalogSources,
  sameFileIdentity,
  shouldPrintDesktopRestartHint,
  writeCatalogProvenance,
} from "./catalog-provenance.js";
import { serializeCatalog } from "./catalog.js";
import type { CatalogFile } from "./types.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeFakeCodex(dir: string, name: string, script = "#!/bin/sh\nprintf '%s\\n' 'codex-cli test'\n"): string {
  const path = join(dir, name);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

function pickerCatalog(extra: CatalogFile["models"] = []): CatalogFile {
  return {
    models: [
      { slug: "gpt-5.6-sol", visibility: "list", priority: 0 },
      { slug: "gpt-5.6-terra", visibility: "list", priority: 1 },
      { slug: "gpt-5.6-luna", visibility: "list", priority: 2 },
      { slug: "ollama/deepseek-v4-flash:0731-cloud", visibility: "list", priority: 3 },
      ...extra,
    ],
  };
}

function ioFor(version = "codex-cli test") {
  return { readVersion: () => version };
}

describe("catalog producer selection", () => {
  it("prefers COB_CODEX_BIN override, then live Desktop, then PATH", () => {
    const dir = tempDir("cob-prov-src-");
    const override = writeFakeCodex(dir, "override");
    const desktop = writeFakeCodex(dir, "desktop");
    const pathBin = writeFakeCodex(dir, "path");
    const inspect = ioFor();

    const overrideSources = resolveCatalogSources(
      { liveHome: true, platform: "darwin", overrideBin: override, desktopBins: [desktop], pathBin },
      inspect,
    );
    assert.equal(overrideSources.producer.kind, "override");
    assert.equal(overrideSources.producer.path, realpathSync(override));

    const desktopSources = resolveCatalogSources(
      { liveHome: true, platform: "darwin", desktopBins: [desktop], pathBin },
      inspect,
    );
    assert.equal(desktopSources.producer.kind, "desktop");
    assert.equal(desktopSources.producer.path, realpathSync(desktop));

    const pathSources = resolveCatalogSources(
      { liveHome: true, platform: "darwin", desktopBins: [], pathBin },
      inspect,
    );
    assert.equal(pathSources.producer.kind, "path");
    assert.equal(pathSources.producer.path, realpathSync(pathBin));
  });

  it("keeps development homes on PATH unless Desktop is an explicit override", () => {
    const dir = tempDir("cob-prov-dev-");
    const desktop = writeFakeCodex(dir, "desktop");
    const pathBin = writeFakeCodex(dir, "path");
    const sources = resolveCatalogSources(
      { liveHome: false, platform: "darwin", desktopBins: [desktop], pathBin },
      ioFor(),
    );
    assert.equal(sources.producer.kind, "path");
    assert.equal(sources.validators.length, 1);
    assert.equal(sources.validators[0]?.kind, "path");
  });

  it("dedups the same binary reached through a symlink", () => {
    const dir = tempDir("cob-prov-link-");
    const desktop = writeFakeCodex(dir, "desktop");
    const linked = join(dir, "path-link");
    symlinkSync(desktop, linked);
    const sources = resolveCatalogSources(
      { liveHome: true, platform: "darwin", desktopBins: [desktop], pathBin: linked },
      ioFor(),
    );
    assert.equal(sources.producer.kind, "desktop");
    assert.equal(sources.validators.length, 1);
    assert.equal(sameFileIdentity(sources.producer.file, fileIdentityFromFs(linked)), true);
  });

  it("records producer and validator versions plus file identity", () => {
    const dir = tempDir("cob-prov-rec-");
    const desktop = writeFakeCodex(dir, "desktop");
    const pathBin = writeFakeCodex(dir, "path");
    const sources = resolveCatalogSources(
      { liveHome: true, platform: "darwin", desktopBins: [desktop], pathBin },
      { readVersion: (path) => (path.includes("desktop") ? "codex-cli desktop" : "codex-cli path") },
    );
    assert.equal(sources.producer.version, "codex-cli desktop");
    assert.equal(sources.validators.length, 2);
    assert.equal(sources.validators[1]?.version, "codex-cli path");
    assert.equal(typeof sources.producer.file.dev, "string");
    assert.equal(typeof sources.producer.file.ino, "string");
    assert.ok(sources.producer.file.size > 0);
  });

  it("does not scan /Applications from tests when discovery is injected", () => {
    const discovered = discoverCodexBins({
      liveHome: true,
      io: {
        platform: "linux",
        env: { PATH: "" },
        isExecutable: () => {
          throw new Error("must not stat Desktop");
        },
      },
    });
    assert.deepEqual(discovered.desktopBins, []);
    assert.equal(discovered.pathBin, undefined);
  });
});

describe("catalog provenance sidecar", () => {
  it("writes owner-only metadata after hashing catalog bytes", () => {
    const dir = tempDir("cob-prov-meta-");
    const bin = writeFakeCodex(dir, "codex");
    const sources = resolveCatalogSources(
      { liveHome: false, platform: "darwin", desktopBins: [], pathBin: bin },
      ioFor("codex-cli 0.149"),
    );
    const catalog = serializeCatalog(pickerCatalog());
    const metaPath = join(dir, "cob-catalog.meta.json");
    const meta = writeCatalogProvenance({
      metaPath,
      catalogBytes: catalog,
      sources,
      generatedAt: "2026-08-23T00:00:00.000Z",
    });
    const parsed = parseCatalogProvenance(readFileSync(metaPath, "utf8"));
    assert.deepEqual(parsed, meta);
    assert.equal(parsed.schema_version, 1);
    assert.equal(parsed.producer.kind, "path");
    assert.match(parsed.catalog_sha256, /^[0-9a-f]{64}$/);
  });

  it("treats a catalog written without a sidecar as an interrupted pair, not fresh", () => {
    const dir = tempDir("cob-prov-interrupt-");
    const catalogPath = join(dir, "cob-catalog.json");
    const metaPath = join(dir, "cob-catalog.meta.json");
    writeFileSync(catalogPath, serializeCatalog(pickerCatalog()));
    assert.equal(existsSync(metaPath), false);
    const assessment = assessCatalogProvenance({
      catalogPath,
      metaPath,
      discovery: { liveHome: false, platform: "darwin", pathBin: writeFakeCodex(dir, "codex") },
      io: ioFor(),
    });
    assert.equal(assessment.freshness, "unknown");
    assert.match(assessment.lines.join("\n"), /unknown/);
  });

  it("treats a missing sidecar as provenance unknown, not fresh", () => {
    const dir = tempDir("cob-prov-unknown-");
    const catalogPath = join(dir, "cob-catalog.json");
    writeFileSync(catalogPath, serializeCatalog(pickerCatalog()));
    const assessment = assessCatalogProvenance({
      catalogPath,
      metaPath: join(dir, "cob-catalog.meta.json"),
      discovery: { liveHome: false, platform: "darwin", pathBin: writeFakeCodex(dir, "codex") },
      io: ioFor(),
    });
    assert.equal(assessment.freshness, "unknown");
    assert.match(assessment.lines.join("\n"), /unknown/);
    assert.match(assessment.lines.join("\n"), /cob sync or cob start/);
  });

  it("reports SHA mismatch, malformed metadata, and unknown schema as stale", () => {
    const dir = tempDir("cob-prov-stale-");
    const bin = writeFakeCodex(dir, "codex");
    const catalogPath = join(dir, "cob-catalog.json");
    const metaPath = join(dir, "cob-catalog.meta.json");
    const catalog = serializeCatalog(pickerCatalog());
    writeFileSync(catalogPath, catalog);
    const sources = resolveCatalogSources(
      { liveHome: false, platform: "darwin", desktopBins: [], pathBin: bin },
      ioFor(),
    );
    writeCatalogProvenance({ metaPath, catalogBytes: catalog, sources });
    writeFileSync(catalogPath, `${catalog} `);
    assert.equal(
      assessCatalogProvenance({
        catalogPath,
        metaPath,
        discovery: { liveHome: false, platform: "darwin", pathBin: bin },
        io: ioFor(),
      }).freshness,
      "stale",
    );

    writeFileSync(metaPath, "{}\n");
    assert.equal(
      assessCatalogProvenance({
        catalogPath,
        metaPath,
        discovery: { liveHome: false, platform: "darwin", pathBin: bin },
        io: ioFor(),
      }).freshness,
      "stale",
    );

    writeFileSync(metaPath, JSON.stringify({ schema_version: 2, catalog_sha256: "ab" }));
    assert.equal(
      assessCatalogProvenance({
        catalogPath,
        metaPath,
        discovery: { liveHome: false, platform: "darwin", pathBin: bin },
        io: ioFor(),
      }).freshness,
      "stale",
    );
  });

  it("becomes stale when the producer inode/mtime/size or Desktop consumer changes", () => {
    const dir = tempDir("cob-prov-ident-");
    const bin = writeFakeCodex(dir, "codex");
    const desktop = writeFakeCodex(dir, "desktop");
    const catalogPath = join(dir, "cob-catalog.json");
    const metaPath = join(dir, "cob-catalog.meta.json");
    const catalog = serializeCatalog(pickerCatalog());
    writeFileSync(catalogPath, catalog);
    const discovery = {
      liveHome: true,
      platform: "darwin" as const,
      desktopBins: [desktop],
      pathBin: bin,
    };
    const sources = resolveCatalogSources(discovery, ioFor());
    writeCatalogProvenance({ metaPath, catalogBytes: catalog, sources });
    assert.equal(
      assessCatalogProvenance({ catalogPath, metaPath, discovery, io: ioFor() }).freshness,
      "fresh",
    );
    utimesSync(desktop, new Date(), new Date(Date.now() + 10_000));
    assert.equal(
      assessCatalogProvenance({ catalogPath, metaPath, discovery, io: ioFor() }).freshness,
      "stale",
    );
  });

  it("prints the Desktop restart hint only after a live catalog replacement", () => {
    assert.equal(shouldPrintDesktopRestartHint(true, true), true);
    assert.equal(shouldPrintDesktopRestartHint(true, false), false);
    assert.equal(shouldPrintDesktopRestartHint(false, true), false);
    assert.match(LIVE_DESKTOP_RESTART_HINT, /Fully quit and reopen ChatGPT Desktop/);
    assert.doesNotMatch(LIVE_DESKTOP_RESTART_HINT, /hot reload|app-server/);
  });
});

describe("v1 roster capacity", () => {
  it("warns at zero headroom and names omitted configured slugs in order", () => {
    const catalog: CatalogFile = {
      models: [
        { slug: "gpt-5.6-sol", visibility: "list", priority: 0 },
        { slug: "gpt-5.6-terra", visibility: "list", priority: 1 },
        { slug: "gpt-5.6-luna", visibility: "list", priority: 2 },
        { slug: "ollama/deepseek-v4-flash:0731-cloud", visibility: "list", priority: 3 },
        { slug: "ollama/deepseek-v4-flash:cloud", visibility: "list", priority: 20 },
        { slug: "ollama/extra:cloud", visibility: "list", priority: 21 },
      ],
    };
    const roster = assessV1Roster(catalog, [
      "ollama/deepseek-v4-flash:0731-cloud",
      "ollama/deepseek-v4-flash:cloud",
      "ollama/extra:cloud",
    ]);
    assert.equal(roster.headroom, 0);
    assert.equal(roster.ollamaSlots, 2);
    assert.deepEqual(roster.omitted, ["ollama/extra:cloud"]);
  });
});
