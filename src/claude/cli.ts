import { spawn } from "node:child_process";
import type { CliFlags } from "../cli-session.js";
import { formatInstallLine } from "../core/install-detection.js";
import { CLAUDE_DESKTOP_RESTART_HINT, applyClaudeDesktopOverlay, assertClaudeDesktopOverlaySupported, snapshotSha, type OverlayApplyResult } from "./desktop-overlay.js";
import { CLAUDE_SPAWN_AGENTS, syncClaudeSpawnAgents, syncProjectClaudeAgents } from "./agents.js";
import { applyUserClaudeAgentsOverlay, type UserAgentsApplyResult } from "./user-agents.js";
import {
  claudeStatusReport,
  ensureClaudeDesktopToken,
  openClaudeLog,
  restoreClaudeGateway,
  serveClaudeForeground,
  startClaudeGatewayDetached,
  stopClaudeGateway,
} from "./lifecycle.js";
import { resolveClaudeCliSession, type ClaudeCliSession } from "./session.js";

const DEFAULT_CLAUDE_AGENT = CLAUDE_SPAWN_AGENTS[0]!;

export async function runClaudeCli(flags: CliFlags): Promise<void> {
  const session = resolveClaudeCliSession(flags);
  const { paths, port } = session;
  switch (flags.command) {
    case "start": {
      if (flags.foreground) {
        let desktop: ClaudeDesktopApply = {};
        let agentCount = 0;
        await serveClaudeForeground({
          port,
          ollamaUrl: flags.ollamaUrl,
          paths,
          onBooted: () => {
            agentCount = syncClaudeSpawnAgents(paths).wrote.length;
            desktop = applyClaudeDesktopIfRequested(flags, session, ensureClaudeDesktopToken(paths));
            printClaudeStarted(session, undefined, desktop);
            printClaudeLaunchHint(session, desktop.overlay !== undefined);
            printClaudeAgentsHint(session, agentCount);
          },
        });
        return;
      }
      let agentCount = 0;
      let desktop: ClaudeDesktopApply = {};
      const started = await startClaudeGatewayDetached({
        paths,
        port,
        ollamaUrl: flags.ollamaUrl,
        prepare: () => {
          agentCount = syncClaudeSpawnAgents(paths).wrote.length;
        },
        commit: () => {
          desktop = applyClaudeDesktopIfRequested(flags, session, ensureClaudeDesktopToken(paths));
        },
        spawnServe: ({ token }) => {
          const logFd = openClaudeLog(paths);
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
              COB_LOCK_TOKEN: token,
              COB_CLAUDE_HOME: paths.claudeHome,
              ANTHROPIC_API_KEY: "",
              ANTHROPIC_AUTH_TOKEN: "",
              ...(flags.liveHome ? { COB_ALLOW_LIVE_HOME: "1" } : {}),
            },
          });
        },
      });
      if (started.alreadyRunning) {
        console.log(`cob claude already running on 127.0.0.1:${started.runtime.port} (pid ${started.runtime.pid})`);
        printClaudeDesktopApply(desktop);
        printClaudeLaunchHint(session, desktop.overlay !== undefined);
        printClaudeAgentsHint(session, agentCount);
        return;
      }
      printClaudeStarted(session, started.runtime.pid, desktop);
      printClaudeLaunchHint(session, desktop.overlay !== undefined);
      printClaudeAgentsHint(session, agentCount);
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
      const restored = await restoreClaudeGateway(paths);
      if (restored.stopped) {
        console.log("cob claude stopped");
      }
      console.log("removed cob-owned Claude runtime files");
      if (restored.agentsRestored) {
        console.log("restored ~/.claude/agents cob overlay snapshot");
      }
      if (restored.desktopRestored) {
        console.log("restored Claude Desktop 3P overlay snapshot");
        console.log(CLAUDE_DESKTOP_RESTART_HINT);
      }
      if (!restored.agentsRestored && !restored.desktopRestored) {
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
  gatewayApiKey: string,
): ClaudeDesktopApply {
  if (!flags.desktop) return {};
  assertClaudeDesktopOverlaySupported();
  const overlay = applyClaudeDesktopOverlay({
    overlayDir: session.paths.desktopOverlay,
    gatewayBaseUrl: `http://127.0.0.1:${session.port}`,
    gatewayApiKey,
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
