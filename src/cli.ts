#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { parseCliArgs, packReleaseTarball, resolveCliSession } from "./cli-session.js";
import { detectInstall, formatInstallLine } from "./install.js";
import {
  restoreCob,
  serveForeground,
  startGatewayDetached,
  statusReport,
  stopGateway,
  syncCatalog,
} from "./lifecycle.js";
import { listVisibleTopSlugs, parseCatalogJson } from "./catalog.js";
import { CobConfigError } from "./cob-config.js";
import { runSmoke } from "./smoke.js";

type StartCompaction = { provider: "native"; model?: string };

async function main(argv: string[]): Promise<void> {
  const flags = parseCliArgs(argv);
  if (flags.command === "version") {
    console.log(formatInstallLine(detectInstall()));
    return;
  }
  const session = resolveCliSession(flags);
  const { paths, port, install, isolated } = session;

  switch (flags.command) {
    case "pack": {
      const packed = packReleaseTarball(install);
      console.log(packed.filename);
      console.log("Install the live Desktop/CLI gateway with:");
      console.log(`  npm install -g ./${packed.filename}`);
      console.log("  cob start");
      return;
    }
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
      mkdirSync(paths.codexHome, { recursive: true });
      const logFd = openSync(paths.log, "a", 0o600);
      try {
        chmodSync(paths.log, 0o600);
      } catch {
        // best-effort on filesystems that ignore mode
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
            stdio: ["ignore", logFd, logFd],
            env: {
              ...process.env,
              COB_CODEX_HOME: paths.codexHome,
              COB_LOCK_TOKEN: token,
              COB_RUNTIME_NONCE: nonce,
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
      const top = listVisibleTopSlugs(catalog.models);
      printStarted(port, isolated, paths.codexHome, install, runtime.pid);
      console.log(
        `compaction: provider=${runtime.compaction?.provider ?? "native"}${runtime.compaction?.model ? ` model=${runtime.compaction.model}` : ""} ollama_threads=${runtime.compaction?.ollamaThreads ?? "summarize"}`,
      );
      console.log(`featured picker: ${top.join(", ")}`);
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
      console.log("removed cob profile, catalog, cob.toml, gateway pid, and cob state");
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
      return;
    }
    case "status":
      console.log(await statusReport(paths));
      return;
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
  install: ReturnType<typeof resolveCliSession>["install"],
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

function printHelp(): void {
  console.log(`cob — Codex Ollama bridge

Usage:
  cob start [--port 18790] [--foreground] [--compaction-model <native-slug>]
  cob start --dev [--port 18791]     isolated ~/.codex-cob-dev (does not touch live Desktop)
  cob stop
  cob restore
  cob sync
  cob status
  cob smoke [--live]
  cob pack                           workspace only: npm pack (no tests in the tarball)
  cob version

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
It never writes that file. cob restore does not revert a user-owned Desktop trial.

Compaction is native ChatGPT passthrough for GPT threads. Ollama threads
summarize via Ollama /v1/responses (not /compact). --compaction-model still
selects the native ChatGPT slug. --compaction-provider, if passed, must be
native. Policy is written to cob.toml, not the Codex profile.

Spawnable Ollama children are listed in cob.toml:

  [subagents]
  models = ["ollama/deepseek-v4-flash:0731-cloud"]

  [catalog]
  supports_search_tool = false

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

main(process.argv).catch((error: unknown) => {
  if (error instanceof CobConfigError) {
    console.error(`${error.code}: ${error.message}`);
    process.exit(1);
  }
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
