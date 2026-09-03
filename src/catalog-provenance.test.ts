import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import {
  LIVE_DESKTOP_RESTART_HINT,
  assessCatalogProvenance,
  assessConfiguredModels,
  ollamaDiscoveryEvidence,
  parseCatalogMetadata,
  parseCatalogProvenance,
  shouldPrintDesktopRestartHint,
  writeCatalogProvenance,
  writeCatalogValidationFailure,
} from "./codex/catalog/provenance.js";
import { OLLAMA_REVIEWED_VERSION } from "./codex/ollama-dialect.js";
import {
  discoverCodexBins,
  fileIdentityFromFs,
  resolveCatalogSources,
  sameFileIdentity,
} from "./codex/catalog/source.js";
import { serializeCatalog } from "./codex/catalog/catalog.js";
import { CatalogConsumerRejectedError } from "./codex/catalog/validator.js";
import type { CatalogFile } from "./codex/types.js";

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
    const compatible = parseCatalogMetadata(readFileSync(metaPath, "utf8"));
    assert.deepEqual(parsed, meta);
    assert.deepEqual(compatible, meta);
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

  it("stats every recorded validator without reading a Codex version", () => {
    const dir = tempDir("cob-prov-all-validators-");
    const desktop = writeFakeCodex(dir, "desktop");
    const pathBin = writeFakeCodex(dir, "path");
    const catalogPath = join(dir, "cob-catalog.json");
    const metaPath = join(dir, "cob-catalog.meta.json");
    const catalog = serializeCatalog(pickerCatalog());
    writeFileSync(catalogPath, catalog);
    const discovery = {
      liveHome: true,
      platform: "darwin" as const,
      desktopBins: [desktop],
      pathBin,
    };
    const sources = resolveCatalogSources(discovery, ioFor());
    writeCatalogProvenance({ metaPath, catalogBytes: catalog, sources });
    const statPaths: string[] = [];
    const statusIo = {
      stat: (path: string) => {
        statPaths.push(path);
        return fileIdentityFromFs(path);
      },
      readVersion: () => {
        throw new Error("status must not execute codex --version");
      },
    };
    assert.equal(
      assessCatalogProvenance({ catalogPath, metaPath, discovery, io: statusIo }).freshness,
      "fresh",
    );
    assert.ok(statPaths.includes(realpathSync(desktop)));
    assert.ok(statPaths.includes(realpathSync(pathBin)));

    utimesSync(pathBin, new Date(), new Date(Date.now() + 10_000));
    const changed = assessCatalogProvenance({ catalogPath, metaPath, discovery, io: statusIo });
    assert.equal(changed.freshness, "stale");
    assert.match(changed.lines.join("\n"), /recorded validator file identity changed/);
    assert.match(changed.lines.join("\n"), /path/);
  });

  it("persists only a redacted failed-candidate diagnostic beside a legacy catalog", () => {
    const dir = tempDir("cob-prov-failure-");
    const producer = writeFakeCodex(dir, "producer");
    const validator = writeFakeCodex(dir, "validator");
    const catalogPath = join(dir, "cob-catalog.json");
    const metaPath = join(dir, "cob-catalog.meta.json");
    const retained = serializeCatalog(pickerCatalog());
    const candidate = serializeCatalog(pickerCatalog([{ slug: "ollama/new" }]));
    writeFileSync(catalogPath, retained);
    const discovery = {
      liveHome: true,
      platform: "darwin" as const,
      desktopBins: [producer],
      pathBin: validator,
    };
    const sources = resolveCatalogSources(discovery, ioFor());
    const rejected = sources.validators.find((record) => record.path === realpathSync(validator))!;
    const error = new CatalogConsumerRejectedError(
      `Codex rejected cob catalog (path ${realpathSync(validator)} codex-cli test): supports_parallel_tool_calls token=TOP-SECRET-VALUE`,
      rejected,
    );
    writeCatalogValidationFailure({
      metaPath,
      candidateBytes: candidate,
      retainedCatalogBytes: retained,
      retainedMetadataBytes: null,
      sources,
      error,
      failedAt: "2026-08-23T00:00:00.000Z",
    });
    const raw = readFileSync(metaPath, "utf8");
    const metadata = parseCatalogMetadata(raw);
    assert.equal(metadata.schema_version, 2);
    assert.equal(metadata.schema_version === 2 ? metadata.active.state : "", "unknown");
    assert.equal(
      metadata.schema_version === 2 ? metadata.last_failure?.rejected_validator?.path : undefined,
      realpathSync(validator),
    );
    assert.match(
      metadata.schema_version === 2 ? (metadata.last_failure?.diagnostic.summary ?? "") : "",
      /supports_parallel_tool_calls/,
    );
    assert.doesNotMatch(raw, /TOP-SECRET-VALUE/);
    assert.equal(existsSync(metaPath), true);

    const failedValidatorStats: string[] = [];
    const assessment = assessCatalogProvenance({
      catalogPath,
      metaPath,
      discovery,
      io: {
        stat: (path: string) => {
          failedValidatorStats.push(path);
          return fileIdentityFromFs(path);
        },
        readVersion: () => {
          throw new Error("status must not execute Codex");
        },
      },
    });
    assert.equal(assessment.freshness, "unknown");
    assert.match(assessment.lines.join("\n"), /last candidate validation: failed/);
    assert.match(assessment.lines.join("\n"), /legacy catalog had no cob-catalog\.meta\.json/);
    assert.doesNotMatch(assessment.lines.join("\n"), /TOP-SECRET-VALUE/);
    assert.ok(failedValidatorStats.includes(realpathSync(producer)));
    assert.ok(failedValidatorStats.includes(realpathSync(validator)));
  });

  it("marks an otherwise fresh retained pair stale after candidate validation fails", () => {
    const dir = tempDir("cob-prov-retained-failure-");
    const bin = writeFakeCodex(dir, "codex");
    const catalogPath = join(dir, "cob-catalog.json");
    const metaPath = join(dir, "cob-catalog.meta.json");
    const catalog = serializeCatalog(pickerCatalog());
    writeFileSync(catalogPath, catalog);
    const discovery = { liveHome: false, platform: "darwin" as const, pathBin: bin };
    const sources = resolveCatalogSources(discovery, ioFor());
    writeCatalogProvenance({ metaPath, catalogBytes: catalog, sources });
    writeCatalogValidationFailure({
      metaPath,
      candidateBytes: `${catalog} `,
      retainedCatalogBytes: catalog,
      retainedMetadataBytes: readFileSync(metaPath),
      sources,
      error: new Error(`Codex rejected cob catalog (path ${realpathSync(bin)} codex-cli test)`),
    });
    const assessment = assessCatalogProvenance({
      catalogPath,
      metaPath,
      discovery,
    });
    assert.equal(assessment.freshness, "stale");
    assert.match(assessment.lines[0] ?? "", /last candidate validation failed/);
    assert.match(assessment.lines.join("\n"), /last known-good catalog retained/);

    writeCatalogProvenance({ metaPath, catalogBytes: catalog, sources });
    assert.equal(parseCatalogMetadata(readFileSync(metaPath, "utf8")).schema_version, 1);
    assert.equal(
      assessCatalogProvenance({ catalogPath, metaPath, discovery }).freshness,
      "fresh",
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

describe("Ollama discovery evidence in the sidecar", () => {
  const TS = "2026-08-31T00:00:00.000Z";
  const SPAWNABLE = "deepseek-v4-flash:0731-cloud";

  function sidecar(path: string): { schema_version: number; ollama_discovery?: Record<string, unknown> } {
    return JSON.parse(readFileSync(path, "utf8"));
  }

  function writeSidecar(
    dir: string,
    opts: { error?: string; tagNames?: { name: string; capabilities?: string[] }[] },
  ): { metaPath: string; catalogPath: string; discovery: { liveHome: false; platform: "darwin"; pathBin: string } } {
    const bin = writeFakeCodex(dir, "codex");
    const sources = resolveCatalogSources(
      { liveHome: false, platform: "darwin", desktopBins: [], pathBin: bin },
      ioFor(),
    );
    const catalog = serializeCatalog(pickerCatalog());
    const catalogPath = join(dir, "cob-catalog.json");
    writeFileSync(catalogPath, catalog);
    const metaPath = join(dir, "cob-catalog.meta.json");
    writeCatalogProvenance({
      metaPath,
      catalogBytes: catalog,
      sources,
      generatedAt: TS,
      ollamaDiscovery: ollamaDiscoveryEvidence({
        tags: opts.tagNames ?? [],
        spawnable: [SPAWNABLE],
        error: opts.error,
        observedAt: TS,
      }),
    });
    return { metaPath, catalogPath, discovery: { liveHome: false, platform: "darwin" as const, pathBin: bin } };
  }

  it("persists degraded discovery as a future-facing schema with a stable code and no raw upstream text", () => {
    const dir = tempDir("cob-prov-ollama-degraded-");
    const { metaPath } = writeSidecar(dir, { error: "connect ECONNREFUSED 127.0.0.1:43451" });
    const raw = readFileSync(metaPath, "utf8");
    const meta = sidecar(metaPath);
    assert.equal(meta.schema_version, 3);
    const evidence = meta.ollama_discovery as Record<string, unknown>;
    assert.equal(evidence.state, "degraded");
    assert.equal(String(evidence.observed_at), TS);
    assert.equal(evidence.tag_count, 0);
    assert.equal(evidence.missing_spawn_count, 1);
    assert.deepEqual(evidence.diagnostic, { code: "tags_unreachable" });
    assert.doesNotMatch(raw, /ECONNREFUSED|43451/);
    // Round-trips through the strict metadata parser.
    const parsed = parseCatalogMetadata(raw);
    assert.equal(parsed.schema_version, 3);
    const polluted = JSON.parse(raw) as Record<string, unknown>;
    (polluted.ollama_discovery as Record<string, unknown>).unexpectedKey = "unexpected";
    writeFileSync(metaPath, `${JSON.stringify(polluted)}\n`);
    const reparsed = parseCatalogMetadata(readFileSync(metaPath, "utf8")) as {
      schema_version: number;
      ollama_discovery?: Record<string, unknown>;
    };
    assert.equal(reparsed.schema_version, 3);
    assert.equal("unexpectedKey" in (reparsed.ollama_discovery ?? {}), false);
  });

  it("records fresh success evidence beside schema 1 with a capability digest that excludes model names", () => {
    const dir = tempDir("cob-prov-ollama-success-");
    const { metaPath } = writeSidecar(dir, {
      tagNames: [
        { name: "deepseek-v4-flash:0731-cloud", capabilities: ["tools"] },
        { name: "some-local-model", capabilities: ["tools", "thinking"] },
      ],
    });
    const meta = sidecar(metaPath);
    assert.equal(meta.schema_version, 1);
    const evidence = meta.ollama_discovery as Record<string, unknown>;
    assert.equal(evidence.state, "success");
    assert.equal(evidence.tag_count, 2);
    assert.equal(evidence.missing_spawn_count, 0);
    assert.equal(evidence.dialect_revision, OLLAMA_REVIEWED_VERSION);
    assert.equal(evidence.diagnostic, undefined);
    assert.match(String(evidence.capability_digest), /^[0-9a-f]{64}$/);
    // The digest must not depend on model names.
    const other = ollamaDiscoveryEvidence({
      tags: [
        { name: "renamed-model", capabilities: ["tools"] },
        { name: "another-name", capabilities: ["tools", "thinking"] },
      ],
      spawnable: [SPAWNABLE],
      observedAt: TS,
    });
    assert.equal(other.capability_digest, evidence.capability_digest);
  });

  it("classifies tag discovery errors into stable codes", () => {
    const evidenceOf = (error: string) =>
      ollamaDiscoveryEvidence({ tags: [], spawnable: [SPAWNABLE], error, observedAt: TS });
    assert.equal(evidenceOf("Ollama /api/tags timed out after 5000ms").diagnostic?.code, "tags_timeout");
    assert.equal(evidenceOf("Ollama /api/tags failed: 503 Service Unavailable").diagnostic?.code, "tags_http_503");
    assert.equal(evidenceOf("Ollama /api/tags returned a malformed body").diagnostic?.code, "tags_malformed");
    assert.equal(evidenceOf("Ollama /api/tags returned an unexpected payload").diagnostic?.code, "tags_malformed");
    assert.equal(evidenceOf("fetch failed").diagnostic?.code, "tags_unreachable");
    for (const error of ["anything raw", "Authorization: sk-secret"]) {
      const raw = JSON.stringify(ollamaDiscoveryEvidence({ tags: [], spawnable: [SPAWNABLE], error, observedAt: TS }));
      assert.doesNotMatch(raw, /raw|sk-secret/);
    }
  });

  it("status separates Codex provenance freshness from Ollama discovery state", () => {
    const dir = tempDir("cob-prov-ollama-status-");
    const { catalogPath, metaPath, discovery } = writeSidecar(dir, {
      error: "Ollama /api/tags timed out after 5000ms",
    });
    const assess = () =>
      assessCatalogProvenance({ catalogPath, metaPath, discovery });

    const degraded = assess();
    assert.equal(degraded.freshness, "fresh");
    const degradedLines = degraded.lines.join("\n");
    assert.match(degradedLines, /ollama discovery: degraded \(tags_timeout\)/);
    assert.doesNotMatch(degradedLines, /5000ms/);

    // Recovery records fresh Ollama evidence again without touching Codex provenance.
    const bin = join(dir, "codex");
    const sources = resolveCatalogSources(
      { liveHome: false, platform: "darwin", desktopBins: [], pathBin: bin },
      ioFor(),
    );
    writeCatalogProvenance({
      metaPath,
      catalogBytes: readFileSync(catalogPath),
      sources,
      generatedAt: TS,
      ollamaDiscovery: ollamaDiscoveryEvidence({
        tags: [{ name: SPAWNABLE, capabilities: ["tools"] }],
        spawnable: [SPAWNABLE],
        observedAt: TS,
      }),
    });
    const recovered = assess();
    assert.equal(recovered.freshness, "fresh");
    const recoveredLines = recovered.lines.join("\n");
    assert.match(recoveredLines, /ollama discovery: success \(1 tag\)/);
    assert.doesNotMatch(recoveredLines, /degraded/);
  });

  it("fails closed when degraded sidecar evidence is missing or the schema is unsupported", () => {
    const dir = tempDir("cob-prov-ollama-bad-");
    const { catalogPath, metaPath, discovery } = writeSidecar(dir, {
      error: "connect ECONNREFUSED 127.0.0.1:1",
    });
    const assess = () =>
      assessCatalogProvenance({ catalogPath, metaPath, discovery });
    const json = sidecar(metaPath) as Record<string, unknown>;

    delete json.ollama_discovery;
    writeFileSync(metaPath, `${JSON.stringify(json)}\n`);
    assert.throws(() => parseCatalogMetadata(readFileSync(metaPath, "utf8")));
    assert.equal(assess().freshness, "stale");

    json.schema_version = 4;
    writeFileSync(metaPath, `${JSON.stringify(json)}\n`);
    assert.throws(() => parseCatalogMetadata(readFileSync(metaPath, "utf8")));
    assert.equal(assess().freshness, "stale");
  });

  it("rejects degraded evidence recorded under schema 1 where schema 3 is required", () => {
    const dir = tempDir("cob-prov-schema1-degraded-");
    const { catalogPath, metaPath, discovery } = writeSidecar(dir, {
      error: "connect ECONNREFUSED 127.0.0.1:1",
    });
    const json = sidecar(metaPath) as Record<string, unknown>;
    json.schema_version = 1;
    writeFileSync(metaPath, `${JSON.stringify(json)}\n`);
    assert.throws(() => parseCatalogMetadata(readFileSync(metaPath, "utf8")));
    assert.equal(
      assessCatalogProvenance({ catalogPath, metaPath, discovery }).freshness,
      "stale",
    );
  });

  it("preserves degraded discovery evidence through validation-failure retention", () => {
    const dir = tempDir("cob-prov-degraded-retained-");
    const { catalogPath, metaPath, discovery } = writeSidecar(dir, {
      error: "Ollama /api/tags timed out after 5000ms",
    });
    const sources = resolveCatalogSources(discovery, ioFor());
    writeCatalogValidationFailure({
      metaPath,
      candidateBytes: readFileSync(catalogPath),
      retainedCatalogBytes: readFileSync(catalogPath),
      retainedMetadataBytes: readFileSync(metaPath),
      sources,
      error: new Error(`Codex rejected cob catalog (path ${realpathSync(sources.producer.path)} codex-cli test)`),
    });
    const assessment = assessCatalogProvenance({ catalogPath, metaPath, discovery });
    // Human lines and the JSON evidence field stay in parity across the
    // validation-failure state; safe degraded evidence is not converted away.
    assert.equal(assessment.freshness, "stale");
    assert.match(assessment.lines.join("\n"), /ollama discovery: degraded \(tags_timeout\)/);
    assert.equal(assessment.discovery_evidence?.state, "degraded");
    assert.equal(assessment.discovery_evidence?.diagnostic?.code, "tags_timeout");
  });
});

describe("configured model visibility", () => {
  it("keeps every configured model visible beyond five picker rows", () => {
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
    const assessment = assessConfiguredModels(catalog, [
      "ollama/deepseek-v4-flash:0731-cloud",
      "ollama/deepseek-v4-flash:cloud",
      "ollama/extra:cloud",
    ]);
    assert.equal(assessment.listed.length, 6);
    assert.deepEqual(assessment.configured, [
      "ollama/deepseek-v4-flash:0731-cloud",
      "ollama/deepseek-v4-flash:cloud",
      "ollama/extra:cloud",
    ]);
    assert.deepEqual(assessment.missing, []);
  });
});
