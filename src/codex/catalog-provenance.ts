import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { writeFileAtomic } from "../core/atomic.js";
import { FEATURED_NATIVE_SLUGS } from "./constants.js";
import { isSpawnableMatch, listVisibleTopSlugs, parseCatalogJson } from "./catalog.js";
import { isLiveCodexHome } from "./home.js";
import type { CobPaths } from "./paths.js";
import type { CatalogFile } from "./types.js";
import { asSlug, asVisibility } from "./types.js";
import { isRecord } from "../core/json.js";

export const CATALOG_PROVENANCE_SCHEMA = 1;
export const CATALOG_PROVENANCE_FAILURE_SCHEMA = 2;
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

export type CatalogValidationFailure = {
  failed_at: string;
  candidate_sha256: string;
  producer: CodexBinaryRecord;
  validators: CodexBinaryRecord[];
  rejected_validator?: CodexBinaryRecord;
  diagnostic: {
    code: "catalog_consumer_rejected";
    summary: string;
  };
};

export type CatalogActiveProvenance =
  | {
      state: "known";
      generated_at: string;
      producer: CodexBinaryRecord;
      validators: CodexBinaryRecord[];
    }
  | {
      state: "unknown" | "missing";
      reason: string;
    };

/**
 * Schema v2 is written only to retain a failed candidate attempt. The active
 * catalog SHA and its last-good v1 provenance remain embedded in the same
 * cob-catalog.meta.json. A legacy catalog can therefore stay explicitly
 * unknown while status still explains the failed regeneration.
 */
export type CatalogProvenanceFailureMetadata = {
  schema_version: typeof CATALOG_PROVENANCE_FAILURE_SCHEMA;
  catalog_sha256: string | null;
  active: CatalogActiveProvenance;
  last_failure?: CatalogValidationFailure;
};

export type CatalogMetadata = CatalogProvenance | CatalogProvenanceFailureMetadata;

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

export function parseCatalogMetadata(text: string): CatalogMetadata {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error("catalog provenance must be a JSON object");
  }
  if (parsed.schema_version === CATALOG_PROVENANCE_SCHEMA) {
    return parseCatalogProvenance(text);
  }
  if (parsed.schema_version !== CATALOG_PROVENANCE_FAILURE_SCHEMA) {
    throw new Error(
      `catalog provenance schema_version ${String(parsed.schema_version)} is unsupported`,
    );
  }
  return {
    schema_version: CATALOG_PROVENANCE_FAILURE_SCHEMA,
    catalog_sha256: parseNullableSha256(parsed.catalog_sha256, "catalog_sha256"),
    active: parseActiveProvenance(parsed.active),
    ...(parsed.last_failure === undefined
      ? {}
      : {
          last_failure: parseCatalogValidationFailure(parsed.last_failure),
        }),
  };
}

