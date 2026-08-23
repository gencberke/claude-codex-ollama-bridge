import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { FEATURED_NATIVE_SLUGS } from "./constants.js";
import { isSpawnableMatch, listVisibleTopSlugs, parseCatalogJson } from "./catalog.js";
import { isLiveCodexHome } from "./install.js";
import type { CobPaths } from "./paths.js";
import type { CatalogFile } from "./types.js";
import { asSlug, asVisibility, isRecord } from "./types.js";

export const CATALOG_PROVENANCE_SCHEMA = 1;
export const V1_ROSTER_SLOTS = 5;
export const LIVE_DESKTOP_RESTART_HINT =
  "Fully quit and reopen ChatGPT Desktop before judging picker changes.";

export function shouldPrintDesktopRestartHint(liveHome: boolean, wroteCatalog: boolean): boolean {
  return liveHome && wroteCatalog;
}

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

export type CatalogProvenance = {
  schema_version: typeof CATALOG_PROVENANCE_SCHEMA;
  generated_at: string;
  catalog_sha256: string;
  producer: CodexBinaryRecord;
  validators: CodexBinaryRecord[];
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

export type CatalogFreshness = "fresh" | "stale" | "unknown" | "missing";

export type CatalogProvenanceAssessment = {
  freshness: CatalogFreshness;
  reason?: string;
  repair: "cob sync or cob start" | "none";
  lines: string[];
  provenance?: CatalogProvenance;
};

export type RosterAssessment = {
  listed: string[];
  nativeListed: number;
  ollamaSlots: number;
  listedSpawnable: string[];
  omitted: string[];
  headroom: number;
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
    readVersion: io.readVersion ?? (() => ""),
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

function resolveProducer(discovery: CatalogDiscovery, io: InspectCodexIo): CodexBinaryRecord {
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

export function serializeCatalogProvenance(meta: CatalogProvenance): string {
  return `${JSON.stringify(meta, null, 2)}\n`;
}

export function parseCatalogProvenance(text: string): CatalogProvenance {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error("catalog provenance must be a JSON object");
  }
  if (parsed.schema_version !== CATALOG_PROVENANCE_SCHEMA) {
    throw new Error(
      `catalog provenance schema_version ${String(parsed.schema_version)} is unsupported`,
    );
  }
  if (typeof parsed.generated_at !== "string" || parsed.generated_at.length === 0) {
    throw new Error("catalog provenance is missing generated_at");
  }
  if (typeof parsed.catalog_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(parsed.catalog_sha256)) {
    throw new Error("catalog provenance has an invalid catalog_sha256");
  }
  return {
    schema_version: CATALOG_PROVENANCE_SCHEMA,
    generated_at: parsed.generated_at,
    catalog_sha256: parsed.catalog_sha256,
    producer: parseBinaryRecord(parsed.producer, "producer"),
    validators: parseBinaryRecords(parsed.validators, "validators"),
  };
}

export function writeCatalogProvenance(opts: {
  metaPath: string;
  catalogBytes: string | Buffer;
  sources: CatalogSources;
  generatedAt?: string;
}): CatalogProvenance {
  const meta: CatalogProvenance = {
    schema_version: CATALOG_PROVENANCE_SCHEMA,
    generated_at: opts.generatedAt ?? new Date().toISOString(),
    catalog_sha256: sha256Hex(opts.catalogBytes),
    producer: opts.sources.producer,
    validators: opts.sources.validators,
  };
  writeFileAtomic(opts.metaPath, serializeCatalogProvenance(meta), 0o600);
  return meta;
}

export function missingRequiredPickerRows(catalog: CatalogFile): string[] {
  const slugs = catalog.models.map(asSlug);
  const listed = new Set(
    catalog.models.filter((model) => asVisibility(model) === "list").map(asSlug),
  );
  const missing: string[] = [];
  for (const slug of FEATURED_NATIVE_SLUGS) {
    if (slugs.includes(slug) && !listed.has(slug)) missing.push(slug);
  }
  if (catalog.models.length > 0 && listVisibleTopSlugs(catalog.models).length === 0) {
    missing.push("(no visibility=list rows)");
  }
  return missing;
}

export function assessV1Roster(
  catalog: CatalogFile,
  spawnableSlugs: readonly string[],
): RosterAssessment {
  const listed = listVisibleTopSlugs(catalog.models, V1_ROSTER_SLOTS);
  const nativeListed = listed.filter((slug) => !slug.startsWith("ollama/")).length;
  const listedSpawnable = listed.filter((slug) => slug.startsWith("ollama/"));
  const omitted: string[] = [];
  for (const wanted of spawnableSlugs) {
    const slug = wanted.startsWith("ollama/") ? wanted : `ollama/${wanted}`;
    const inWindow = listed.some((row) => isSpawnableMatch(row, wanted));
    if (!inWindow) omitted.push(slug);
  }
  return {
    listed,
    nativeListed,
    ollamaSlots: Math.max(0, V1_ROSTER_SLOTS - nativeListed),
    listedSpawnable,
    omitted,
    headroom: Math.max(0, V1_ROSTER_SLOTS - listed.length),
  };
}

export function formatRosterLines(roster: RosterAssessment): string[] {
  const listed = roster.listed.length > 0 ? roster.listed.join(", ") : "(none)";
  const lines = [
    `v1 roster: ${listed} (${roster.headroom} slot${roster.headroom === 1 ? "" : "s"} free)`,
  ];
  if (roster.headroom === 0 && roster.listed.length >= V1_ROSTER_SLOTS) {
    lines.push("  warning: no V1 child roster headroom");
  }
  if (roster.omitted.length > 0) {
    lines.push(`  warning: V1 roster overflow omitted ${roster.omitted.join(", ")}`);
  }
  return lines;
}

export function assessCatalogProvenance(opts: {
  catalogPath: string;
  metaPath: string;
  discovery: CatalogDiscovery;
  spawnableOllamaSlugs?: readonly string[];
  io?: InspectCodexIo;
  readFile?: (path: string) => string;
  exists?: (path: string) => boolean;
}): CatalogProvenanceAssessment {
  const exists = opts.exists ?? existsSync;
  const readFile = opts.readFile ?? defaultReadFile;
  if (!exists(opts.catalogPath)) {
    return {
      freshness: "missing",
      repair: "cob sync or cob start",
      lines: ["catalog provenance: none (no cob-catalog.json)"],
    };
  }

  let catalogText: string;
  try {
    catalogText = readFile(opts.catalogPath);
  } catch (error) {
    return stale("catalog file is unreadable", errorMessage(error));
  }

  let catalog: CatalogFile;
  try {
    catalog = parseCatalogJson(catalogText);
  } catch (error) {
    return stale("catalog cannot be parsed", errorMessage(error));
  }

  const missingRows = missingRequiredPickerRows(catalog);
  if (missingRows.length > 0) {
    return stale("required picker rows are absent", missingRows.join(", "));
  }

  if (!exists(opts.metaPath)) {
    return {
      freshness: "unknown",
      reason: "legacy catalog has no cob-catalog.meta.json",
      repair: "cob sync or cob start",
      lines: [
        "catalog provenance: unknown (legacy catalog has no cob-catalog.meta.json)",
        "  run cob sync or cob start to regenerate cob-catalog.json",
      ],
    };
  }

  let meta: CatalogProvenance;
  try {
    meta = parseCatalogProvenance(readFile(opts.metaPath));
  } catch (error) {
    return stale("catalog metadata is malformed", errorMessage(error));
  }

  const digest = sha256Hex(catalogText);
  if (digest !== meta.catalog_sha256) {
    return stale("catalog SHA does not match sidecar", `${digest.slice(0, 12)}… vs recorded`);
  }

  let currentProducer: CodexBinaryRecord;
  try {
    currentProducer = resolveProducer(opts.discovery, statusIo(opts.io));
  } catch (error) {
    return stale("selected producer is missing", errorMessage(error));
  }
  if (producerChanged(meta.producer, currentProducer)) {
    return stale(
      "selected producer path or file identity changed",
      `${meta.producer.kind} ${meta.producer.path} → ${currentProducer.kind} ${currentProducer.path}`,
    );
  }

  if (opts.discovery.liveHome && desktopConsumerChanged(meta, opts.discovery, statusIo(opts.io))) {
    return stale("detected Desktop consumer changed after generation", undefined);
  }

  const roster = assessV1Roster(catalog, opts.spawnableOllamaSlugs ?? []);
  return {
    freshness: "fresh",
    repair: "none",
    provenance: meta,
    lines: [
      `catalog provenance: fresh`,
      `  producer: ${formatBinary(meta.producer)}`,
      `  validators: ${meta.validators.map(formatBinary).join("; ")}`,
      ...formatRosterLines(roster),
    ],
  };
}

export function catalogStatusKind(freshness: CatalogFreshness): "stale" | "unknown" | undefined {
  if (freshness === "stale") return "stale";
  if (freshness === "unknown") return "unknown";
  return undefined;
}

function stale(reason: string, detail?: string): CatalogProvenanceAssessment {
  const extra = detail ? `: ${detail}` : "";
  return {
    freshness: "stale",
    reason,
    repair: "cob sync or cob start",
    lines: [
      `catalog provenance: stale (${reason}${extra})`,
      "  run cob sync or cob start to regenerate cob-catalog.json",
    ],
  };
}

function producerChanged(recorded: CodexBinaryRecord, current: CodexBinaryRecord): boolean {
  return recorded.path !== current.path || !sameFileIdentity(recorded.file, current.file);
}

function desktopConsumerChanged(
  meta: CatalogProvenance,
  discovery: CatalogDiscovery,
  io: InspectCodexIo,
): boolean {
  const recorded = [meta.producer, ...meta.validators].find((item) => item.kind === "desktop");
  const desktopPath = discovery.desktopBins?.[0];
  if (!recorded && !desktopPath) return false;
  if (!recorded || !desktopPath) return true;
  try {
    const current = inspectCodexBinaryForStatus(desktopPath, "desktop", io);
    return recorded.path !== current.path || !sameFileIdentity(recorded.file, current.file);
  } catch {
    return true;
  }
}

function statusIo(io: InspectCodexIo = {}): InspectCodexIo {
  return {
    ...io,
    readVersion: io.readVersion ?? (() => ""),
  };
}

function parseBinaryRecords(value: unknown, label: string): CodexBinaryRecord[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`catalog provenance ${label} must be a non-empty array`);
  }
  return value.map((item, index) => parseBinaryRecord(item, `${label}[${index}]`));
}

