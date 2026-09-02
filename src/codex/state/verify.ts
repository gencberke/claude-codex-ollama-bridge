import { lstatSync, readdirSync, readFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import { MAX_UPSTREAM_BODY_BYTES } from "../../core/http/body.js";
import {
  MAX_STATE_CHAIN_DEPTH,
  MAX_STATE_CHECKPOINT_BYTES,
  MAX_STATE_SCAN_FILES,
  decodeResponseId,
  validateCheckpoint,
} from "./schema.js";
import { isRecord } from "../../core/json.js";

/**
 * Read-only state integrity audit (`cob state verify`). Aggregates counts and
 * bytes only: never response ids, encoded filenames, paths below the state
 * root, model names, history, output, or envelope bytes. The scan deletes,
 * repairs, prunes, rewrites, and creates nothing. Once the file-count scan
 * cap is crossed, file contents are never read: the audit fails closed with
 * `limit_exceeded`. Only an ENOENT state root is a clean absence; unreadable
 * roots, non-directories, symlinks, and unsafe modes fail closed without
 * following links outside the state root.
 */

export type StateVerifyReportV1 = {
  schema_version: 1;
  state_dir_present: boolean;
  checkpoints: {
    total: number;
    valid: number;
    corrupt: number;
    unsafe: number;
    permission_failing: number;
    invalid_filename: number;
    missing_archive: number;
    bytes: number;
  };
  archives: {
    total: number;
    linked: number;
    orphan: number;
    invalid_filename: number;
    permission_failing: number;
    bytes: number;
  };
  temporary_files: number;
  unsafe_directories: number;
  lineage: {
    max_depth: number;
    cycles: number;
    broken_parent_links: number;
    over_depth: number;
  };
  scan: {
    files_scanned: number;
    limit: number;
    limit_exceeded: boolean;
    unreadable: boolean;
  };
  clean: boolean;
};

const CHECKPOINTS_DIR_NAME = "checkpoints";
const ARCHIVE_DIR_NAME = "compact-archive";

type ValidCheckpoint = {
  responseId: string;
  parentResponseId?: string;
  isCompactionReplacement: boolean;
  rawCompactArchive?: string;
  bytes: number;
};

export function verifyStateIntegrity(
  stateDir: string,
  opts: { scanFileLimit?: number } = {},
): StateVerifyReportV1 {
  const scanFileLimit = opts.scanFileLimit ?? MAX_STATE_SCAN_FILES;
  const checkpointsDir = join(stateDir, CHECKPOINTS_DIR_NAME);
  const archiveDir = join(stateDir, ARCHIVE_DIR_NAME);

  let rootStat: Stats;
  try {
    rootStat = lstatSync(stateDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return cleanEmptyReport();
    return {
      ...emptyFindingsReport(),
      scan: { files_scanned: 0, limit: MAX_STATE_SCAN_FILES, limit_exceeded: false, unreadable: true },
      clean: false,
    };
  }
  // A symlinked or non-directory state root is never followed or scanned.
  if (!rootStat.isDirectory()) {
    return {
      ...emptyFindingsReport(),
      state_dir_present: true,
      unsafe_directories: 1,
      scan: { files_scanned: 0, limit: MAX_STATE_SCAN_FILES, limit_exceeded: false, unreadable: true },
      clean: false,
    };
  }

  let unsafeDirectories = (rootStat.mode & 0o077) !== 0 ? 1 : 0;
  let unreadable = false;
  let rootNames: string[] = [];
  try {
    rootNames = readdirSync(stateDir);
  } catch {
    unreadable = true;
  }

  const checkpoints = readStateDirEntries(checkpointsDir);
  const archives = readStateDirEntries(archiveDir);
  unsafeDirectories += checkpoints.unsafe + archives.unsafe;
  if (checkpoints.unreadable || archives.unreadable) unreadable = true;

  const filesScanned = rootNames.length + checkpoints.names.length + archives.names.length;
  const limitExceeded = filesScanned > scanFileLimit;
  // Fail closed and bounded: once the file-count cap is crossed, checkpoint
  // and archive contents are never read. Only name-level totals and the
  // directory-mode findings gathered above are reported, and the audit fails.
  if (limitExceeded) {
    return {
      schema_version: 1,
      state_dir_present: true,
      checkpoints: {
        total: checkpoints.names.filter((name) => name.endsWith(".json")).length,
        valid: 0,
        corrupt: 0,
        unsafe: 0,
        permission_failing: 0,
        invalid_filename: 0,
        missing_archive: 0,
        bytes: 0,
      },
      archives: {
        total: archives.names.filter((name) => name.endsWith(".json")).length,
        linked: 0,
        orphan: 0,
        invalid_filename: 0,
        permission_failing: 0,
        bytes: 0,
      },
      temporary_files:
        countTemporary(rootNames) + countTemporary(checkpoints.names) + countTemporary(archives.names),
      unsafe_directories: unsafeDirectories,
      lineage: { max_depth: 0, cycles: 0, broken_parent_links: 0, over_depth: 0 },
      scan: { files_scanned: filesScanned, limit: scanFileLimit, limit_exceeded: true, unreadable },
      clean: false,
    };
  }
  const checkpointScan = scanCheckpoints(checkpointsDir, checkpoints.names);
  const archiveScan = scanArchives(archiveDir, archives.names, checkpointScan.valid);

  const lineage = assessLineage(checkpointScan.valid, checkpointScan.presentResponseIds);

  const checkpointFindings =
    checkpointScan.corrupt +
    checkpointScan.unsafe +
    checkpointScan.permissionFailing +
    checkpointScan.invalidFilename +
    checkpointScan.missingArchive;
  const archiveFindings = archiveScan.orphan + archiveScan.invalidFilename + archiveScan.permissionFailing;

  const clean =
    checkpointFindings === 0 &&
    archiveFindings === 0 &&
    lineage.cycles === 0 &&
    lineage.broken_parent_links === 0 &&
    lineage.over_depth === 0 &&
    unsafeDirectories === 0 &&
    !limitExceeded &&
    !unreadable;

  return {
    schema_version: 1,
    state_dir_present: true,
    checkpoints: {
      total: checkpointScan.total,
      valid: checkpointScan.valid.length,
      corrupt: checkpointScan.corrupt,
      unsafe: checkpointScan.unsafe,
      permission_failing: checkpointScan.permissionFailing,
      invalid_filename: checkpointScan.invalidFilename,
      missing_archive: checkpointScan.missingArchive,
      bytes: checkpointScan.bytes,
    },
    archives: {
      total: archiveScan.total,
      linked: archiveScan.linked,
      orphan: archiveScan.orphan,
      invalid_filename: archiveScan.invalidFilename,
      permission_failing: archiveScan.permissionFailing,
      bytes: archiveScan.bytes,
    },
    temporary_files:
      countTemporary(rootNames) + countTemporary(checkpoints.names) + countTemporary(archives.names),
    unsafe_directories: unsafeDirectories,
    lineage,
    scan: {
      files_scanned: filesScanned,
      limit: scanFileLimit,
      limit_exceeded: limitExceeded,
      unreadable,
    },
    clean,
  };
}

function cleanEmptyReport(): StateVerifyReportV1 {
  return {
    schema_version: 1,
    state_dir_present: false,
    checkpoints: {
      total: 0,
      valid: 0,
      corrupt: 0,
      unsafe: 0,
      permission_failing: 0,
      invalid_filename: 0,
      missing_archive: 0,
      bytes: 0,
    },
    archives: {
      total: 0,
      linked: 0,
      orphan: 0,
      invalid_filename: 0,
      permission_failing: 0,
      bytes: 0,
    },
    temporary_files: 0,
    unsafe_directories: 0,
    lineage: { max_depth: 0, cycles: 0, broken_parent_links: 0, over_depth: 0 },
    scan: { files_scanned: 0, limit: MAX_STATE_SCAN_FILES, limit_exceeded: false, unreadable: false },
    clean: true,
  };
}

function emptyFindingsReport(): StateVerifyReportV1 {
  return { ...cleanEmptyReport(), clean: false };
}

/** List a state subdirectory without following symlinks; absent is empty. */
function readStateDirEntries(path: string): { names: string[]; unsafe: number; unreadable: boolean } {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory()) return { names: [], unsafe: 1, unreadable: true };
    let unsafe = 0;
    if ((stat.mode & 0o077) !== 0) unsafe += 1;
    try {
      return { names: readdirSync(path), unsafe, unreadable: false };
    } catch {
      return { names: [], unsafe, unreadable: true };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { names: [], unsafe: 0, unreadable: false };
    }
    return { names: [], unsafe: 0, unreadable: true };
  }
}

