import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "codex-ollama-bridge";

export type InstallKind = "global" | "workspace" | "unknown";

export type CobInstall = {
  kind: InstallKind;
  version: string;
  cliPath: string;
  packageRoot?: string;
};

export function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

function normalizePath(value: string): string {
  const resolved = resolveExisting(value);
  if (process.platform === "win32") return resolved.toLowerCase();
  return resolved;
}

function resolveExisting(startFile: string): string {
  try {
    return realpathSync(startFile);
  } catch {
    return resolve(startFile);
  }
}

export function findPackageRoot(startFile: string): string | undefined {
  let dir = dirname(resolveExisting(startFile));
  for (let i = 0; i < 10; i += 1) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (
          parsed &&
          typeof parsed === "object" &&
          "name" in parsed &&
          (parsed as { name?: unknown }).name === PACKAGE_NAME
        ) {
          return dir;
        }
      } catch {
        // keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export function readPackageVersion(packageRoot: string | undefined): string {
  if (!packageRoot) return "0.0.0";
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      "version" in parsed &&
      typeof (parsed as { version?: unknown }).version === "string"
    ) {
      return (parsed as { version: string }).version;
    }
  } catch {
    // fall through
  }
  return "0.0.0";
}

export function detectInstall(cliPath = process.argv[1] ?? ""): CobInstall {
  const resolvedCli = cliPath.length > 0 ? resolveExisting(cliPath) : "";
  let packageRoot = resolvedCli.length > 0 ? findPackageRoot(resolvedCli) : undefined;
  if (!packageRoot && (cliPath.length === 0 || cliPath === process.argv[1])) {
    packageRoot = findPackageRoot(fileURLToPath(import.meta.url));
  }
  const version = readPackageVersion(packageRoot);
  const shown = resolvedCli || cliPath;
  if (!packageRoot) {
    return { kind: "unknown", version, cliPath: shown };
  }
  const workspaceMarker = join(packageRoot, "src", "cli.ts");
  if (existsSync(workspaceMarker)) {
    return { kind: "workspace", version, cliPath: shown, packageRoot };
  }
  return { kind: "global", version, cliPath: shown, packageRoot };
}

export function formatInstallLine(install: CobInstall): string {
  return `cob ${install.version} (${install.kind})`;
}
