import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import type { ClaudePaths } from "./claude-paths.js";
import { DEFAULT_OLLAMA_SPAWN_MODEL } from "./ollama-default-model.js";
import {
  USER_CLAUDE_HOME_REFUSAL,
  assertNotUserClaudeHome,
  defaultUserClaudeHome,
} from "./claude-home.js";
import { samePath } from "./install-detection.js";

export const CLAUDE_AGENT_MARKER = "generated-by: cob";
export const CLAUDE_CODE_DIRNAME = "code";
export const CLAUDE_AGENTS_DIRNAME = "agents";

export type ClaudeSpawnAgent = {
  name: string;
  model: string;
  description: string;
};

/** Stable Claude agent name; its default route follows cob Codex's V1 model. */
export const CLAUDE_SPAWN_AGENTS: readonly ClaudeSpawnAgent[] = [
  {
    name: "cob-deepseek-0731",
    model: DEFAULT_OLLAMA_SPAWN_MODEL,
    description: `Delegate work to cob's Ollama child ${DEFAULT_OLLAMA_SPAWN_MODEL}. Invoke this custom agent as cob-deepseek-0731. Do not spawn the built-in haiku subagent for this slot; cob routes from the agent body.`,
  },
];

export const CLAUDE_SPAWN_ALLOWLIST: readonly string[] = CLAUDE_SPAWN_AGENTS.map((agent) => agent.model);

export function claudeCodeConfigDir(claudeHome: string): string {
  return join(claudeHome, CLAUDE_CODE_DIRNAME);
}

export function claudeAgentsDir(claudeHome: string): string {
  return join(claudeCodeConfigDir(claudeHome), CLAUDE_AGENTS_DIRNAME);
}

export function projectClaudeAgentsDir(projectRoot: string): string {
  return join(resolve(projectRoot), ".claude", CLAUDE_AGENTS_DIRNAME);
}

export function syncClaudeSpawnAgents(paths: ClaudePaths): { wrote: string[]; pruned: string[] } {
  assertNotUserClaudeHome(paths.claudeHome);
  const agentsDir = claudeAgentsDir(paths.claudeHome);
  return writeOwnedRoster(agentsDir, paths.claudeHome);
}

/** Project `.claude/agents` for CLI spawn. Never `~/.claude/agents`. */
export function syncProjectClaudeAgents(projectRoot: string): {
  wrote: string[];
  pruned: string[];
  agentsDir: string;
} {
  const root = resolve(projectRoot);
  const claudeDir = join(root, ".claude");
  const agentsDir = projectClaudeAgentsDir(root);
  assertOutsideUserClaudeHome(root);
  assertOutsideUserClaudeHome(claudeDir);
  assertOutsideUserClaudeHome(agentsDir);
  const result = writeOwnedRoster(agentsDir, root);
  return { ...result, agentsDir };
}

export function removeOwnedClaudeAgents(paths: ClaudePaths): string[] {
  assertNotUserClaudeHome(paths.claudeHome);
  const agentsDir = claudeAgentsDir(paths.claudeHome);
  if (!existsSync(agentsDir)) return [];
  assertPathInsideRoot(paths.claudeHome, agentsDir);
  const pruned = pruneUnrosteredOwnedAgents(agentsDir, new Set(), paths.claudeHome);
  removeEmptyDirs(agentsDir, paths.claudeHome);
  return pruned;
}

export function renderClaudeAgentFile(agent: ClaudeSpawnAgent): string {
  return [
    "---",
    `name: ${JSON.stringify(agent.name)}`,
    `description: ${JSON.stringify(agent.description)}`,
    `model: ${JSON.stringify(agent.model)}`,
    "---",
    "",
    `<!-- ${CLAUDE_AGENT_MARKER} -->`,
    `<!-- cob-route: ${agent.model} -->`,
    "",
    `You are a delegated worker running on \`${agent.model}\` through the cob Claude gateway.`,
    "If asked which model you are, answer with that id; do not claim to be Claude.",
    "Complete the dispatched task directly and report results concisely.",
    "",
  ].join("\n");
}

function writeOwnedRoster(agentsDir: string, boundRoot: string): { wrote: string[]; pruned: string[] } {
  assertPathInsideRoot(boundRoot, agentsDir);
  const owned = new Set<string>();
  const wrote: string[] = [];
  for (const agent of CLAUDE_SPAWN_AGENTS) {
    const path = join(agentsDir, `${agent.name}.md`);
    assertPathInsideRoot(boundRoot, path);
    owned.add(resolve(path));
    if (existsSync(path) && !isOwnedClaudeAgentFile(path)) continue;
    writeFileAtomic(path, renderClaudeAgentFile(agent));
    wrote.push(path);
  }
  const pruned = pruneUnrosteredOwnedAgents(agentsDir, owned, boundRoot);
  return { wrote, pruned };
}

function pruneUnrosteredOwnedAgents(agentsDir: string, keep: Set<string>, boundRoot: string): string[] {
  if (!existsSync(agentsDir)) return [];
  const pruned: string[] = [];
  for (const entry of readdirSync(agentsDir)) {
    if (!entry.startsWith("cob-") || !entry.endsWith(".md")) continue;
    const path = join(agentsDir, entry);
    assertPathInsideRoot(boundRoot, path);
    if (keep.has(resolve(path))) continue;
    if (!isOwnedClaudeAgentFile(path)) continue;
    unlinkSync(path);
    pruned.push(path);
  }
  return pruned;
}

export function isOwnedClaudeAgentFile(path: string): boolean {
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return false;
    return readFileSync(path, "utf8").includes(CLAUDE_AGENT_MARKER);
  } catch {
    return false;
  }
}

function assertOutsideUserClaudeHome(target: string, userHome = defaultUserClaudeHome()): void {
  let resolved = resolve(target);
  try {
    if (existsSync(resolved)) resolved = realpathSync(resolved);
  } catch {
    resolved = resolve(target);
  }
  const user = resolve(userHome);
  if (samePath(resolved, user) || resolved.startsWith(`${user}${sep}`)) {
    throw new Error(USER_CLAUDE_HOME_REFUSAL);
  }
}

function assertPathInsideRoot(root: string, target: string): void {
  const home = resolve(root);
  const resolved = resolve(target);
  const rel = relative(home, resolved);
  if (rel.length === 0) return;
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("cob claude refuses to write agents outside the target root");
  }
}

function removeEmptyDirs(start: string, claudeHome: string): void {
  let current = start;
  const home = resolve(claudeHome);
  const prefix = `${home}${sep}`;
  while (resolve(current) === home || resolve(current).startsWith(prefix)) {
    if (resolve(current) === home) return;
    try {
      if (readdirSync(current).length > 0) return;
      rmdirSync(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}
