/**
 * WP1.4 safe isolated outage canary. Agent-owned temporary Codex homes only.
 * The real ~/.codex home is resolved independently of environment overrides
 * and is read-only: config/catalog/sidecar hashes are taken before and after
 * the run to prove no live mutation. Not part of `npm test`; excluded from
 * the pack via the eval-* pattern.
 *
 * Usage: node dist/eval-wp14-outage-canary.js
 */
import { connect } from "node:net";
import { createServer, type Server } from "node:http";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePaths, type CobPaths } from "./codex/paths.js";
import { prepareProfileAndCatalog, syncCatalog } from "./codex/runtime/lifecycle.js";
import {
  formatOllamaDiscoveryLines,
  parseCatalogMetadata,
} from "./codex/catalog/provenance.js";
import type { CatalogFile } from "./codex/types.js";
import { EvalRunGuard, liveHomeShaSnapshot, resolveLiveCodexHome, sha256FileOrNull } from "./eval-run-guard.js";

const SPAWN_SLUG = "ollama/deepseek-v4-flash:0731-cloud";
const TAGS_BODY = JSON.stringify({
  models: [
    {
      name: "deepseek-v4-flash:0731-cloud",
      capabilities: ["tools"],
      details: { context_length: 32768 },
    },
  ],
});

function sha256(path: string): string | null {
  return sha256FileOrNull(path);
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(2_000, () => {
      socket.destroy();
      resolve(true);
    });
  });
}

/**
 * Single-use fixture server: start() is once-only and fail-closed, so a
 * second start can never overwrite (and leak) the first server reference.
 * The listen promise owns the server's async error event, so a listen
 * failure (for example EPERM/EMFILE) rejects instead of crashing the canary
 * as an unhandled exception, and the failed start leaves the server stopped
 * and safely stoppable.
 *
 * The optional server factory is a test-only seam, mirroring the eval run
 * guard's serverFactory: it defaults to node:http's createServer.
 */
export class TagsServer {
  private server: Server | undefined;
  port = 0;
  requestCount = 0;
  private readonly serverFactory: () => Server;

  constructor(serverFactory?: () => Server) {
    this.serverFactory =
      serverFactory ??
      (() =>
        createServer((_req, res) => {
          this.requestCount += 1;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(TAGS_BODY);
        }));
  }

  async start(): Promise<string> {
    if (this.server) {
      throw new Error("tags fixture server is already running; stop it before restarting");
    }
    this.requestCount = 0;
    const server = this.serverFactory();
    try {
      // The async error event is bound to the listen promise; the error
      // listener is removed once the listen callback succeeds.
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
    } catch (error) {
      // A failed listen leaves no running server: no reference is retained
      // and stop() stays idempotent, so the canary's finally cleanup can
      // still run and prove the guard-owned cleanup.
      try {
        server.close(() => undefined);
      } catch {
        // A server that never opened has nothing to close.
      }
      this.server = undefined;
      throw error;
    }
    this.server = server;
    this.port = (server.address() as { port: number }).port;
    return `http://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<boolean> {
    if (!this.server) return true;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return !(await isPortOpen(this.port));
  }
}

function fakeCodexProducer(home: string): { pathBin: string; bundledPath: string } {
  const bundledPath = join(home, "bundled.json");
  writeFileSync(
    bundledPath,
    JSON.stringify({ models: [{ slug: "gpt-5.6-sol", visibility: "list", priority: 0 }] }),
  );
  const pathBin = join(home, "fake-codex");
  writeFileSync(
    pathBin,
    `#!/bin/sh\nif [ "$3" = "--bundled" ]; then\n  cat "${bundledPath}"\n  exit 0\nfi\nexit 0\n`,
  );
  chmodSync(pathBin, 0o755);
  return { pathBin, bundledPath };
}

function ollamaRows(catalog: CatalogFile): Array<Record<string, unknown>> {
  return catalog.models.filter((model) => String(model.slug).startsWith("ollama/")) as Array<
    Record<string, unknown>
  >;
}

function expect(condition: unknown, message: string): void {
  if (!condition) throw new Error(`CANARY FAIL: ${message}`);
  console.log(`ok: ${message}`);
}

