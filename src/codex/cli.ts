import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { closePrivateLogFd, openPrivateLogFd } from "./runtime/log-fd.js";
import type { CliFlags } from "../cli-session.js";
import { readFileBufferOrNull } from "../core/atomic.js";
import { formatInstallLine } from "../core/install-detection.js";
import { listVisibleSlugs, parseCatalogJson } from "./catalog/catalog.js";
import { LIVE_DESKTOP_RESTART_HINT, shouldPrintDesktopRestartHint } from "./catalog/provenance.js";
import { DEFAULT_SPAWNABLE_OLLAMA_SLUGS } from "./config/schema.js";
import { resolveCliSession, type CliSession } from "./session.js";
import { restoreCob, serveForeground, startGatewayDetached, stopGateway, syncCatalog } from "./runtime/lifecycle.js";
import { statusReport } from "./runtime/status.js";
import { formatStateVerifyReport, verifyStateIntegrity } from "./state/verify.js";
import { runSmoke } from "./smoke.js";
import { configApply, configShow } from "./config/control.js";
import { isHealthyRuntime, readRuntime } from "./runtime/runtime.js";

type StartCompaction = { provider: "native"; model?: string };

export async function runCodexCli(flags: CliFlags): Promise<void> {
  const session = resolveCliSession(flags);
  const { paths, port, install, isolated } = session;

  switch (flags.command) {
    case "start": {
      if (flags.foreground) {
        printStarted(port, isolated, paths.codexHome, install, undefined);
        await serveForeground({
          port,
          ollamaUrl: flags.ollamaUrl,
          paths,
          compaction: startCompaction(flags),
        });
        return;
      }
      mkdirSync(paths.codexHome, { recursive: true, mode: 0o700 });
      const catalogBefore = readFileBufferOrNull(paths.catalog);
      // Establish a private target for diagnostics only when this is not an
      // already healthy runtime. A repeated `cob start` must not even open the
      // existing log; a genuinely new child performs the reset itself.
      const existing = readRuntime(paths);
      if (!existing || !(await isHealthyRuntime(existing))) {
        const targetFd = openPrivateLogFd(paths.log);
        closePrivateLogFd(targetFd);
      }
      const started = await startGatewayDetached({
        paths,
        port,
        ollamaUrl: flags.ollamaUrl,
        spawnServe: ({ token, nonce }) => {
          const args = [
            process.argv[1] ?? "",
            "serve",
            "--port",
            String(port),
            "--ollama-url",
            flags.ollamaUrl,
          ];
          if (flags.compactionProvider) {
            args.push("--compaction-provider", flags.compactionProvider);
          }
          if (flags.compactionModel) {
            args.push("--compaction-model", flags.compactionModel);
          }
          if (flags.liveHome) args.push("--live-home");
          return spawn(process.execPath, args, {
            detached: true,
            // The child owns the rotating writer. Ignoring these descriptors
            // also guarantees a detached child cannot block on a full pipe.
            stdio: ["ignore", "ignore", "ignore"],
            env: {
              ...process.env,
              COB_CODEX_HOME: paths.codexHome,
              COB_LOCK_TOKEN: token,
              COB_RUNTIME_NONCE: nonce,
              COB_DETACHED_LOG: "1",
              ...(flags.liveHome ? { COB_ALLOW_LIVE_HOME: "1" } : {}),
              ...(flags.compactionProvider ? { COB_COMPACTION_PROVIDER: flags.compactionProvider } : {}),
              ...(flags.compactionModel ? { COB_COMPACTION_MODEL: flags.compactionModel } : {}),
            },
          });
        },
      });
      const runtime = started.runtime;
      if (started.alreadyRunning) {
        console.log(`cob already running on 127.0.0.1:${runtime.port} (pid ${runtime.pid})`);
        printLaunchHint(isolated, paths.codexHome);
        return;
      }
      const catalog = (() => {
        try {
          return parseCatalogJson(readFileSync(paths.catalog, "utf8"));
        } catch {
          return { models: [] };
        }
      })();
      const visible = listVisibleSlugs(catalog.models);
      printStarted(port, isolated, paths.codexHome, install, runtime.pid);
      console.log(
        `compaction: provider=${runtime.compaction?.provider ?? "native"}${runtime.compaction?.model ? ` model=${runtime.compaction.model}` : ""} ollama_threads=${runtime.compaction?.ollamaThreads ?? "summarize"}`,
      );
      console.log(`picker models: ${visible.join(", ")}`);
      if (
        shouldPrintDesktopRestartHint(!isolated, catalogBytesChanged(catalogBefore, readFileBufferOrNull(paths.catalog)))
      ) {
        console.log(LIVE_DESKTOP_RESTART_HINT);
      }
      printLaunchHint(isolated, paths.codexHome);
      return;
    }
    case "serve":
      await serveForeground({
        port,
        ollamaUrl: flags.ollamaUrl,
        paths,
        compaction: startCompaction(flags),
      });
      return;
    case "stop":
      if (await stopGateway(paths)) {
        console.log("cob stopped");
      } else {
        console.log("cob was not running");
      }
      return;
    case "restore": {
      await restoreCob(paths);
      console.log("removed cob profile, catalog, catalog metadata, cob.toml, gateway pid, and cob state");
      console.log("root config.toml left unchanged");
      return;
    }
    case "sync": {
      const result = await syncCatalog({
        paths,
        ollamaUrl: flags.ollamaUrl,
      });
      if (result.ollamaError) {
        console.warn(`warning: ${result.ollamaError}`);
      }
      console.log(
        result.wrote
          ? `wrote ${paths.catalog} (${result.catalog.models.length} models, ${result.ollamaCount} ollama)`
          : `catalog unchanged (${result.catalog.models.length} models)`,
      );
      if (shouldPrintDesktopRestartHint(!isolated, result.wrote)) {
        console.log(LIVE_DESKTOP_RESTART_HINT);
      }
      return;
    }
    case "status": {
      const status = await statusReport(paths);
      if (flags.json) {
        console.log(JSON.stringify(status.json, null, 2));
      } else {
        console.log(status.text);
      }
      if (!status.ok) process.exitCode = 1;
      return;
    }
    case "state verify": {
      const report = verifyStateIntegrity(paths.stateDir);
      if (flags.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatStateVerifyReport(report));
      }
      if (!report.clean) process.exitCode = 1;
      return;
    }
    case "config show": {
      if (!flags.json) throw new Error("cob config show requires --json");
      console.log(JSON.stringify(configShow(paths), null, 2));
      return;
    }
    case "config apply": {
      if (!flags.json) throw new Error("cob config apply requires --json");
      const patch = readFileSync(0, "utf8");
      const result = await configApply(paths, parseConfigStdin(patch), { ollamaUrl: flags.ollamaUrl });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "smoke":
      await runSmoke({ live: flags.live, ollamaUrl: flags.ollamaUrl });
      return;
    case "help":
    default:
      printHelp();
      if (flags.command !== "help") {
        process.exitCode = 1;
      }
  }
}