function parseBinaryRecord(value: unknown, label: string): CodexBinaryRecord {
  if (!isRecord(value)) {
    throw new Error(`catalog provenance ${label} must be an object`);
  }
  const kind = value.kind;
  if (kind !== "desktop" && kind !== "path" && kind !== "override") {
    throw new Error(`catalog provenance ${label} has an invalid kind`);
  }
  if (typeof value.path !== "string" || value.path.length === 0) {
    throw new Error(`catalog provenance ${label} is missing path`);
  }
  if (typeof value.version !== "string") {
    throw new Error(`catalog provenance ${label} is missing version`);
  }
  return {
    kind,
    path: value.path,
    version: value.version,
    file: parseFileIdentity(value.file, `${label}.file`),
  };
}

function parseFileIdentity(value: unknown, label: string): FileIdentity {
  if (!isRecord(value)) {
    throw new Error(`catalog provenance ${label} must be an object`);
  }
  if (typeof value.dev !== "string" || typeof value.ino !== "string") {
    throw new Error(`catalog provenance ${label} must serialize dev/ino as strings`);
  }
  if (typeof value.size !== "number" || !Number.isFinite(value.size)) {
    throw new Error(`catalog provenance ${label} has an invalid size`);
  }
  if (typeof value.mtime_ms !== "number" || !Number.isFinite(value.mtime_ms)) {
    throw new Error(`catalog provenance ${label} has an invalid mtime_ms`);
  }
  return {
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mtime_ms: value.mtime_ms,
  };
}

function formatBinary(record: CodexBinaryRecord): string {
  const version = record.version.length > 0 ? record.version : "version-unrecorded";
  return `${record.kind} ${record.path} (${version})`;
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

function defaultReadFile(path: string): string {
  return readFileSync(path, "utf8");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