export function writeCatalogValidationFailure(opts: {
  metaPath: string;
  candidateBytes: string | Buffer;
  retainedCatalogBytes: string | Buffer | null;
  retainedMetadataBytes: string | Buffer | null;
  sources: CatalogSources;
  error: unknown;
  failedAt?: string;
}): CatalogProvenanceFailureMetadata {
  const rejectedValidator = findRejectedValidator(opts.error, opts.sources.validators);
  const failure: CatalogValidationFailure = {
    failed_at: opts.failedAt ?? new Date().toISOString(),
    candidate_sha256: sha256Hex(opts.candidateBytes),
    producer: opts.sources.producer,
    validators: opts.sources.validators,
    ...(rejectedValidator ? { rejected_validator: rejectedValidator } : {}),
    diagnostic: {
      code: "catalog_consumer_rejected",
      summary: redactCatalogValidationError(opts.error),
    },
  };
  const catalogSha =
    opts.retainedCatalogBytes === null ? null : sha256Hex(opts.retainedCatalogBytes);
  const meta: CatalogProvenanceFailureMetadata = {
    schema_version: CATALOG_PROVENANCE_FAILURE_SCHEMA,
    catalog_sha256: catalogSha,
    active: retainedActiveProvenance(
      opts.retainedMetadataBytes,
      catalogSha,
      opts.retainedCatalogBytes === null,
    ),
    last_failure: failure,
  };
  writeFileAtomic(opts.metaPath, `${JSON.stringify(meta, null, 2)}\n`, 0o600);
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
  let metadata: CatalogMetadata | undefined;
  let metadataError: unknown;
  if (exists(opts.metaPath)) {
    try {
      metadata = parseCatalogMetadata(readFile(opts.metaPath));
    } catch (error) {
      metadataError = error;
    }
  }
  const failure =
    metadata?.schema_version === CATALOG_PROVENANCE_FAILURE_SCHEMA
      ? metadata.last_failure
      : undefined;
  const failureValidatorProblem = failure
    ? recordedValidatorProblem(
        { validators: failure.validators },
        opts.discovery,
        statusIo(opts.io),
      )
    : undefined;
  const finish = (assessment: CatalogProvenanceAssessment): CatalogProvenanceAssessment =>
    applyCatalogValidationFailure(assessment, failure, failureValidatorProblem);
  if (!exists(opts.catalogPath)) {
    return finish({
      freshness: "missing",
      repair: "cob sync or cob start",
      lines: ["catalog provenance: none (no cob-catalog.json)"],
    });
  }

  let catalogText: string;
  try {
    catalogText = readFile(opts.catalogPath);
  } catch (error) {
    return finish(stale("catalog file is unreadable", errorMessage(error)));
  }

  let catalog: CatalogFile;
  try {
    catalog = parseCatalogJson(catalogText);
  } catch (error) {
    return finish(stale("catalog cannot be parsed", errorMessage(error)));
  }

  const missingRows = missingRequiredPickerRows(catalog);
  if (missingRows.length > 0) {
    return finish(stale("required picker rows are absent", missingRows.join(", ")));
  }

  if (!exists(opts.metaPath)) {
    return finish({
      freshness: "unknown",
      reason: "legacy catalog has no cob-catalog.meta.json",
      repair: "cob sync or cob start",
      lines: [
        "catalog provenance: unknown (legacy catalog has no cob-catalog.meta.json)",
        "  run cob sync or cob start to regenerate cob-catalog.json",
      ],
    });
  }

  if (metadataError || !metadata) {
    return stale("catalog metadata is malformed", errorMessage(metadataError));
  }

  const digest = sha256Hex(catalogText);
  if (digest !== metadata.catalog_sha256) {
    return finish(stale("catalog SHA does not match sidecar", `${digest.slice(0, 12)}… vs recorded`));
  }

  const meta = activeKnownProvenance(metadata);
  if (!meta) {
    const active = metadata.schema_version === CATALOG_PROVENANCE_FAILURE_SCHEMA
      ? metadata.active
      : undefined;
    if (active?.state === "unknown") {
      return finish({
        freshness: "unknown",
        reason: active.reason,
        repair: "cob sync or cob start",
        lines: [
          `catalog provenance: unknown (${active.reason})`,
          "  run cob sync or cob start after Codex consumers agree",
        ],
      });
    }
    return finish(stale("catalog metadata says the active catalog is missing"));
  }

  let currentProducer: CodexBinaryRecord;
  let producerProblem: { reason: string; detail?: string } | undefined;
  try {
    currentProducer = resolveProducer(opts.discovery, statusIo(opts.io));
  } catch (error) {
    producerProblem = { reason: "selected producer is missing", detail: errorMessage(error) };
    currentProducer = meta.producer;
  }
  if (!producerProblem && producerChanged(meta.producer, currentProducer)) {
    producerProblem = {
      reason: "selected producer path or file identity changed",
      detail: `${meta.producer.kind} ${meta.producer.path} → ${currentProducer.kind} ${currentProducer.path}`,
    };
  }

  // Inspect the complete recorded validator set even when producer selection
  // itself is already stale, so status never silently skips a PATH/override
  // consumer after finding an earlier Desktop problem.
  const validatorProblem = recordedValidatorProblem(meta, opts.discovery, statusIo(opts.io));
  if (producerProblem) {
    return finish(stale(producerProblem.reason, producerProblem.detail));
  }
  if (validatorProblem) {
    return finish(stale(validatorProblem.reason, validatorProblem.detail));
  }

  const roster = assessV1Roster(catalog, opts.spawnableOllamaSlugs ?? []);
  return finish({
    freshness: "fresh",
    repair: "none",
    provenance: meta,
    lines: [
      `catalog provenance: fresh`,
      `  producer: ${formatBinary(meta.producer)}`,
      `  validators: ${meta.validators.map(formatBinary).join("; ")}`,
      ...formatRosterLines(roster),
    ],
  });
}