function dumpState(paths: CobPaths, label: string): void {
  const catalog: CatalogFile = JSON.parse(readFileSync(paths.catalog, "utf8"));
  const rows = ollamaRows(catalog);
  console.log(
    `[${label}] ollama_rows=${rows.length} slugs=${rows.map((r) => r.slug).join(",") || "-"} ` +
      `shell=${rows.map((r) => r.shell_type).join(",") || "-"} ` +
      `unified_exec_in_rows=${rows.some((r) => JSON.stringify(r).includes("unified_exec"))}`,
  );
  if (existsSync(paths.catalogMeta)) {
    const meta = parseCatalogMetadata(readFileSync(paths.catalogMeta, "utf8"));
    if (meta.schema_version === 1 || meta.schema_version === 3) {
      const evidence = meta.ollama_discovery;
      console.log(
        `[${label}] meta_schema=${meta.schema_version} discovery=${evidence?.state} ` +
          `diagnostic=${evidence?.diagnostic?.code ?? "-"} dialect_revision=${evidence?.dialect_revision}`,
      );
      for (const line of evidence ? formatOllamaDiscoveryLines(evidence) : []) {
        console.log(`[${label}] status> ${line}`);
      }
    }
  }
}

async function main(): Promise<void> {
  // The run guard owns the exclusive run id; a duplicate id fails here before
  // any catalog sync runs. Temp homes and the closed outage port are
  // allocated by the guard without referencing live paths. All setup and the
  // canary live inside try/finally so any failure — including setup failure —
  // still stops the fixture server and runs the cleanup proof.
  const runId = `wp14-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const guard = new EvalRunGuard({ label: "wp14-outage-canary", runId });
  const tagsServer = new TagsServer();
  let homeA: string | undefined;
  let homeB: string | undefined;
  let failure: unknown;
  let cleanupError: unknown;
  // Real ~/.codex, resolved independently of HOME/CODEX_HOME-style overrides.
  // Read-only: config/catalog/sidecar hashes are compared before and after.
  const liveHome = resolveLiveCodexHome();
  const liveFiles = {
    rootConfig: join(liveHome, "config.toml"),
    catalog: join(liveHome, "cob-catalog.json"),
    catalogMeta: join(liveHome, "cob-catalog.meta.json"),
  };
  const liveGuardBefore = liveHomeShaSnapshot();
  const liveBefore = {
    rootConfig: sha256(liveFiles.rootConfig),
    catalog: sha256(liveFiles.catalog),
    catalogMeta: sha256(liveFiles.catalogMeta),
  };
  try {
    console.log(
      `live snapshot (read-only): config=${liveBefore.rootConfig?.slice(0, 12) ?? "absent"} ` +
        `catalog=${liveBefore.catalog?.slice(0, 12) ?? "absent"} ` +
        `meta=${liveBefore.catalogMeta?.slice(0, 12) ?? "absent"}`,
    );

    const closedPort = await guard.allocateClosedPort();
    const closedUrl = `http://127.0.0.1:${closedPort}`;
    expect((await isPortOpen(closedPort)) === false, `closed loopback refuses connections`);

    const fixtureUrl = await tagsServer.start();
    guard.registerPort(tagsServer.port);
    homeA = guard.allocateHome("cob-wp14-seeded-");
    homeB = guard.allocateHome("cob-wp14-empty-");
    const prodA = fakeCodexProducer(homeA);
    const pathsA = resolvePaths(homeA);
    const discoveryA = { liveHome: false as const, platform: "darwin" as const, pathBin: prodA.pathBin };
    const inspectA = { readVersion: () => "codex-cli canary" };
    const optsA = { paths: pathsA, discovery: discoveryA, inspect: inspectA, locked: true as const };

    // Step 1: seed a known last-good isolated catalog on the start path.
    const seeded = await prepareProfileAndCatalog({ ...optsA, ollamaUrl: fixtureUrl });
    expect(tagsServer.requestCount > 0, "seed sync fetched fresh /api/tags evidence");
    expect(ollamaRows(seeded.catalog).length === 1, "seeded catalog carries one Ollama row");
    expect(
      String(ollamaRows(seeded.catalog)[0]?.slug) === SPAWN_SLUG,
      "seeded row is the configured spawn slug",
    );
    expect(
      ollamaRows(seeded.catalog)[0]?.shell_type === "unified_exec",
      "seeded row derives shell_type unified_exec from the fresh exact lowercase tools capability",
    );
    dumpState(pathsA, "seeded");
    const seededCatalogSha = sha256(pathsA.catalog);

    // Step 2: outage — point only the isolated sync path at the closed
    // loopback while the fixture server keeps running on its own port.
    const outage = await syncCatalog({ ...optsA, ollamaUrl: closedUrl });
    expect(typeof outage.ollamaError === "string", "outage sync reports an upstream error");
    expect(ollamaRows(outage.catalog).length === 1, "prior Ollama row survives the outage");
    expect(
      ollamaRows(outage.catalog)[0]?.shell_type === "disabled",
      "fallback disables the shell on the retained row",
    );
    expect(
      ollamaRows(outage.catalog).every((row) => !JSON.stringify(row).includes("unified_exec")),
      "stale unified_exec evidence is stripped from the fallback row",
    );
    const outageMeta = parseCatalogMetadata(readFileSync(pathsA.catalogMeta, "utf8"));
    expect(outageMeta.schema_version === 3, "degraded discovery evidence is recorded (schema 3)");
    if (outageMeta.schema_version === 3) {
      expect(
        outageMeta.ollama_discovery?.diagnostic?.code === "tags_unreachable",
        "status diagnostic is tags_unreachable",
      );
    }
    expect(sha256(pathsA.catalog) !== seededCatalogSha, "fallback rewrote the catalog bytes");
    dumpState(pathsA, "outage");

    // Step 3: no prior catalog + outage → no Ollama row is synthesized.
    const prodB = fakeCodexProducer(homeB);
    const pathsB = resolvePaths(homeB);
    const empty = await syncCatalog({
      paths: pathsB,
      ollamaUrl: closedUrl,
      discovery: { liveHome: false, platform: "darwin", pathBin: prodB.pathBin },
      inspect: { readVersion: () => "codex-cli canary" },
      locked: true,
    });
    expect(ollamaRows(empty.catalog).length === 0, "no Ollama row is synthesized without a prior catalog");
    const emptyMeta = parseCatalogMetadata(readFileSync(pathsB.catalogMeta, "utf8"));
    expect(emptyMeta.schema_version === 3, "empty-home outage records degraded evidence too");
    expect(!existsSync(join(homeB, "checkpoints")), "empty-home outage writes no checkpoints");
    dumpState(pathsB, "no-prior");

    // Step 4: recovery — sync again against the SAME fixture endpoint; the
    // fixture server is never restarted or re-referenced.
    const recovered = await syncCatalog({ ...optsA, ollamaUrl: fixtureUrl });
    expect(ollamaRows(recovered.catalog).length === 1, "recovery restores the Ollama row");
    expect(
      ollamaRows(recovered.catalog)[0]?.shell_type === "unified_exec",
      "recovery re-enables evidence-derived unified_exec",
    );
    const recoveredMeta = parseCatalogMetadata(readFileSync(pathsA.catalogMeta, "utf8"));
    expect(
      recoveredMeta.schema_version === 1 && recoveredMeta.ollama_discovery?.state === "success",
      "recovery records success discovery evidence (schema 1)",
    );
    dumpState(pathsA, "recovered");

    // Step 5: live home unchanged, including the catalog metadata sidecar.
    const liveGuardAfter = liveHomeShaSnapshot();
    const liveAfter = {
      rootConfig: sha256(liveFiles.rootConfig),
      catalog: sha256(liveFiles.catalog),
      catalogMeta: sha256(liveFiles.catalogMeta),
    };
    expect(
      liveAfter.rootConfig === liveBefore.rootConfig &&
        liveAfter.catalog === liveBefore.catalog &&
        liveAfter.catalogMeta === liveBefore.catalogMeta,
      "live root-config and catalog hashes are unchanged",
    );
    expect(
      liveGuardAfter.configSha256 === liveGuardBefore.configSha256 &&
        liveGuardAfter.catalogSha256 === liveGuardBefore.catalogSha256 &&
        liveGuardAfter.catalogMetaSha256 === liveGuardBefore.catalogMetaSha256,
      "env-independent live snapshot is unchanged",
    );
  } catch (error) {
    failure = error;
  } finally {
    // Both success and error paths: stop the fixture, remove both temp homes,
    // then prove the cleanup on the record — exactly once, owned by the
    // guard. A failed proof is preserved so PASS can never print over an
    // incomplete cleanup.
    const fixtureStopped = await tagsServer.stop().catch(() => false);
    try {
      const proof = await guard.finalize();
      const homeARemoved = homeA === undefined || !existsSync(homeA);
      const homeBRemoved = homeB === undefined || !existsSync(homeB);
      console.log(guard.formatCleanupProof(proof));
      console.log(
        `cleanup proof: fixture_stopped=${fixtureStopped} ` +
          `home_a_removed=${homeARemoved} home_b_removed=${homeBRemoved}`,
      );
      if (!fixtureStopped || !homeARemoved || !homeBRemoved) {
        throw new Error("eval run cleanup failed: wp14 fixture/homes verification unsuccessful");
      }
    } catch (error) {
      cleanupError = error;
      console.error(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
    }
  }
  if (failure) throw failure;
  if (cleanupError) throw cleanupError;
  // PASS prints only after the cleanup proof succeeded.
  console.log("WP1.4 isolated outage canary: PASS (cleanup verified)");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
