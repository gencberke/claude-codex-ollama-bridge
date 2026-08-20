import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const ROOT_KEYS = ["model_provider", "openai_base_url", "model_catalog_json", "profile"] as const;

export type RootTomlKey = (typeof ROOT_KEYS)[number];

export type RootTomlKeys = Partial<Record<RootTomlKey, string>>;

export type DesktopOverlayState = "ok" | "ready" | "broken" | "absent" | "unreadable";

export type DesktopOverlayInput = {
  /** `null` when config.toml is missing. */
  keys: RootTomlKeys | null;
  readError?: string;
  cobCatalogPath: string;
  cobCatalogExists: boolean;
  codexHome: string;
  /** Port from cob.config.toml `openai_base_url`, if the profile exists. */
  profilePort?: number;
  /** Port cob last recorded, if a runtime file exists. */
  runtimePort?: number;
  gatewayHealthy: boolean;
};

export type DesktopOverlayAssessment = {
  state: DesktopOverlayState;
  lines: string[];
};

/**
 * Pull selected assignments from the TOML root table only. Keys after the first
 * `[table]` belong to that table and are ignored — Desktop app-server does not
 * honor `--profile cob`, so cob overlay keys must sit at true root.
 */
export function parseRootTomlKeys(text: string): RootTomlKeys {
  const keys: RootTomlKeys = {};
  let section = "";
  let inArray = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (line.length === 0) continue;
    if (inArray) {
      if (line.includes("]")) inArray = false;
      continue;
    }
    if (line.startsWith("[")) {
      section = line.replace(/^\[+/, "").replace(/\]+$/, "").trim();
      continue;
    }
    if (section.length > 0) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const rawValue = line.slice(eq + 1).trim();
    if (rawValue === "[" || (rawValue.startsWith("[") && !rawValue.endsWith("]"))) {
      inArray = true;
      continue;
    }
    if (!isRootTomlKey(key)) continue;
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) continue;
    const value = unquoteToml(rawValue);
    if (value.length > 0) keys[key] = value;
  }
  return keys;
}

export function assessDesktopOverlay(input: DesktopOverlayInput): DesktopOverlayAssessment {
  if (input.readError) {
    return {
      state: "unreadable",
      lines: [
        `desktop overlay: cannot read root config.toml`,
        `  ${input.readError}`,
        "  cob does not write config.toml.",
      ],
    };
  }
  if (input.keys === null) {
    return {
      state: "absent",
      lines: [
        "desktop overlay: no root config.toml",
        "  Desktop app-server reads only this file (no --profile cob).",
        "  CLI still uses cob.config.toml with: codex --profile cob",
      ],
    };
  }

  const problems = overlayProblems(input);
  const expectedPort = input.runtimePort ?? input.profilePort;
  const extra: string[] = [];
  if (input.keys.profile === "cob") {
    extra.push(
      '  warning: root profile = "cob" is ignored since Codex 0.134; Desktop reads only root keys',
    );
  }

  if (problems.length > 0) {
    const lines = [
      "desktop overlay: broken",
      ...problems.map((problem) => `  ${problem.text}`),
      ...extra,
    ];
    if (problems.some((problem) => problem.kind === "root")) {
      lines.push(
        "  cob restore does not revert config.toml. Restore your backup, then fully quit and reopen ChatGPT.",
      );
    }
    return { state: "broken", lines };
  }

  const url = input.keys.openai_base_url ?? "";
  if (!input.gatewayHealthy) {
    const where = expectedPort !== undefined ? `http://127.0.0.1:${expectedPort}/v1` : url;
    const why = input.runtimePort !== undefined ? "gateway not healthy" : "gateway stopped";
    return {
      state: "ready",
      lines: [
        `desktop overlay: ready (${why}; run cob start)`,
        `  root openai_base_url is ${where}`,
        ...extra,
      ],
    };
  }

  return {
    state: "ok",
    lines: [
      "desktop overlay: ok",
      "  openai_base_url and model_catalog_json point at cob; cob will not write config.toml",
      ...extra,
    ],
  };
}

