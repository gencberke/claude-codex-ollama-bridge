import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CODEX_CATALOG_TIMEOUT_MS } from "../limits.js";
import { serializeCatalog } from "./catalog.js";
import type { CodexBinaryRecord } from "./source.js";
import type { CatalogFile } from "../types.js";

export class CatalogConsumerRejectedError extends Error {
  readonly code = "catalog_consumer_rejected";
  constructor(
    message: string,
    /** The consumer that rejected the candidate, as typed metadata. */
    readonly consumer: CodexBinaryRecord,
  ) {
    super(message);
    this.name = "CatalogConsumerRejectedError";
  }
}

export function assertConsumersAcceptCatalog(
  catalog: CatalogFile,
  consumers: readonly CodexBinaryRecord[],
): void {
  for (const consumer of consumers) {
    try {
      assertCodexAcceptsCatalog(catalog, consumer.path);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new CatalogConsumerRejectedError(
        `Codex rejected cob catalog (${consumer.kind} ${consumer.path} ${consumer.version}): ${detail}`,
        consumer,
      );
    }
  }
}

export function assertCodexAcceptsCatalog(
  catalog: CatalogFile,
  codexBin = process.env.COB_CODEX_BIN ?? "codex",
): void {
  const dir = mkdtempSync(join(tmpdir(), "cob-catalog-check-"));
  const home = join(dir, "codex-home");
  try {
    mkdirSync(home, { recursive: true });
    const path = join(dir, "catalog.json");
    writeFileSync(path, serializeCatalog(catalog), { encoding: "utf8" });
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home };
    delete env.COB_CODEX_HOME;
    const result = spawnSync(codexBin, ["debug", "models", "-c", `model_catalog_json=${JSON.stringify(path)}`], {
      encoding: "utf8",
      env,
      cwd: home,
      maxBuffer: 20 * 1024 * 1024,
      timeout: CODEX_CATALOG_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
      throw new Error(`codex catalog check timed out after ${CODEX_CATALOG_TIMEOUT_MS}ms`);
    }
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(
        `Codex rejected cob catalog: ${(result.stderr || result.stdout || "").trim() || `exit ${result.status}`}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