type CheckpointScan = {
  total: number;
  valid: ValidCheckpoint[];
  corrupt: number;
  unsafe: number;
  permissionFailing: number;
  invalidFilename: number;
  missingArchive: number;
  bytes: number;
  presentResponseIds: Set<string>;
};

function scanCheckpoints(dir: string, names: string[]): CheckpointScan {
  const scan: CheckpointScan = {
    total: names.filter((name) => name.endsWith(".json")).length,
    valid: [],
    corrupt: 0,
    unsafe: 0,
    permissionFailing: 0,
    invalidFilename: 0,
    missingArchive: 0,
    bytes: 0,
    presentResponseIds: new Set<string>(),
  };
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const encoded = name.slice(0, -".json".length);
    const responseId = decodeResponseId(encoded);
    if (!responseId) {
      scan.invalidFilename += 1;
      continue;
    }
    scan.presentResponseIds.add(responseId);
    const path = join(dir, name);
    let stat: Stats;
    try {
      stat = lstatSync(path);
    } catch {
      scan.corrupt += 1;
      continue;
    }
    if (!stat.isFile()) {
      scan.corrupt += 1;
      continue;
    }
    if (stat.size > MAX_STATE_CHECKPOINT_BYTES) {
      scan.corrupt += 1;
      continue;
    }
    if ((stat.mode & 0o077) !== 0) {
      scan.permissionFailing += 1;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      scan.corrupt += 1;
      continue;
    }
    try {
      const node = validateCheckpoint(parsed, responseId);
      // Compact archive linkage: the checkpoint must point at this state
      // root's own archive layout and the archive must be a bounded private
      // regular file. Symlinks, oversized, or unsafe archives fail closed.
      if (node.isCompactionReplacement) {
        const expected = `${ARCHIVE_DIR_NAME}/${encoded}.json`;
        if (node.rawCompactArchive !== expected) {
          scan.missingArchive += 1;
          continue;
        }
        let archiveStat: Stats;
        try {
          archiveStat = lstatSync(join(dir, "..", expected));
        } catch {
          scan.missingArchive += 1;
          continue;
        }
        if (
          !archiveStat.isFile() ||
          archiveStat.size > MAX_UPSTREAM_BODY_BYTES ||
          (archiveStat.mode & 0o077) !== 0
        ) {
          scan.corrupt += 1;
          continue;
        }
      }
      scan.valid.push({
        responseId,
        parentResponseId: node.parentResponseId,
        isCompactionReplacement: node.isCompactionReplacement,
        rawCompactArchive: node.rawCompactArchive,
        bytes: stat.size,
      });
      scan.bytes += stat.size;
    } catch (error) {
      if (isRecord(error) && error.name === "ConversationStateError") {
        if (error.code === "state_checkpoint_unsafe") scan.unsafe += 1;
        else scan.corrupt += 1;
      } else {
        scan.corrupt += 1;
      }
    }
  }
  return scan;
}

