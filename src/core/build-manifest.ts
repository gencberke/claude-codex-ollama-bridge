/**
 * Build identity, recorded by `cob pack` and shipped inside the artifact.
 *
 * The problem this solves is documentary drift: version, source commit, test
 * checkpoint and install state have been carried by hand across STATUS,
 * RELEASE and the implementation plan, and they have repeatedly disagreed
 * with reality. An artifact that carries its own identity lets `cob status`,
 * a canary receipt and a release record all cite the same thing instead of
 * three prose copies of it.
 *
 * Deliberately absent: the tarball's own SHA-256. An artifact cannot contain
 * its own digest; that belongs in the external receipt written after packing.
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const BUILD_MANIFEST_BASENAME = "build-manifest.json";
const BUILD_MANIFEST_WRITER_PATH = "write-build-manifest.js";

export type BuildManifest = {
  /** Manifest shape version, independent of the package version. */
  manifest_version: 1;
  /** `package.json` version at pack time. */
  package_version: string;
  /** Source commit, or `unknown` when git was unavailable. */
  source_commit: string;
  /**
   * Whether tracked sources were modified at pack time. A dirty artifact is
   * legal — `RELEASE.md`'s basic cut does not require a commit — but it must
   * never be mistaken for the commit it claims.
   */
  source_dirty: boolean;
  /** Digest over the production JavaScript that went into the artifact. */
  dist_sha256: string;
  /** Number of files covered by `dist_sha256`. */
  dist_file_count: number;
  /** Schema version of the diagnostic events this build emits. */
  diagnostic_schema_version: number;
  /** ISO-8601 pack time, for ordering two artifacts of the same version. */
  built_at: string;
};

/**
 * Digest of the production build, order-independent of directory listing:
 * every file's repo-relative path and content hash are sorted before the
 * final hash, so the same sources always produce the same value.
 */
export function digestDistTree(distDir: string): { sha256: string; fileCount: number } {
  const entries: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = prefix.length > 0 ? `${prefix}/${name}` : name;
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full, rel);
        continue;
      }
      if (!name.endsWith(".js")) continue;
      // Mirror the package `files` exclusions so the digest covers exactly
      // what ships, not the test and harness output tsc also produced.
      if (name.endsWith(".test.js") || name.endsWith(".harness.js")) continue;
      if (name === "gate6h.js" || name.startsWith("eval-")) continue;
      if (rel === BUILD_MANIFEST_WRITER_PATH) continue;
      entries.push(`${rel}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
    }
  };
  if (!existsSync(distDir)) return { sha256: "unknown", fileCount: 0 };
  walk(distDir, "");
  entries.sort();
  return {
    sha256: createHash("sha256").update(entries.join("\n"), "utf8").digest("hex"),
    fileCount: entries.length,
  };
}

/** Parse a manifest, returning undefined for anything that is not one. */
export function parseBuildManifest(text: string): BuildManifest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.manifest_version !== 1) return undefined;
  const strings = ["package_version", "source_commit", "dist_sha256", "built_at"] as const;
  for (const key of strings) if (typeof record[key] !== "string") return undefined;
  if (typeof record.source_dirty !== "boolean") return undefined;
  if (typeof record.dist_file_count !== "number") return undefined;
  if (typeof record.diagnostic_schema_version !== "number") return undefined;
  return record as unknown as BuildManifest;
}

/**
 * Read the manifest a global install shipped with. A workspace checkout has
 * none until it packs, and an older artifact predates the manifest entirely,
 * so absence is normal and never an error.
 */
export function readBuildManifest(packageRoot: string | undefined): BuildManifest | undefined {
  if (!packageRoot) return undefined;
  try {
    return parseBuildManifest(readFileSync(join(packageRoot, "dist", BUILD_MANIFEST_BASENAME), "utf8"));
  } catch {
    return undefined;
  }
}

/** One line naming the exact bytes a run was served by, or the honest gap. */
export function formatBuildManifestLine(manifest: BuildManifest | undefined): string {
  if (!manifest) return "build identity: unrecorded (artifact predates the manifest, or a workspace build)";
  const dirty = manifest.source_dirty ? " +dirty" : "";
  return (
    `build identity: ${manifest.package_version} dist=${manifest.dist_sha256.slice(0, 12)}` +
    ` (${manifest.dist_file_count} files) source=${manifest.source_commit.slice(0, 12)}${dirty}` +
    ` diag_schema=${manifest.diagnostic_schema_version}`
  );
}
