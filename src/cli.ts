#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, openSync, readFileSync } from "node:fs";
import {
  parseCliArgs,
  packReleaseTarball,
  resolveClaudeCliSession,
  resolveCliSession,
  type ClaudeCliSession,
  type CliFlags,
} from "./cli-session.js";
import {
  applyClaudeDesktopOverlay,
  assertClaudeDesktopOverlaySupported,
  CLAUDE_DESKTOP_RESTART_HINT,
  restoreClaudeDesktopOverlay,
  snapshotSha,
  type OverlayApplyResult,
} from "./claude/desktop-overlay.js";
import { CLAUDE_SPAWN_AGENTS, syncClaudeSpawnAgents, syncProjectClaudeAgents } from "./claude/agents.js";
import {
  applyUserClaudeAgentsOverlay,
  restoreUserClaudeAgentsOverlay,
  type UserAgentsApplyResult,
} from "./claude/user-agents.js";
import {
  claudeStatusReport,
  openClaudeLog,
  restoreClaudeSurface,
  serveClaudeForeground,
  startClaudeGatewayDetached,
  stopClaudeGateway,
} from "./claude/lifecycle.js";
import { detectInstall, formatInstallLine } from "./core/install-detection.js";
import {
  restoreCob,
  serveForeground,
  startGatewayDetached,
  statusReport,
  stopGateway,
  syncCatalog,
} from "./codex/lifecycle.js";
import { listVisibleTopSlugs, parseCatalogJson } from "./codex/catalog.js";
import { LIVE_DESKTOP_RESTART_HINT, shouldPrintDesktopRestartHint } from "./codex/catalog-provenance.js";
import { CobConfigError, DEFAULT_SPAWNABLE_OLLAMA_SLUGS } from "./codex/cob-config.js";
import { readFileBufferOrNull } from "./core/atomic.js";
import { runSmoke } from "./codex/smoke.js";

type StartCompaction = { provider: "native"; model?: string };
const DEFAULT_CLAUDE_AGENT = CLAUDE_SPAWN_AGENTS[0]!;

