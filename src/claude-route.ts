import { isAnthropicClaudeModel, stripOllamaPrefix } from "./claude-dialect.js";

/** HTML comment in the child system prompt. First match wins; messages[] are never scanned. */
export const COB_ROUTE_RE = /<!--\s*cob-route:\s*([^\s<>]+)\s*-->/;
export const COB_ROUTE_SCAN_LIMIT = 64 * 1024;

export type CobRouteIgnore = "native_id" | "allowlist" | "empty";

export type CobRouteApply = {
  payload: Record<string, unknown>;
  clientModel: string;
  applied: boolean;
  ignored?: CobRouteIgnore;
  target?: string;
};

export function applyCobRouteDirective(
  payload: Record<string, unknown>,
  allowlist: readonly string[],
): CobRouteApply {
  const clientModel = typeof payload.model === "string" ? payload.model : "";
  const extracted = extractCobRouteTarget(payload.system);
  if (!extracted) {
    return { payload, clientModel, applied: false };
  }
  const target = stripOllamaPrefix(extracted.trim());
  if (target.length === 0) {
    return { payload, clientModel, applied: false, ignored: "empty", target };
  }
  if (isAnthropicClaudeModel(target)) {
    return { payload, clientModel, applied: false, ignored: "native_id", target };
  }
  if (!allowlistHas(allowlist, target)) {
    return { payload, clientModel, applied: false, ignored: "allowlist", target };
  }
  const next: Record<string, unknown> = { ...payload, model: target };
  const system = stripCobRouteComment(payload.system);
  if (system === undefined) delete next.system;
  else next.system = system;
  return { payload: next, clientModel, applied: true, target };
}

export function extractCobRouteTarget(system: unknown): string | undefined {
  const text = systemTextPrefix(system, COB_ROUTE_SCAN_LIMIT);
  const match = COB_ROUTE_RE.exec(text);
  const target = match?.[1]?.trim();
  return target && target.length > 0 ? target : undefined;
}

export function formatClaudeRouteLog(entry: {
  path: string;
  clientModel: string;
  backend: string;
  upstream: string;
  cobRoute: boolean;
  ignored?: CobRouteIgnore;
}): string {
  const ignored = entry.ignored ? ` cob_route_ignored=${entry.ignored}` : "";
  return `[cob claude] route path=${token(entry.path)} client_model=${token(entry.clientModel)} backend=${token(entry.backend)} upstream=${token(entry.upstream)} cob_route=${entry.cobRoute ? "1" : "0"}${ignored}\n`;
}

function allowlistHas(allowlist: readonly string[], target: string): boolean {
  const normalized = stripOllamaPrefix(target);
  return allowlist.some((entry) => stripOllamaPrefix(entry) === normalized);
}

function systemTextPrefix(system: unknown, limit: number): string {
  if (typeof system === "string") return system.slice(0, limit);
  if (!Array.isArray(system)) return "";
  let out = "";
  for (const block of system) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const record = block as Record<string, unknown>;
    if (record.type !== "text" || typeof record.text !== "string") continue;
    out += record.text;
    if (out.length >= limit) return out.slice(0, limit);
  }
  return out;
}

function stripCobRouteComment(system: unknown): unknown {
  if (typeof system === "string") {
    const stripped = system.replace(COB_ROUTE_RE, "").trim();
    return stripped.length > 0 ? stripped : undefined;
  }
  if (!Array.isArray(system)) return system;
  const next: unknown[] = [];
  let replaced = false;
  for (const block of system) {
    if (!replaced && block && typeof block === "object" && !Array.isArray(block)) {
      const record = block as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string" && COB_ROUTE_RE.test(record.text)) {
        replaced = true;
        const text = record.text.replace(COB_ROUTE_RE, "").trim();
        if (text.length > 0) next.push({ ...record, text });
        continue;
      }
    }
    next.push(block);
  }
  return next.length > 0 ? next : undefined;
}

function token(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, "_");
  if (trimmed.length === 0) return "-";
  return trimmed.length > 200 ? trimmed.slice(0, 200) : trimmed;
}
