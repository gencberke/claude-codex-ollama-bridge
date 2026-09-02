/**
 * WP1.5 checkpoint state-scan cost benchmark. Evidence only: no threshold,
 * no index, no cache, no behavioral change. Not part of `npm test`; excluded
 * from the pack via the eval-* pattern.
 *
 * Usage: node dist/eval-wp15-state-scan.js [population ...]
 * Populations: 0 100 300 500 corrupt permission nearcap (default: short ones
 * first; run nearcap explicitly).
 *
 * Methodology: one Node process and one temp filesystem root. Per population
 * and operation: exactly 30 warmup iterations whose results must all match
 * the first warmup result (determinism gate), then 100 timed iterations.
 * Compaction lookup, real new-checkpoint publication, and cleanup are
 * measured separately. The publish lane creates a fresh, unique response id
 * every iteration (including N=0) with a plain draft that creates no raw
 * archive; after each timed iteration that attempt's checkpoint is removed
 * untimed, so the fixture population stays fixed. Reported per lane: p50/p95
 * in milliseconds, a stable result hash, and the fraction of timed
 * iterations whose result hash matches the warmup result (hit rate).
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ConversationStateStore } from "./codex/state/store.js";
import { ConversationStateError } from "./codex/state/schema.js";
import { encodeResponseId } from "./codex/state/schema.js";

const WARMUP = 30;
const MEASURED = 100;
const NEAR_CAP_FILES = 9_990; // just under MAX_STATE_SCAN_FILES = 10_000
const BIG_RETENTION = { maxNodes: 1_000_000, maxHeads: 1_000_000, maxBytes: 1e12, maxAgeMs: 1e12 };
/** Fixture constants and runOp are exported only as the benchmark-path test seam. */
export const BENCH_MODEL = "bench-model";
export const BENCH_COMPACT_ITEM = { type: "compaction", id: "comp-bench-1" };
const HEAD_ID = "resp-bench-head";
const COMPACTION_ID = "resp-bench-compaction";
const PROGRESS_EVERY = 20;

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}

function resultHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

type BenchDraft = Parameters<ConversationStateStore["publish"]>[0];

/** Plain draft: no rawCompactBody, so publication creates no raw archive. */
function plainDraft(responseId: string): BenchDraft {
  return {
    responseId,
    requestInput: "hi",
    output: [],
    providerInput: [],
    providerOutput: [],
    history: [],
    responseBody: { id: responseId, object: "response", status: "completed", output: [] },
    model: BENCH_MODEL,
    provenance: { source: "ollama-response", gateway: "cob" },
    isCompactionReplacement: false,
    createdAt: "2026-08-31T00:00:00.000Z",
  };
}

export function compactDraft(responseId: string): BenchDraft {
  return {
    ...plainDraft(responseId),
    output: [BENCH_COMPACT_ITEM],
    replacementHistory: [],
    provenance: { source: "ollama-summary", gateway: "cob" },
    isCompactionReplacement: true,
    rawCompactBody: Buffer.from("{}\n", "utf8"),
  };
}

function checkpointPath(stateDir: string, responseId: string): string {
  return join(stateDir, "checkpoints", `${encodeResponseId(responseId)}.json`);
}

async function seedFixture(
  stateDir: string,
  validCount: number,
  corruptCount = 0,
  permissionCount = 0,
): Promise<{ validCount: number; permissionProof: "eacces" | "readable" | "n/a" }> {
  if (validCount > 0) {
    const store = new ConversationStateStore(stateDir, BIG_RETENTION);
    // Publish once to create the exact on-disk shapes, then clone that shape
    // directly for the remaining rows.
    await store.publish(plainDraft(HEAD_ID));
    await store.publish(compactDraft(COMPACTION_ID));
    const template = JSON.parse(readFileSync(checkpointPath(stateDir, HEAD_ID), "utf8")) as Record<string, unknown>;
    for (let i = 2; i < validCount; i += 1) {
      const id = `resp-bench-${String(i).padStart(6, "0")}`;
      const clone = { ...template, responseId: id, responseBody: { ...(template.responseBody as object), id } };
      writeFileSync(checkpointPath(stateDir, id), `${JSON.stringify(clone)}\n`, { mode: 0o600 });
    }
  }
  for (let i = 0; i < corruptCount; i += 1) {
    const id = `resp-bench-corrupt-${String(i).padStart(4, "0")}`;
    writeFileSync(checkpointPath(stateDir, id), "{not-json\n", { mode: 0o600 });
  }
  let permissionProof: "eacces" | "readable" | "n/a" = "n/a";
  for (let i = 0; i < permissionCount; i += 1) {
    const id = `resp-bench-perm-${String(i).padStart(4, "0")}`;
    const path = checkpointPath(stateDir, id);
    writeFileSync(path, `{"template":"perm"}\n`, { mode: 0o600 });
    chmodSync(path, 0o000);
    try {
      readFileSync(path);
      permissionProof = "readable";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EACCES") throw error;
      permissionProof = "eacces";
    }
  }
  return { validCount, permissionProof };
}

type OpResult = { summary: unknown; ok: boolean; cleanup?: () => void };

function createdCheckpointFile(stateDir: string, responseId: string): string {
  return checkpointPath(stateDir, responseId);
}