async function main(argv: string[]): Promise<void> {
  const flags = parseCliArgs(argv);
  if (flags.command === "version") {
    console.log(formatInstallLine(detectInstall()));
    return;
  }
  if (flags.command === "pack") {
    const packed = packReleaseTarball(detectInstall());
    console.log(packed.filename);
    console.log("Install the live Desktop/CLI gateway with:");
    console.log(`  npm install -g ./${packed.filename}`);
    console.log("  cob start");
    return;
  }
  if (flags.surface === "claude") {
    await runClaudeCli(flags);
    return;
  }
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
      mkdirSync(paths.codexHome, { recursive: true });
      const catalogBefore = readFileBufferOrNull(paths.catalog);
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
      if (
        !started.alreadyRunning &&
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
      console.log(status.text);
      if (!status.ok) process.exitCode = 1;
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

async function runClaudeCli(flags: CliFlags): Promise<void> {
  const session = resolveClaudeCliSession(flags);
  const { paths, port } = session;
  switch (flags.command) {
    case "start": {
      const agents = syncClaudeSpawnAgents(session.paths);
      if (flags.foreground) {
        const desktop = applyClaudeDesktopIfRequested(flags, session);
        printClaudeStarted(session, undefined, desktop);
        printClaudeLaunchHint(session, desktop.overlay !== undefined);
        printClaudeAgentsHint(session, agents.wrote.length);
        await serveClaudeForeground({ port, ollamaUrl: flags.ollamaUrl, paths });
        return;
      }
      const logFd = openClaudeLog(paths);
      const started = await startClaudeGatewayDetached({
        paths,
        port,
        ollamaUrl: flags.ollamaUrl,
        spawnServe: ({ token: _token }) => {
          const args = [
            process.argv[1] ?? "",
            "claude",
            "serve",
            "--port",
            String(port),
            "--ollama-url",
            flags.ollamaUrl,
            "--home",
            paths.claudeHome,
          ];
          if (flags.liveHome) args.push("--live-home");
          if (flags.dev) args.push("--dev");
          return spawn(process.execPath, args, {
            detached: true,
            stdio: ["ignore", logFd, logFd],
            env: {
              ...process.env,
              COB_CLAUDE_HOME: paths.claudeHome,
              ANTHROPIC_API_KEY: "",
              ANTHROPIC_AUTH_TOKEN: "",
              ...(flags.liveHome ? { COB_ALLOW_LIVE_HOME: "1" } : {}),
            },
          });
        },
      });
      const desktop = applyClaudeDesktopIfRequested(flags, session);
      if (started.alreadyRunning) {
        console.log(`cob claude already running on 127.0.0.1:${started.runtime.port} (pid ${started.runtime.pid})`);
        printClaudeDesktopApply(desktop);
        printClaudeLaunchHint(session, desktop.overlay !== undefined);
        printClaudeAgentsHint(session, agents.wrote.length);
        return;
      }
      printClaudeStarted(session, started.runtime.pid, desktop);
      printClaudeLaunchHint(session, desktop.overlay !== undefined);
      printClaudeAgentsHint(session, agents.wrote.length);
      return;
    }
    case "serve":
      await serveClaudeForeground({ port, ollamaUrl: flags.ollamaUrl, paths });
      return;
    case "stop":
      if (await stopClaudeGateway(paths)) {
        console.log("cob claude stopped");
      } else {
        console.log("cob claude was not running");
      }
      return;
    case "restore": {
      await stopClaudeGateway(paths);
      restoreClaudeSurface(paths);
      console.log("removed cob-owned Claude runtime files");
      const restoredAgents = restoreUserClaudeAgentsOverlay({ overlayDir: paths.desktopOverlay });
      const restoredDesktop = restoreClaudeDesktopOverlay({ overlayDir: paths.desktopOverlay });
      if (restoredAgents) {
        console.log("restored ~/.claude/agents cob overlay snapshot");
      }
      if (restoredDesktop) {
        console.log("restored Claude Desktop 3P overlay snapshot");
        console.log(CLAUDE_DESKTOP_RESTART_HINT);
      }
      if (!restoredAgents && !restoredDesktop) {
        console.log("~/.claude/settings.json and Claude Desktop left unchanged");
      }
      return;
    }
    case "status": {
      const status = await claudeStatusReport(paths);
      console.log(status.text);
      if (!status.ok) process.exitCode = 1;
      return;
    }
    case "sync":
      console.log("cob claude has no catalog sync. Claude Code keeps its picker; Ollama slugs are request model fields.");
      return;
    case "agents": {
      const project = flags.dir ?? process.cwd();
      const result = syncProjectClaudeAgents(project);
      console.log(`project agents: ${result.agentsDir} (${result.wrote.length} written)`);
      console.log(`Ask Claude Code for subagent ${DEFAULT_CLAUDE_AGENT.name}. Do not spawn built-in haiku for this slot.`);
      console.log("cob did not write ~/.claude/agents.");
      return;
    }
    case "help":
    default:
      printClaudeHelp();
      if (flags.command !== "help") process.exitCode = 1;
  }
}

type ClaudeDesktopApply = {
  overlay?: OverlayApplyResult;
  userAgents?: UserAgentsApplyResult;
};

function printClaudeStarted(
  session: ClaudeCliSession,
  pid: number | undefined,
  desktop: ClaudeDesktopApply,
): void {
  const where =
    pid === undefined ? `http://127.0.0.1:${session.port}/v1` : `http://127.0.0.1:${session.port}/v1 (pid ${pid})`;
  console.log(`${formatInstallLine(session.install)}`);
  console.log(`cob claude ${session.isolated ? "dev" : "live"} listening on ${where}`);
  console.log(`claude home: ${session.paths.claudeHome}`);
  if (desktop.overlay) {
    printClaudeDesktopApply(desktop);
    return;
  }
  console.log("cob did not write ~/.claude/settings.json or Claude Desktop config.");
}

function printClaudeDesktopApply(desktop: ClaudeDesktopApply): void {
  if (!desktop.overlay) return;
  console.log(
    `desktop overlay: applied sha256=${snapshotSha(desktop.overlay.manifest)} gateway=${desktop.overlay.manifest.gatewayBaseUrl}`,
  );
  if (desktop.userAgents) {
    console.log(
      `user agents overlay: wrote ${desktop.userAgents.wrote.length} skipped ${desktop.userAgents.skipped.length}`,
    );
  }
  console.log("cob did not write ~/.claude/settings.json.");
  console.log(CLAUDE_DESKTOP_RESTART_HINT);
}

function printClaudeLaunchHint(session: ClaudeCliSession, desktop: boolean): void {
  console.log("Launch Claude Code against this gateway (OAuth must stay on; do not set ANTHROPIC_AUTH_TOKEN=ollama):");
  console.log(`  unset ANTHROPIC_API_KEY`);
  console.log(`  ANTHROPIC_BASE_URL=http://127.0.0.1:${session.port} claude --model opus`);
  console.log("  cob claude agents --dir .    # project .claude/agents (not ~/.claude/agents)");
  console.log(`Ollama child: ask for ${DEFAULT_CLAUDE_AGENT.name} (${DEFAULT_CLAUDE_AGENT.model}), not built-in haiku. Agent tool still sends a haiku placeholder; cob-route rewrites it.`);
  console.log(`CLAUDE_CONFIG_DIR=${session.paths.codeConfig} isolates agents but also isolates login; prefer project agents with live ~/.claude auth.`);
  if (desktop) {
    console.log("Claude Desktop 3P overlay plus cob-owned ~/.claude/agents/cob-*.md (snapshot + restore). Not settings.json.");
    console.log("Native Claude ids are never rewritten to Ollama.");
  }
}

function printClaudeAgentsHint(session: ClaudeCliSession, wrote: number): void {
  console.log(`cob-owned agents: ${session.paths.agents} (${wrote} written)`);
}

function applyClaudeDesktopIfRequested(
  flags: CliFlags,
  session: ClaudeCliSession,
): ClaudeDesktopApply {
  if (!flags.desktop) return {};
  assertClaudeDesktopOverlaySupported();
  const overlay = applyClaudeDesktopOverlay({
    overlayDir: session.paths.desktopOverlay,
    gatewayBaseUrl: `http://127.0.0.1:${session.port}`,
  });
  const userAgents = applyUserClaudeAgentsOverlay({
    overlayDir: session.paths.desktopOverlay,
  });
  return { overlay, userAgents };
}

function printClaudeHelp(): void {
  console.log(`cob claude — Claude Code / Claude Desktop Ollama bridge

Usage:
  cob claude start [--port 18792] [--foreground]
  cob claude start --desktop
  cob claude start --dev [--port 18793]
  cob claude start --dev --desktop
  cob claude agents --dir .
  cob claude stop
  cob claude restore
  cob claude status

cob claude is a Messages loopback: claude-* / opus / sonnet / haiku / fable
go to api.anthropic.com with OAuth forwarded; other model ids go to Ollama
/v1/messages. Native Claude ids are never rewritten to Ollama. Spawn uses
cob-owned agents + a system cob-route marker, not haiku/fable slot steals.

Live (global install): ~/.claude-cob and :18792. Workspace checkouts use
--dev (~/.claude-cob-dev, :18793) and refuse live ~/.claude-cob unless
--live-home. cob never writes ~/.claude/settings.json or runs ollama launch
claude. --desktop snapshots then writes a cob-owned Claude Desktop 3P
overlay and cob-owned ~/.claude/agents/cob-*.md; cob claude restore reverts
those snapshots.

cob start remains cob Codex on :18790. Do not point ChatGPT Desktop at
cob claude.
`);
}

function printHelp(): void {
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
  cob status
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

Spawnable Ollama children are listed in cob.toml:

  [subagents]
  models = ["${defaultSpawnable}"]

  [catalog]
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

main(process.argv).catch((error: unknown) => {
  if (error instanceof CobConfigError) {
    console.error(`${error.code}: ${error.message}`);
    process.exit(1);
  }
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