function parseConfigStdin(raw: string): unknown {
  if (Buffer.byteLength(raw, "utf8") > 64 * 1024) {
    throw new Error("config patch exceeds 64 KiB");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("config patch is not valid JSON");
  }
}

function catalogBytesChanged(before: Buffer | null, after: Buffer | null): boolean {
  if (before === null && after === null) return false;
  if (before === null || after === null) return true;
  return !before.equals(after);
}

function startCompaction(flags: { compactionProvider?: string; compactionModel?: string }): StartCompaction | undefined {
  if (!flags.compactionProvider && !flags.compactionModel) return undefined;
  return {
    provider: "native",
    ...(flags.compactionModel ? { model: flags.compactionModel } : {}),
  };
}

function printStarted(
  port: number,
  isolated: boolean,
  codexHome: string,
  install: CliSession["install"],
  pid: number | undefined,
): void {
  const where = pid === undefined ? `http://127.0.0.1:${port}/v1` : `http://127.0.0.1:${port}/v1 (pid ${pid})`;
  console.log(`${formatInstallLine(install)}`);
  console.log(`cob ${isolated ? "dev" : "live"} listening on ${where}`);
  console.log(`codex home: ${codexHome}`);
}

function printLaunchHint(isolated: boolean, codexHome: string): void {
  if (isolated) {
    console.log(`CLI test: CODEX_HOME=${codexHome} codex --profile cob`);
    console.log("ChatGPT Desktop still reads ~/.codex; keep the globally installed cob on :18790 for the app.");
    return;
  }
  console.log("launch Codex CLI with: cob start && codex --profile cob");
  console.log("ChatGPT Desktop uses this gateway when root config.toml openai_base_url points at this port.");
}

