import { readFileSync, statSync } from "node:fs";
import { writeFileAtomic } from "../../core/atomic.js";
import {
  assertOllamaRowsSafe,
  parseCatalogJson,
  serializeCatalog,
  type CatalogSafetyOptions,
} from "./catalog.js";
import type { CatalogFile } from "../types.js";

/** Concrete catalog file I/O: identity-keyed read cache and the atomic safety-checked writer. */

type CatalogFileCache = {
  path: string;
  identity: string;
  catalog: CatalogFile;
};

let catalogFileCache: CatalogFileCache | undefined;

export function resetCatalogFileCache(): void {
  catalogFileCache = undefined;
}

export function catalogFileIdentityKey(path: string): string {
  const stat = statSync(path);
  return `${stat.dev}:${stat.ino}:${stat.size}:${Math.round(stat.mtimeMs)}`;
}

/** Process-local parsed catalog cache keyed by file identity. Not provenance. */
export function loadCatalogFile(path: string): CatalogFile {
  const identity = catalogFileIdentityKey(path);
  if (catalogFileCache && catalogFileCache.path === path && catalogFileCache.identity === identity) {
    return catalogFileCache.catalog;
  }
  const catalog = parseCatalogJson(readFileSync(path, "utf8"));
  catalogFileCache = { path, identity, catalog };
  return catalog;
}

export function writeCatalogIfChanged(
  path: string,
  catalog: CatalogFile,
  options?: CatalogSafetyOptions,
): boolean {
  assertOllamaRowsSafe(catalog, options);
  const next = serializeCatalog(catalog);
  try {
    const previous = readFileSync(path, "utf8");
    if (previous === next) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`catalog file at ${path} exists but is unreadable; refusing first-write overwrite`);
    }
    // first write
  }
  writeFileAtomic(path, next, 0o600);
  return true;
}