/** Benchmark-path test seam: the lookup lane under test. */
export async function runOp(
  stateDir: string,
  op: "lookup" | "publish" | "cleanup",
  validCount: number,
  iteration: number,
): Promise<OpResult> {
  const store = new ConversationStateStore(stateDir, BIG_RETENTION);
  if (op === "lookup") {
    try {
      const resolved = await store.resolveCompactionItem(BENCH_COMPACT_ITEM, BENCH_MODEL);
      return { ok: true, summary: { responseId: validCount > 0 ? resolved.responseId : "miss" } };
    } catch (error) {
      // Only the expected missing-compaction state is a measured miss.
      // Conflicts, incompatible checkpoints, and I/O or programming errors
      // must fail the benchmark instead of appearing as deterministic
      // success.
      if (error instanceof ConversationStateError && error.code === "state_checkpoint_missing") {
        return { ok: true, summary: { responseId: "miss" } };
      }
      throw error;
    }
  }
  if (op === "publish") {
    // Real publication: a fresh, unique response id every iteration; the
    // id length is fixed so the result summary stays hash-stable. Removal
    // of exactly this attempt's file happens untimed after the sample.
    const responseId = `resp-wp15-live-${String(iteration).padStart(6, "0")}`;
    await store.publish(plainDraft(responseId));
    const bytes = statSync(createdCheckpointFile(stateDir, responseId)).size;
    return { ok: true, summary: { published: true, bytes }, cleanup: () => unlinkSync(createdCheckpointFile(stateDir, responseId)) };
  }
  const report = await store.cleanup();
  return {
    ok: true,
    summary: {
      removedNodes: report.removedNodes,
      removedBytes: report.removedBytes,
      retainedNodes: report.retainedNodes,
    },
  };
}

async function measureLane(
  label: string,
  stateDir: string,
  op: "lookup" | "publish" | "cleanup",
  validCount: number,
): Promise<void> {
  // Warmup gate: all 30 warmup results must be deterministic. Each warmup
  // publish also removes its own file untimed so the population stays fixed.
  const firstWarmup = await runOp(stateDir, op, validCount, 0);
  firstWarmup.cleanup?.();
  const warmupHash = resultHash(firstWarmup.summary);
  for (let w = 1; w < WARMUP; w += 1) {
    const warm = await runOp(stateDir, op, validCount, w);
    warm.cleanup?.();
    if (!warm.ok) throw new Error(`${label} ${op}: warmup iteration ${w} failed`);
    if (resultHash(warm.summary) !== warmupHash) {
      throw new Error(`${label} ${op}: warmup result ${w} is not deterministic`);
    }
  }
  const samples: number[] = [];
  let hits = 0;
  for (let i = 0; i < MEASURED; i += 1) {
    const start = process.hrtime.bigint();
    const result = await runOp(stateDir, op, validCount, i);
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
    // Untimed: remove exactly what this attempt created; never counted.
    result.cleanup?.();
    if (!result.ok) throw new Error(`${label} ${op}: measured iteration ${i} failed`);
    if (resultHash(result.summary) === warmupHash) hits += 1;
    if ((i + 1) % PROGRESS_EVERY === 0) {
      console.log(`progress: ${label} ${op} ${i + 1}/${MEASURED}`);
    }
  }
  const p50 = median(samples).toFixed(3);
  const p95Value = p95(samples).toFixed(3);
  const hitRate = (hits / MEASURED).toFixed(3);
  const hash12 = warmupHash.slice(0, 12);
  console.log(`${label} | ${op} | ${p50} | ${p95Value} | ${hash12} | ${hitRate}`);
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2);
  const short = ["0", "100", "300", "500", "corrupt", "permission"];
  const populations = requested.length > 0 ? requested : short;
  const root = mkdtempSync(join(tmpdir(), "cob-wp15-state-scan-"));
  try {
    console.log(`node ${process.version}; fs=${tmpdir()}; warmup=${WARMUP} measured=${MEASURED}`);
    console.log("population | op | p50_ms | p95_ms | result_hash | hit_rate");
    let permissionBlocked = false;
    for (const name of populations) {
      const stateDir = join(root, name);
      mkdirSync(join(stateDir, "checkpoints"), { recursive: true, mode: 0o700 });
      let validCount = 0;
      let permissionProof: "eacces" | "readable" | "n/a" = "n/a";
      if (name === "corrupt") {
        ({ validCount, permissionProof } = await seedFixture(stateDir, 500, 50, 0));
      } else if (name === "permission") {
        ({ validCount, permissionProof } = await seedFixture(stateDir, 500, 0, 50));
        if (permissionProof !== "eacces") {
          // The running user cannot produce an unreadable checkpoint (for
          // example under a privileged user); report the lane blocked
          // instead of presenting it as measured evidence.
          console.log(`${name} | BLOCKED | permission population cannot produce EACCES as uid ${process.getuid?.() ?? "unknown"}`);
          permissionBlocked = true;
          continue;
        }
      } else if (name === "nearcap") {
        ({ validCount } = await seedFixture(stateDir, NEAR_CAP_FILES, 0, 0));
      } else {
        const n = Number(name);
        if (!Number.isInteger(n) || n < 0) throw new Error(`unknown population ${name}`);
        ({ validCount } = await seedFixture(stateDir, n, 0, 0));
      }
      for (const op of ["lookup", "publish", "cleanup"] as const) {
        await measureLane(name, stateDir, op, validCount);
      }
    }
    if (permissionBlocked) {
      console.log("permission lane: BLOCKED (unproven), not measured evidence");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
