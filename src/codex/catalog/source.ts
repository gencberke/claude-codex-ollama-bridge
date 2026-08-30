import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { CODEX_CATALOG_TIMEOUT_MS } from "../limits.js";
import { parseCatalogJson } from "./catalog.js";
import type { CatalogFile } from "../types.js";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { isLiveCodexHome } from "../home.js";
import type { CobPaths } from "../paths.js";

/**
 * Codex binary source discovery and identity: where the producer/validator
 * binaries live and how they are fingerprinted. Pure discovery; no catalog
 * I/O and no provenance sidecar knowledge.
 */

export type CodexBinKind = "desktop" | "path" | "override";

export type FileIdentity = {
  dev: string;
  ino: string;
  size: number;
  mtime_ms: number;
};

export type CodexBinaryRecord = {
  kind: CodexBinKind;
  path: string;
  version: string;
  file: FileIdentity;
};

export type CatalogDiscovery = {
  liveHome: boolean;
  platform: NodeJS.Platform;
  overrideBin?: string;
  desktopBins?: string[];
  pathBin?: string;
};

export type CatalogSources = {
  producer: CodexBinaryRecord;
  validators: CodexBinaryRecord[];
};

export type InspectCodexIo = {
  realpath?: (path: string) => string;
  stat?: (path: string) => FileIdentity;
  readVersion?: (path: string) => string;
};

export type DiscoverCodexIo = InspectCodexIo & {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  pathEnv?: string;
  isExecutable?: (path: string) => boolean;
};

export function defaultDesktopCodexCandidates(home = homedir()): string[] {
  return [
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    join(home, "Applications/ChatGPT.app/Contents/Resources/codex"),
  ];
}

export function fileIdentityKey(file: FileIdentity): string {
  return `${file.dev}:${file.ino}:${file.size}:${file.mtime_ms}`;
}

export function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return fileIdentityKey(left) === fileIdentityKey(right);
}

export function fileIdentityFromFs(path: string): FileIdentity {
  const stat = statSync(path);
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: stat.size,
    mtime_ms: Math.round(stat.mtimeMs),
  };
}