export function printHelp(): void {
  const defaultSpawnable = DEFAULT_SPAWNABLE_OLLAMA_SLUGS[0]!;
  console.log(`cob — Codex and Claude Ollama bridges

Surfaces:
  cob start ...          cob Codex (ChatGPT Desktop + codex --profile cob). Live default.
  cob claude start ...   cob Claude (Claude Code / optional Desktop 3P overlay). Live :18792.

Usage (Codex):
  cob start [--port 18790] [--foreground] [--compaction-model <native-slug>]
  cob start --dev [--port 18791]     isolated ~/.codex-cob-dev (does not touch live Desktop)
  cob stop
  cob restore
  cob sync
  cob status [--json]
  cob state verify [--json]   read-only state integrity audit
  cob config show --json       read-only panel configuration and picker state
  cob config apply --json      apply a versioned panel patch from stdin
  cob smoke [--live]
  cob pack                           workspace only: npm pack (no tests in the tarball)
  cob version
  cob claude --help

Live (ChatGPT Desktop + daily CLI):
  npm pack && npm install -g ./codex-ollama-bridge-<version>.tgz
  cob start
  codex --profile cob

Develop against a temporary Codex home (workspace checkout):
  cob start --dev
  CODEX_HOME=~/.codex-cob-dev codex --profile cob

Launch Codex against the live bridge:
  cob start
  codex --profile cob

cob status read-only inspects root config.toml for Desktop overlay keys
(openai_base_url, model_catalog_json, model_provider) against the live gateway.
The first line is cob: ok|ready|broken|absent|unreadable|stale|unknown. Exit 0
only when this Codex home needs no cob action; otherwise exit 1. It never
writes that file and does not spawn Codex or probe Ollama. A stale or
unknown catalog is non-ready even if the gateway is healthy; run cob sync
or cob start to regenerate it. After a reboot or a dead gateway, run cob
start. cob restore does not revert a user-owned Desktop trial.

Compaction is native ChatGPT passthrough for GPT threads. Ollama threads
summarize via Ollama /v1/responses (not /compact). --compaction-model still
selects the native ChatGPT slug. --compaction-provider, if passed, must be
native. Policy is written to cob.toml, not the Codex profile.

Picker-visible Ollama children are listed in cob.toml. Add, remove, or reorder
any discovered ollama/ slug; cob does not impose a roster-size cap:

  [subagents]
  models = ["${defaultSpawnable}"]

  [catalog]
  # Native picker rows follow the bundled Codex catalog automatically.
  # native_include = ["gpt-preview-codex"]
  # native_exclude = ["gpt-legacy-codex"]
  supports_search_tool = true

cob never writes ~/.codex/config.toml. restore deletes cob overlays and the
private cob-state conversation archive.
Ollama parent → GPT child is not supported.
cob start commits only after the child is healthy and overlays are verified
under the cob lock. restore refuses while a start lease is active.
cob sync reads cob.toml under the lock. A running gateway rereads cob-catalog.json
on the next request.
A workspace checkout refuses cob start/stop/restore/sync against live ~/.codex
unless --live-home is passed.`);
}