export function loadRootTomlKeys(rootConfigPath: string): {
  keys: RootTomlKeys | null;
  readError?: string;
} {
  try {
    return { keys: parseRootTomlKeys(readFileSync(rootConfigPath, "utf8")) };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "ENOENT") return { keys: null };
    return { keys: null, readError: error instanceof Error ? error.message : String(error) };
  }
}

export function openaiPortFromToml(text: string): number | undefined {
  const keys = parseRootTomlKeys(text);
  if (!keys.openai_base_url) return undefined;
  const parsed = parseLoopbackBaseUrl(keys.openai_base_url);
  return parsed.ok ? parsed.port : undefined;
}

export function parseLoopbackBaseUrl(
  url: string,
): { ok: true; port: number; host: string; pathname: string } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `openai_base_url is not a valid URL: ${url}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `openai_base_url must be http(s), got ${parsed.protocol}` };
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    return { ok: false, reason: `openai_base_url must be loopback, got ${parsed.hostname}` };
  }
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === "https:"
      ? 443
      : 80;
  if (!Number.isInteger(port) || port <= 0) {
    return { ok: false, reason: `openai_base_url has an invalid port` };
  }
  return { ok: true, port, host: parsed.hostname, pathname: parsed.pathname };
}

export function sameFilesystemPath(left: string, right: string, baseDir: string): boolean {
  return canonicalizePath(left, baseDir) === canonicalizePath(right, baseDir);
}

export function canonicalizePath(value: string, baseDir: string): string {
  const expanded = expandUserPath(value.trim());
  const absolute = isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
  try {
    if (existsSync(absolute)) return realpathSync(absolute);
  } catch {
    // fall through
  }
  return normalize(absolute);
}

type OverlayProblem = { kind: "root" | "cob"; text: string };

function overlayProblems(input: DesktopOverlayInput): OverlayProblem[] {
  const keys = input.keys;
  if (!keys) return [];
  const problems: OverlayProblem[] = [];
  const provider = keys.model_provider;
  if (provider !== undefined && provider !== "openai") {
    problems.push({
      kind: "root",
      text: `model_provider = "${provider}" (Desktop must keep model_provider = "openai" for loopback)`,
    });
  }
  if (!keys.openai_base_url) {
    problems.push({
      kind: "root",
      text: "openai_base_url is missing; Desktop app-server will not send traffic to cob",
    });
  } else {
    const parsed = parseLoopbackBaseUrl(keys.openai_base_url);
    if (!parsed.ok) {
      problems.push({ kind: "root", text: parsed.reason });
    } else {
      const expectedPort = input.runtimePort ?? input.profilePort;
      if (expectedPort !== undefined && parsed.port !== expectedPort) {
        const vs =
          input.runtimePort !== undefined
            ? `live gateway on ${expectedPort}`
            : `cob.config.toml port ${expectedPort}`;
        problems.push({
          kind: "root",
          text: `openai_base_url port ${parsed.port} does not match ${vs}`,
        });
      }
      if (!isPlausibleCobBasePath(parsed.pathname)) {
        problems.push({
          kind: "root",
          text: `openai_base_url path should be /v1, got ${parsed.pathname || "/"}`,
        });
      }
    }
  }
  if (!keys.model_catalog_json) {
    problems.push({
      kind: "root",
      text: "model_catalog_json is missing; Desktop will not list ollama/* from the cob catalog",
    });
  } else if (!sameFilesystemPath(keys.model_catalog_json, input.cobCatalogPath, input.codexHome)) {
    problems.push({
      kind: "root",
      text: `model_catalog_json points at ${keys.model_catalog_json}, not the cob catalog ${input.cobCatalogPath}`,
    });
  } else if (!input.cobCatalogExists) {
    problems.push({ kind: "cob", text: "cob catalog file is missing; run cob start or cob sync" });
  }
  return problems;
}

function isPlausibleCobBasePath(pathname: string): boolean {
  const trimmed = pathname.replace(/\/+$/, "") || "/";
  return trimmed === "/" || trimmed === "/v1";
}

function expandUserPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function isRootTomlKey(key: string): key is RootTomlKey {
  return (ROOT_KEYS as readonly string[]).includes(key);
}

function stripTomlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if ((inSingle || inDouble) && char === "\\") {
      i += 1;
      continue;
    }
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === "#" && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

function unquoteToml(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}
