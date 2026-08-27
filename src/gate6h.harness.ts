/**
 * Isolated Gate 6-H live runner. Not packed. Does not start the live :18790 gateway.
 *
 *   node dist/gate6h.harness.js
 *
 * Uses ~/.codex-cob-dev and cob start --dev. Max three same-fixture attempts.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DEV_PORT, defaultDevHome, defaultLiveHome } from "./install.js";
import { findPackageRoot } from "./install-detection.js";
import { runEvalPreflight } from "./eval-preflight.js";
import {
  GATE6H_CONTROLLER_SEQUENCING_OBSERVED,
  GATE6H_MAX_ATTEMPTS,
  GATE6H_PARENT_MODEL,
  GATE6H_TRANSPORT_UNMEASURED,
  buildGate6hPrompt,
  initialGate6hState,
  isTerminalGate6h,
  reduceGate6hJsonl,
  type Gate6hState,
  type Gate6hVerdict,
} from "./gate6h.js";

const LIVE_CONFIG = join(defaultLiveHome(), "config.toml");
const LIVE_CATALOG = join(defaultLiveHome(), "cob-catalog.json");
const DEV_HOME = defaultDevHome();
const ATTEMPT_TIMEOUT_MS = 12 * 60_000;
const POLL_MS = 200;
const COB_TOML_RESTORE = `# Owned by cob. This is not a Codex profile; cob restore deletes it.
[compaction]
provider = "native"
ollama_threads = "summarize"

[subagents]
models = [
  "ollama/deepseek-v4-flash:0731-cloud",
]

[catalog]
# Default true. Set false to send the full tool list on every Ollama turn.
supports_search_tool = true

[experimental]
native_plaintext_spawn = true
native_plaintext_spawn_schema_sha256 = "5c58ad23b9b5d932368394cea56b157451a33226c0b6018971bebd146fc9b6f3"
`;

type AttemptResult = {
  attempt: number;
  verdict: Gate6hVerdict;
  reason: string;
  parentSession?: string;
  childSession?: string;
};

async function main(): Promise<void> {
  const packageRoot = findPackageRoot(fileURLToPath(import.meta.url));
  if (!packageRoot) throw new Error("Gate 6-H harness must run from the workspace package");
  const cli = join(packageRoot, "dist", "cli.js");
  if (!existsSync(cli)) throw new Error("build dist/cli.js before running Gate 6-H");

  const liveBefore = snapshotLive();
  assertDevHome();
  const preflight = runEvalPreflight({
    lane: "g6h_controller",
    codexHome: DEV_HOME,
    gatewayPort: DEFAULT_DEV_PORT,
    requireDevPort: true,
    liveHome: defaultLiveHome(),
    sandbox: "workspace-write",
    approvalPolicy: "never",
    nativePlaintextSpawn: true,
    expectedLive: {
      configSha256: liveBefore.config,
      catalogSha256: liveBefore.catalog,
    },
  });
  if (!preflight.ok) throw new Error(`${preflight.code}: ${preflight.message}`);
  const cobTomlPath = join(DEV_HOME, "cob.toml");
  const previousToml = existsSync(cobTomlPath) ? readFileSync(cobTomlPath) : undefined;
  writeFileSync(cobTomlPath, COB_TOML_RESTORE);
  const cob = spawnSync(process.execPath, [cli, "start", "--dev"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  if (cob.status !== 0) {
    if (previousToml !== undefined) writeFileSync(cobTomlPath, previousToml);
    throw new Error(`cob start --dev failed: ${cob.stderr || cob.stdout}`);
  }

  const attempts: AttemptResult[] = [];
  try {
    for (let attempt = 1; attempt <= GATE6H_MAX_ATTEMPTS; attempt += 1) {
      const result = await runAttempt(attempt, packageRoot);
      attempts.push(result);
      console.log(JSON.stringify({ type: "attempt", ...result }));
      if (result.verdict === "pass") break;
      if (result.verdict !== "controller_sequencing_fail") break;
    }
  } finally {
    spawnSync(process.execPath, [cli, "stop", "--dev"], { cwd: packageRoot, encoding: "utf8" });
    writeFileSync(cobTomlPath, previousToml ?? COB_TOML_RESTORE);
  }

  const liveAfter = snapshotLive();
  if (liveAfter.config !== liveBefore.config || liveAfter.catalog !== liveBefore.catalog) {
    throw new Error("Gate 6-H must not change live root config or catalog SHA");
  }

  const summary = summarize(attempts);
  const verdictPath = join(DEV_HOME, "gate6h-verdict.json");
  writeFileSync(verdictPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ type: "summary", ...summary, live: liveAfter, verdictPath }));
  process.exitCode = summary.exitCode;
}

function summarize(attempts: AttemptResult[]): {
  verdict: string;
  transport: typeof GATE6H_TRANSPORT_UNMEASURED;
  attempts: AttemptResult[];
  exitCode: number;
} {
  const last = attempts.at(-1);
  if (last?.verdict === "pass") {
    return {
      verdict: "pass",
      transport: GATE6H_TRANSPORT_UNMEASURED,
      attempts,
      exitCode: 0,
    };
  }
  const sequencing = attempts.filter((item) => item.verdict === "controller_sequencing_fail");
  if (sequencing.length >= GATE6H_MAX_ATTEMPTS) {
    return {
      verdict: GATE6H_CONTROLLER_SEQUENCING_OBSERVED,
      transport: GATE6H_TRANSPORT_UNMEASURED,
      attempts,
      exitCode: 2,
    };
  }
  return {
    verdict: last?.verdict ?? "attempt_timeout",
    transport: GATE6H_TRANSPORT_UNMEASURED,
    attempts,
    exitCode: 1,
  };
}

async function runAttempt(attempt: number, cwd: string): Promise<AttemptResult> {
  const known = new Set(listSessionFiles());
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: DEV_HOME };
  delete env.COB_CODEX_HOME;
  const child = spawn(
    "codex",
    [
      "exec",
      "-p",
      "cob",
      "-m",
      GATE6H_PARENT_MODEL,
      "-s",
      "workspace-write",
      "-C",
      cwd,
      "-c",
      'approval_policy="never"',
      "--json",
      buildGate6hPrompt(cwd),
    ],
    {
      cwd,
      env,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr?.resume();

  let parentPath: string | undefined;
  let childPath: string | undefined;
  let childThreadId: string | undefined;
  let parentOffset = 0;
  let childOffset = 0;
  let state = initialGate6hState();
  const started = Date.now();

  try {
    while (!isTerminalGate6h(state)) {
      if (Date.now() - started > ATTEMPT_TIMEOUT_MS) {
        state = { ...state, verdict: "attempt_timeout", reason: `timed out after ${ATTEMPT_TIMEOUT_MS}ms` };
        break;
      }
      if (child.exitCode !== null && !parentPath) {
        await sleep(500);
      }
      const discovered = discoverSessions(known, parentPath, childThreadId);
      parentPath = discovered.parent ?? parentPath;
      childPath = discovered.child ?? childPath;
      if (parentPath) {
        const chunk = readNew(parentPath, parentOffset);
        parentOffset = chunk.offset;
        for (const line of chunk.lines) {
          childThreadId = childThreadId ?? agentThreadIdFromLine(line);
          state = reduceGate6hJsonl(state, line, "parent");
        }
      }
      if (childPath) {
        const chunk = readNew(childPath, childOffset);
        childOffset = chunk.offset;
        for (const line of chunk.lines) state = reduceGate6hJsonl(state, line, "child");
      }
      if (isTerminalGate6h(state)) break;
      if (child.exitCode !== null && Date.now() - started > 2_000) {
        if (parentPath) {
          const chunk = readNew(parentPath, parentOffset);
          parentOffset = chunk.offset;
          for (const line of chunk.lines) state = reduceGate6hJsonl(state, line, "parent");
        }
        if (childPath) {
          const chunk = readNew(childPath, childOffset);
          childOffset = chunk.offset;
          for (const line of chunk.lines) state = reduceGate6hJsonl(state, line, "child");
        }
        if (!isTerminalGate6h(state)) {
          state = {
            ...state,
            verdict: state.sendCount < 2 ? "process_exit_before_trace" : "lost_message",
            reason: "codex exec exited before Gate 6-H gold",
          };
        }
        break;
      }
      await sleep(POLL_MS);
    }
  } finally {
    killTree(child);
  }

  return {
    attempt,
    verdict: state.verdict,
    reason: state.reason,
    parentSession: parentPath,
    childSession: childPath,
  };
}

function discoverSessions(
  known: Set<string>,
  parentPath: string | undefined,
  childThreadId: string | undefined,
): { parent?: string; child?: string } {
  const files = listSessionFiles().filter((file) => !known.has(file) || file === parentPath);
  let parent = parentPath;
  let child: string | undefined;
  for (const file of files) {
    const head = readHead(file);
    if (!head) continue;
    if (head.includes('"source":"exec"') && !parent) parent = file;
    if (head.includes("thread_spawn") && head.includes("gate6h_queue")) child = file;
    if (childThreadId && head.includes(childThreadId) && head.includes("thread_spawn")) child = file;
  }
  if (parent && !child) {
    child = files.find((file) => {
      const head = readHead(file);
      return Boolean(head && head.includes("thread_spawn") && head.includes(basenameId(parent)));
    });
  }
  return { parent, child };
}

function agentThreadIdFromLine(line: string): string | undefined {
  const match = line.match(/"agent_thread_id":"([^"]+)"/);
  return match?.[1];
}

function basenameId(path: string): string {
  const match = path.match(/01[a-f0-9-]+/i);
  return match?.[0] ?? "";
}

function listSessionFiles(): string[] {
  const root = join(DEV_HOME, "sessions");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".jsonl") && entry.name.startsWith("rollout-")) out.push(path);
    }
  };
  walk(root);
  return out.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function readHead(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").slice(0, 4000);
  } catch {
    return undefined;
  }
}

function readNew(path: string, offset: number): { offset: number; lines: string[] } {
  const buf = readFileSync(path);
  if (buf.length <= offset) return { offset, lines: [] };
  const added = buf.subarray(offset).toString("utf8");
  const lines = added.split("\n");
  if (!added.endsWith("\n")) {
    const incomplete = lines.pop() ?? "";
    return { offset: buf.length - Buffer.byteLength(incomplete), lines: lines.filter((line) => line.trim()) };
  }
  return { offset: buf.length, lines: lines.filter((line) => line.trim()) };
}

function snapshotLive(): { config: string; catalog: string } {
  return { config: sha256File(LIVE_CONFIG), catalog: sha256File(LIVE_CATALOG) };
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertDevHome(): void {
  if (!existsSync(join(homedir(), ".codex", "auth.json"))) {
    throw new Error("Gate 6-H needs ~/.codex/auth.json");
  }
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // already gone
  }
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }, 1_000).unref();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