export function sha256Hex(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isExecutablePath(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveOnPath(
  name: string,
  pathEnv = process.env.PATH ?? "",
  isExecutable = isExecutablePath,
): string | undefined {
  if (pathEnv.length === 0) return undefined;
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export function discoverCodexBins(opts: {
  paths?: Pick<CobPaths, "codexHome">;
  liveHome?: boolean;
  io?: DiscoverCodexIo;
} = {}): CatalogDiscovery {
  const io = opts.io ?? {};
  const env = io.env ?? process.env;
  const platform = io.platform ?? process.platform;
  const home = io.home ?? homedir();
  const isExecutable = io.isExecutable ?? isExecutablePath;
  const liveHome =
    opts.liveHome ?? (opts.paths ? isLiveCodexHome(opts.paths.codexHome) : false);
  const override = env.COB_CODEX_BIN?.trim();
  const desktopBins =
    platform === "darwin"
      ? defaultDesktopCodexCandidates(home).filter((path) => isExecutable(path))
      : [];
  return {
    liveHome,
    platform,
    overrideBin: override && override.length > 0 ? override : undefined,
    desktopBins,
    pathBin: resolveOnPath("codex", io.pathEnv ?? env.PATH, isExecutable),
  };
}

export function inspectCodexBinary(
  path: string,
  kind: CodexBinKind,
  io: InspectCodexIo = {},
): CodexBinaryRecord {
  const realpath = io.realpath ?? safeRealpath;
  const stat = io.stat ?? fileIdentityFromFs;
  const readVersion = io.readVersion ?? readCodexVersion;
  const resolved = realpath(path);
  return {
    kind,
    path: resolved,
    version: readVersion(resolved),
    file: stat(resolved),
  };
}

export function inspectCodexBinaryForStatus(
  path: string,
  kind: CodexBinKind,
  io: InspectCodexIo = {},
): CodexBinaryRecord {
  return inspectCodexBinary(path, kind, {
    ...io,
    // Status is deliberately stat-only. Ignore even an injected version
    // reader so this path can never turn into a Codex subprocess call.
    readVersion: () => "",
  });
}

export function resolveCatalogSources(
  discovery: CatalogDiscovery,
  io: InspectCodexIo = {},
): CatalogSources {
  const producer = resolveProducer(discovery, io);
  const validators = collectValidators(discovery, producer, io);
  return { producer, validators };
}

export function resolveProducer(discovery: CatalogDiscovery, io: InspectCodexIo): CodexBinaryRecord {
  if (discovery.overrideBin) {
    return inspectCodexBinary(discovery.overrideBin, "override", io);
  }
  if (discovery.liveHome && discovery.platform === "darwin" && discovery.desktopBins?.[0]) {
    return inspectCodexBinary(discovery.desktopBins[0], "desktop", io);
  }
  if (discovery.pathBin) {
    return inspectCodexBinary(discovery.pathBin, "path", io);
  }
  throw new Error(
    "no Codex binary found for catalog generation; set COB_CODEX_BIN or install codex on PATH",
  );
}

function collectValidators(
  discovery: CatalogDiscovery,
  producer: CodexBinaryRecord,
  io: InspectCodexIo,
): CodexBinaryRecord[] {
  const out: CodexBinaryRecord[] = [producer];
  const seen = new Set([fileIdentityKey(producer.file)]);
  const add = (path: string | undefined, kind: CodexBinKind): void => {
    if (!path) return;
    const record = inspectCodexBinary(path, kind, io);
    const key = fileIdentityKey(record.file);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(record);
  };
  if (discovery.liveHome) {
    add(discovery.desktopBins?.[0], "desktop");
  }
  add(discovery.pathBin, "path");
  return out;
}

function readCodexVersion(path: string): string {
  const result = spawnSync(path, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    killSignal: "SIGKILL",
  });
  if (result.error || result.status !== 0) {
    return "unknown";
  }
  const text = `${result.stdout || ""} ${result.stderr || ""}`.trim();
  return text.split(/\r?\n/)[0]?.trim() || "unknown";
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function loadBundledCatalog(codexBin = process.env.COB_CODEX_BIN ?? "codex"): CatalogFile {
  const result = spawnSync(codexBin, ["debug", "models", "--bundled"], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: CODEX_CATALOG_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === "ETIMEDOUT") {
        throw new Error(`codex debug models --bundled timed out after ${CODEX_CATALOG_TIMEOUT_MS}ms`);
      }
      throw result.error;
    }
  if (result.status !== 0) {
    throw new Error(
      `codex debug models --bundled failed (${result.status}): ${sanitizeChildOutput(result.stderr || result.stdout)}`,
    );
  }
  return parseCatalogJson(result.stdout);
}

/**
 * Producer child output: bounded to the first non-empty line, control chars
 * stripped, credential-looking tokens redacted, and user home directories
 * (`/Users`, `/home`, `/root`, `X:\Users`) shortened so a hostile producer
 * line cannot leak secrets or usernames.
 */
function sanitizeChildOutput(text: string | undefined): string {
  const firstLine = (text ?? "")
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0);
  const stripped = (firstLine ?? "").replace(/[\u0000-\u001f\u007f]/g, " ");
  const redacted = stripped
    .replace(
      /\b(?:authorization\s*[:=]\s*\S+(?:\s+\S+)?|(?:basic|bearer|digest|negotiate)\s+\S+|(?:api[_-]?key|access[_-]?token|token|password|secret)\s*[:=]\s*\S+|sk-[A-Za-z0-9][A-Za-z0-9_-]{4,})/gi,
      "<redacted>",
    )
    .replace(/\/((?:Users|home|root))\/[^/\s:;,)"' ]+/g, "/$1/<user>")
    .replace(/([A-Za-z]):\\Users\\[^\\\s:;,)"' ]+/g, "$1:\\Users\\<user>");
  const trimmed = redacted.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}...` : trimmed;
}
