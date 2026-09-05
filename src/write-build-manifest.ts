/**
 * Emit `dist/build-manifest.json` as the last step of the production build.
 *
 * The build is the only place that knows the identity of the bytes it just
 * produced, and putting it here means every packaging path gets it —
 * `npm run pack`, `cob pack`, or a hand-run build. Generating it in one
 * packaging path only is how the same rule ends up implemented twice and
 * disagreeing.
 *
 * Pack-excluded: this is a build tool, not part of the shipped runtime.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import {
  BUILD_MANIFEST_BASENAME,
  digestDistTree,
  type BuildManifest,
} from "./core/build-manifest.js";
import { GATEWAY_DIAGNOSTIC_SCHEMA_VERSION } from "./codex/diagnostic-event.js";

/** `unknown` rather than a guess when git is unavailable or this is not a checkout. */
function readGitIdentity(packageRoot: string): { commit: string; dirty: boolean } {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: packageRoot, encoding: "utf8" });
  if (head.status !== 0) return { commit: "unknown", dirty: false };
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: packageRoot, encoding: "utf8" });
  return {
    commit: (head.stdout ?? "").trim() || "unknown",
    dirty: status.status === 0 && (status.stdout ?? "").trim().length > 0,
  };
}

export function composeBuildManifest(packageRoot: string): BuildManifest {
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: unknown };
  const git = readGitIdentity(packageRoot);
  const dist = digestDistTree(join(packageRoot, "dist"));
  return {
    manifest_version: 1,
    package_version: typeof pkg.version === "string" ? pkg.version : "unknown",
    source_commit: git.commit,
    source_dirty: git.dirty,
    dist_sha256: dist.sha256,
    dist_file_count: dist.fileCount,
    diagnostic_schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
    built_at: new Date().toISOString(),
  };
}

export function writeBuildManifest(packageRoot: string): BuildManifest {
  const manifest = composeBuildManifest(packageRoot);
  writeFileSync(
    join(packageRoot, "dist", BUILD_MANIFEST_BASENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o644 },
  );
  return manifest;
}

// Direct-entry guard, matching the repository's other CLI-invoked modules:
// importing this file must not write anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const manifest = writeBuildManifest(packageRoot);
  console.log(
    `[cob] build manifest ${manifest.package_version} dist=${manifest.dist_sha256.slice(0, 12)}` +
      ` (${manifest.dist_file_count} files) source=${manifest.source_commit.slice(0, 12)}` +
      `${manifest.source_dirty ? " +dirty" : ""}`,
  );
}