type ArchiveScan = {
  total: number;
  linked: number;
  orphan: number;
  invalidFilename: number;
  permissionFailing: number;
  bytes: number;
};

function scanArchives(
  dir: string,
  names: string[],
  valid: readonly ValidCheckpoint[],
): ArchiveScan {
  // Only an exact link from a valid replacement checkpoint makes an archive
  // count as linked; corrupt or non-replacement checkpoints never make an
  // archive look valid.
  const linkedReplacements = new Set(
    valid.filter((node) => node.isCompactionReplacement).map((node) => node.responseId),
  );
  const scan: ArchiveScan = {
    total: names.filter((name) => name.endsWith(".json")).length,
    linked: 0,
    orphan: 0,
    invalidFilename: 0,
    permissionFailing: 0,
    bytes: 0,
  };
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const responseId = decodeResponseId(name.slice(0, -".json".length));
    if (!responseId) {
      scan.invalidFilename += 1;
      continue;
    }
    const path = join(dir, name);
    let stat: Stats;
    try {
      stat = lstatSync(path);
    } catch {
      scan.orphan += 1;
      continue;
    }
    if (!stat.isFile()) {
      scan.orphan += 1;
      continue;
    }
    if ((stat.mode & 0o077) !== 0) {
      scan.permissionFailing += 1;
      continue;
    }
    if (!linkedReplacements.has(responseId)) {
      scan.orphan += 1;
      continue;
    }
    scan.linked += 1;
    scan.bytes += stat.size;
  }
  return scan;
}