export function catalogStatusKind(freshness: CatalogFreshness): "stale" | "unknown" | undefined {
  if (freshness === "stale" || freshness === "missing") return "stale";
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

function recordedValidatorProblem(
  meta: Pick<CatalogProvenance, "validators">,
  discovery: CatalogDiscovery,
  io: InspectCodexIo,
): { reason: string; detail?: string } | undefined {
  const changed: string[] = [];
  for (const recorded of meta.validators) {
    try {
      const current = inspectCodexBinaryForStatus(recorded.path, recorded.kind, io);
      if (recorded.path !== current.path || !sameFileIdentity(recorded.file, current.file)) {
        changed.push(`${recorded.kind} ${recorded.path}`);
      }
    } catch {
      changed.push(`${recorded.kind} ${recorded.path} (missing or unreadable)`);
    }
  }
  if (changed.length > 0) {
    return {
      reason: "recorded validator file identity changed",
      detail: changed.join("; "),
    };
  }

  try {
    const current = resolveCatalogSources(discovery, io).validators;
    const recordedKeys = new Set(meta.validators.map((item) => fileIdentityKey(item.file)));
    const currentKeys = new Set(current.map((item) => fileIdentityKey(item.file)));
    const added = current.filter((item) => !recordedKeys.has(fileIdentityKey(item.file)));
    const removed = meta.validators.filter((item) => !currentKeys.has(fileIdentityKey(item.file)));
    if (added.length > 0 || removed.length > 0) {
      const parts = [
        ...(added.length > 0
          ? [`added ${added.map((item) => `${item.kind} ${item.path}`).join("; ")}`]
          : []),
        ...(removed.length > 0
          ? [`removed ${removed.map((item) => `${item.kind} ${item.path}`).join("; ")}`]
          : []),
      ];
      return { reason: "detected validator set changed", detail: parts.join("; ") };
    }
  } catch (error) {
    return { reason: "detected validator set cannot be inspected", detail: errorMessage(error) };
  }
  return undefined;
}

function statusIo(io: InspectCodexIo = {}): InspectCodexIo {
  return {
    ...io,
    readVersion: () => "",
  };
}

function activeKnownProvenance(metadata: CatalogMetadata): CatalogProvenance | undefined {
  if (metadata.schema_version === CATALOG_PROVENANCE_SCHEMA) return metadata;
  if (metadata.active.state !== "known") return undefined;
  return {
    schema_version: CATALOG_PROVENANCE_SCHEMA,
    generated_at: metadata.active.generated_at,
    catalog_sha256: metadata.catalog_sha256 ?? "",
    producer: metadata.active.producer,
    validators: metadata.active.validators,
  };
}

function catalogValidationFailureLines(failure: CatalogValidationFailure): string[] {
  const rejected = failure.rejected_validator
    ? formatBinary(failure.rejected_validator)
    : "unknown validator";
  return [
    `last candidate validation: failed at ${failure.failed_at}`,
    `  candidate producer: ${formatBinary(failure.producer)}`,
    `  candidate validators: ${failure.validators.map(formatBinary).join("; ")}`,
    `  rejected by: ${rejected}`,
    `  diagnostic: ${failure.diagnostic.summary}`,
    `  candidate sha256: ${failure.candidate_sha256.slice(0, 12)}…`,
  ];
}

function applyCatalogValidationFailure(
  assessment: CatalogProvenanceAssessment,
  failure: CatalogValidationFailure | undefined,
  validatorProblem?: { reason: string; detail?: string },
): CatalogProvenanceAssessment {
  if (!failure) return assessment;
  const lines = [
    ...catalogValidationFailureLines(failure),
    ...(validatorProblem
      ? [
          `  recorded candidate validator identity: ${validatorProblem.reason}${validatorProblem.detail ? `: ${validatorProblem.detail}` : ""}`,
        ]
      : []),
  ];
  if (assessment.freshness !== "fresh") {
    return { ...assessment, lines: [...assessment.lines, ...lines] };
  }
  return {
    ...assessment,
    freshness: "stale",
    reason: "last candidate validation failed",
    repair: "cob sync or cob start",
    lines: [
      "catalog provenance: stale (last candidate validation failed; last known-good catalog retained)",
      ...assessment.lines.slice(1),
      ...lines,
      "  run cob sync or cob start after Codex consumers agree",
    ],
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

function retainedActiveProvenance(
  metadataBytes: string | Buffer | null,
  catalogSha: string | null,
  catalogMissing: boolean,
): CatalogActiveProvenance {
  if (metadataBytes === null) {
    return catalogMissing
      ? { state: "missing", reason: "no last-known-good catalog exists" }
      : { state: "unknown", reason: "legacy catalog had no cob-catalog.meta.json" };
  }
  let metadata: CatalogMetadata;
  try {
    metadata = parseCatalogMetadata(metadataBytes.toString());
  } catch {
    return { state: "unknown", reason: "previous catalog metadata was malformed" };
  }
  if (metadata.catalog_sha256 !== catalogSha) {
    return { state: "unknown", reason: "previous catalog metadata did not match the catalog" };
  }
  if (metadata.schema_version === CATALOG_PROVENANCE_SCHEMA) {
    return {
      state: "known",
      generated_at: metadata.generated_at,
      producer: metadata.producer,
      validators: metadata.validators,
    };
  }
  return metadata.active;
}

function parseActiveProvenance(value: unknown): CatalogActiveProvenance {
  if (!isRecord(value)) {
    throw new Error("catalog provenance v2 is missing active provenance");
  }
  if (value.state === "known") {
    if (typeof value.generated_at !== "string" || value.generated_at.length === 0) {
      throw new Error("catalog provenance v2 active provenance is missing generated_at");
    }
    return {
      state: "known",
      generated_at: value.generated_at,
      producer: parseBinaryRecord(value.producer, "active.producer"),
      validators: parseBinaryRecords(value.validators, "active.validators"),
    };
  }
  if (value.state !== "unknown" && value.state !== "missing") {
    throw new Error("catalog provenance v2 active provenance has an invalid state");
  }
  if (typeof value.reason !== "string" || value.reason.length === 0) {
    throw new Error("catalog provenance v2 active provenance is missing its reason");
  }
  return { state: value.state, reason: value.reason };
}

function parseCatalogValidationFailure(value: unknown): CatalogValidationFailure {
  if (!isRecord(value)) {
    throw new Error("catalog provenance v2 last_failure must be an object");
  }
  if (typeof value.failed_at !== "string" || value.failed_at.length === 0) {
    throw new Error("catalog provenance v2 last_failure is missing failed_at");
  }
  if (typeof value.candidate_sha256 !== "string" || !isSha256(value.candidate_sha256)) {
    throw new Error("catalog provenance v2 last_failure has an invalid candidate_sha256");
  }
  if (!isRecord(value.diagnostic) || value.diagnostic.code !== "catalog_consumer_rejected") {
    throw new Error("catalog provenance v2 last_failure has an invalid diagnostic code");
  }
  if (typeof value.diagnostic.summary !== "string" || value.diagnostic.summary.length === 0) {
    throw new Error("catalog provenance v2 last_failure is missing its redacted summary");
  }
  return {
    failed_at: value.failed_at,
    candidate_sha256: value.candidate_sha256,
    producer: parseBinaryRecord(value.producer, "last_failure.producer"),
    validators: parseBinaryRecords(value.validators, "last_failure.validators"),
    ...(value.rejected_validator === undefined
      ? {}
      : {
          rejected_validator: parseBinaryRecord(
            value.rejected_validator,
            "last_failure.rejected_validator",
          ),
        }),
    diagnostic: {
      code: "catalog_consumer_rejected",
      summary: value.diagnostic.summary,
    },
  };
}

function parseNullableSha256(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !isSha256(value)) {
    throw new Error(`catalog provenance has an invalid ${label}`);
  }
  return value;
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function findRejectedValidator(
  error: unknown,
  validators: readonly CodexBinaryRecord[],
): CodexBinaryRecord | undefined {
  const message = errorMessage(error);
  return validators.find((validator) =>
    message.includes(`(${validator.kind} ${validator.path} ${validator.version})`),
  );
}

const SAFE_CATALOG_FIELD_HINTS = [
  "apply_patch_tool_type",
  "auto_compact_token_limit",
  "base_instructions",
  "context_window",
  "default_reasoning_level",
  "display_name",
  "experimental_supported_tools",
  "input_modalities",
  "multi_agent_version",
  "priority",
  "shell_type",
  "slug",
  "supported_reasoning_levels",
  "supports_parallel_tool_calls",
  "supports_reasoning_summaries",
  "supports_search_tool",
  "visibility",
] as const;

/** Reduce arbitrary validator stderr to a bounded schema-level diagnostic. */
function redactCatalogValidationError(error: unknown): string {
  const message = errorMessage(error);
  const fieldHints = SAFE_CATALOG_FIELD_HINTS.filter((field) => message.includes(field));
  if (fieldHints.length > 0) {
    return `validator rejected candidate near schema field${fieldHints.length === 1 ? "" : "s"} ${fieldHints.join(", ")}`;
  }
  const timeout = message.match(/timed out after (\d{1,9})ms/i)?.[1];
  if (timeout) return `validator catalog check timed out after ${timeout}ms`;
  const code = message.match(/\b(ENOENT|EACCES|EPERM|ETIMEDOUT|E2BIG)\b/)?.[1];
  if (code) return `validator catalog check could not run (${code})`;
  return "validator rejected candidate; validator output redacted";
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