/**
 * Bounded lineage check over valid checkpoints only, using the existing
 * chain-depth invariant. Cycles, dangling parents, and chains deeper than the
 * store's fail-closed limit are counted, never traversed unboundedly.
 */
function assessLineage(
  valid: ValidCheckpoint[],
  presentResponseIds: ReadonlySet<string>,
): { max_depth: number; cycles: number; broken_parent_links: number; over_depth: number } {
  const byId = new Map<string, ValidCheckpoint>();
  for (const node of valid) byId.set(node.responseId, node);
  // The store fails closed for chains longer than MAX_STATE_CHAIN_DEPTH + 1
  // nodes; verify records that same threshold as an explicit finding.
  const OVER_DEPTH = MAX_STATE_CHAIN_DEPTH + 2;
  let maxDepth = 0;
  let cycles = 0;
  let broken = 0;
  let overDepth = 0;
  for (const node of valid) {
    if (node.parentResponseId === undefined) {
      maxDepth = Math.max(maxDepth, 1);
      continue;
    }
    if (!byId.has(node.parentResponseId)) {
      // A parent may exist as a present-but-invalid checkpoint file; only a
      // completely absent parent file is a broken link.
      if (!presentResponseIds.has(node.parentResponseId)) broken += 1;
      continue;
    }
    const seen = new Set<string>([node.responseId]);
    let current = node.parentResponseId;
    let depth = 2;
    for (;;) {
      if (seen.has(current)) {
        cycles += 1;
        break;
      }
      seen.add(current);
      const parent = byId.get(current);
      if (depth >= OVER_DEPTH) {
        overDepth += 1;
        break;
      }
      if (!parent) break;
      if (parent.parentResponseId === undefined) {
        maxDepth = Math.max(maxDepth, depth);
        break;
      }
      current = parent.parentResponseId;
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
    }
  }
  return { max_depth: maxDepth, cycles, broken_parent_links: broken, over_depth: overDepth };
}

/** Content-free human summary for `cob state verify`; same assessment as JSON. */
export function formatStateVerifyReport(report: StateVerifyReportV1): string {
  if (!report.state_dir_present) {
    const dirLine = report.scan.unreadable
      ? "state dir: unreadable; audit failed closed"
      : "state dir: absent (nothing to audit)";
    return `${report.clean ? "state verify: clean" : "state verify: findings"}\n${dirLine}`;
  }
  const lines = [
    `${report.clean ? "state verify: clean" : "state verify: findings"}`,
    `checkpoints: total=${report.checkpoints.total} valid=${report.checkpoints.valid} corrupt=${report.checkpoints.corrupt} unsafe=${report.checkpoints.unsafe} permission_failing=${report.checkpoints.permission_failing} invalid_filename=${report.checkpoints.invalid_filename} missing_archive=${report.checkpoints.missing_archive} bytes=${report.checkpoints.bytes}`,
    `compact archives: total=${report.archives.total} linked=${report.archives.linked} orphan=${report.archives.orphan} invalid_filename=${report.archives.invalid_filename} permission_failing=${report.archives.permission_failing} bytes=${report.archives.bytes}`,
    `lineage: max_depth=${report.lineage.max_depth} cycles=${report.lineage.cycles} broken_parent_links=${report.lineage.broken_parent_links} over_depth=${report.lineage.over_depth}`,
    `scan: files=${report.scan.files_scanned} limit=${report.scan.limit} limit_exceeded=${report.scan.limit_exceeded} unreadable=${report.scan.unreadable} temporary=${report.temporary_files} unsafe_dirs=${report.unsafe_directories}`,
    report.clean
      ? "exit 0: state is clean"
      : "exit 1: integrity findings; cob never repairs state — restore or resend full context as needed",
  ];
  return lines.join("\n");
}

function countTemporary(names: string[]): number {
  return names.filter((name) => name.endsWith(".tmp")).length;
}
