import { createHash } from "node:crypto";
import { jsonUtf8Bytes } from "./request-metrics.js";
import type { JsonObject } from "./types.js";
import { isRecord } from "./types.js";

export const TOOL_SEARCH_NAME = "tool_search";
export const PROMOTED_LEAF_CAP = 16;
export const PROMOTED_BYTES_CAP = 32 * 1024;

const MAX_ALIAS_LEN = 64;
const ALIAS_RE = /[^A-Za-z0-9_-]+/g;
const INCOMPLETE_STATUS = new Set(["in_progress", "incomplete", "failed", "cancelled", "expired"]);

const DEFAULT_DESCRIPTION =
  "Search for deferred tools by query. Use this to find MCP or app tools that were not listed up front.";

const DEFAULT_PARAMETERS: JsonObject = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query for deferred tools." },
    limit: { type: "number", description: "Maximum number of tools to return." },
  },
  required: ["query"],
  additionalProperties: false,
};

export type DeferredToolIdentity = {
  name: string;
  namespace?: string;
};

export type ToolSearchBridge = {
  aliases: Map<string, DeferredToolIdentity>;
  promotedN: number;
  promotedBytes: number;
  skippedCap: number;
  skippedInvalid: number;
  skippedUnsupported: number;
  collisions: number;
};

export type ToolSearchToOllamaOptions = {
  leafCap?: number;
  bytesCap?: number;
};

export function emptyToolSearchBridge(): ToolSearchBridge {
  return {
    aliases: new Map(),
    promotedN: 0,
    promotedBytes: 0,
    skippedCap: 0,
    skippedInvalid: 0,
    skippedUnsupported: 0,
    collisions: 0,
  };
}

/** Codex-facing `tool_search` / history items → Ollama function tools. */
export function rewriteToolSearchToOllama(
  payload: JsonObject,
  options: ToolSearchToOllamaOptions = {},
): JsonObject {
  applyDeferredToolsToOllama(payload, options);
  return payload;
}

export function applyDeferredToolsToOllama(
  payload: JsonObject,
  options: ToolSearchToOllamaOptions = {},
): ToolSearchBridge {
  const bridge = emptyToolSearchBridge();
  const leafCap = options.leafCap ?? PROMOTED_LEAF_CAP;
  const bytesCap = options.bytesCap ?? PROMOTED_BYTES_CAP;
  if (requestHasToolSearchDefinition(payload.tools)) {
    promoteSearchOutputLeaves(payload, bridge, leafCap, bytesCap);
    flattenNamespacedHistoryCalls(payload, bridge);
  }
  if (Array.isArray(payload.tools)) payload.tools = payload.tools.map(rewriteToolDefinition);
  if (Array.isArray(payload.input)) payload.input = payload.input.map(rewriteHistoryItemToOllama);
  if (Array.isArray(payload.output)) payload.output = payload.output.map(rewriteHistoryItemToOllama);
  return bridge;
}

/** Ollama function_call named tool_search → Codex tool_search_call (execution=client). */
export function rewriteToolSearchFromOllama(value: unknown, bridge?: ToolSearchBridge): unknown {
  return rewriteFromOllama(value, bridge ?? emptyToolSearchBridge());
}

function rewriteFromOllama(value: unknown, bridge: ToolSearchBridge): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteFromOllama(item, bridge));
  if (!isRecord(value)) return value;
  if (isFunctionCallItem(value)) return rewriteFunctionCallFromOllama(value, bridge);
  const next: JsonObject = {};
  for (const [key, nested] of Object.entries(value)) {
    next[key] = rewriteFromOllama(nested, bridge);
  }
  return next;
}

function rewriteFunctionCallFromOllama(item: JsonObject, bridge: ToolSearchBridge): JsonObject {
  const identity = functionCallIdentity(item);
  if (!identity) return item;
  if (identity.namespace) return item;
  const restored = bridge.aliases.get(identity.name);
  if (restored) return applyIdentityToFunctionCall(item, restored);
  if (identity.name === TOOL_SEARCH_NAME) return functionCallToToolSearchCall(item);
  return item;
}

function rewriteToolDefinition(tool: unknown): unknown {
  if (!isRecord(tool)) return tool;
  if (tool.type === "namespace" && Array.isArray(tool.tools)) {
    return { ...tool, tools: tool.tools.map(rewriteToolDefinition) };
  }
  if (tool.type === "tool_search") return nativeToolSearchToFunction(tool);
  return tool;
}

function nativeToolSearchToFunction(tool: JsonObject): JsonObject {
  const description = typeof tool.description === "string" && tool.description.length > 0
    ? tool.description
    : DEFAULT_DESCRIPTION;
  const parameters = isRecord(tool.parameters) ? tool.parameters : structuredClone(DEFAULT_PARAMETERS);
  return {
    type: "function",
    name: TOOL_SEARCH_NAME,
    description,
    parameters,
  };
}

function rewriteHistoryItemToOllama(item: unknown): unknown {
  if (!isRecord(item)) return item;
  if (item.type === "tool_search_call") return toolSearchCallToFunctionCall(item);
  if (item.type === "tool_search_output") return toolSearchOutputToFunctionOutput(item);
  return item;
}

function toolSearchCallToFunctionCall(item: JsonObject): JsonObject {
  const callId = stringOrFallback(item.call_id, TOOL_SEARCH_NAME);
  const rewritten: JsonObject = {
    type: "function_call",
    name: TOOL_SEARCH_NAME,
    call_id: callId,
    arguments: stringifyArguments(item.arguments),
  };
  if (typeof item.id === "string" && item.id.length > 0) rewritten.id = item.id;
  return rewritten;
}

function toolSearchOutputToFunctionOutput(item: JsonObject): JsonObject {
  const callId = stringOrFallback(item.call_id, TOOL_SEARCH_NAME);
  const tools = Array.isArray(item.tools) ? item.tools : [];
  const rewritten: JsonObject = {
    type: "function_call_output",
    call_id: callId,
    output: JSON.stringify({ tools }),
  };
  if (typeof item.id === "string" && item.id.length > 0) rewritten.id = item.id;
  return rewritten;
}

function isToolSearchFunctionCall(item: JsonObject): boolean {
  const identity = functionCallIdentity(item);
  return identity?.name === TOOL_SEARCH_NAME && identity.namespace === undefined;
}

function functionCallToToolSearchCall(item: JsonObject): JsonObject {
  const rawArgs = item.arguments ?? (isRecord(item.function) ? item.function.arguments : undefined);
  const rewritten: JsonObject = {
    type: "tool_search_call",
    execution: "client",
    arguments: parseArguments(rawArgs),
  };
  const callId = typeof item.call_id === "string" && item.call_id.length > 0 ? item.call_id : undefined;
  if (callId) rewritten.call_id = callId;
  if (typeof item.id === "string" && item.id.length > 0) rewritten.id = item.id;
  if (typeof item.status === "string" && item.status.length > 0) rewritten.status = item.status;
  return rewritten;
}

function requestHasToolSearchDefinition(tools: unknown): boolean {
  if (!Array.isArray(tools)) return false;
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    if (tool.type === "namespace") continue;
    if (tool.type === "tool_search") return true;
    if (functionName(tool) === TOOL_SEARCH_NAME && optionalNamespace(tool.namespace) === undefined) {
      return true;
    }
  }
  return false;
}

function promoteSearchOutputLeaves(
  payload: JsonObject,
  bridge: ToolSearchBridge,
  leafCap: number,
  bytesCap: number,
): void {
  if (!Array.isArray(payload.tools) || !Array.isArray(payload.input)) return;
  const searchCallIds = collectSearchCallIds(payload.input);
  if (searchCallIds.size === 0) return;
  const occupied = existingFunctionNames(payload.tools);
  const seenLeaves = new Set<string>();
  const promoted: JsonObject[] = [];
  for (const output of collectSearchOutputsNewestFirst(payload.input, searchCallIds)) {
    const leaves = collectFunctionLeaves(output.tools);
    if (leaves.length === 0) {
      bridge.skippedInvalid += 1;
      continue;
    }
    for (const leaf of leaves) {
      const identity = leafIdentity(leaf);
      if (!identity) {
        bridge.skippedInvalid += 1;
        continue;
      }
      const leafKey = identityKey(identity);
      if (seenLeaves.has(leafKey)) continue;
      seenLeaves.add(leafKey);
      if (!isDirectFunctionLeaf(leaf)) {
        bridge.skippedUnsupported += 1;
        continue;
      }
      const alias = canonicalAlias(identity.namespace, identity.name);
      if (occupied.has(alias)) {
        const existing = bridge.aliases.get(alias);
        if (existing && identityKey(existing) !== leafKey) bridge.collisions += 1;
        else if (!existing) bridge.collisions += 1;
        continue;
      }
      const def = normalizePromotedFunction(leaf, identity, alias);
      if (!def) {
        bridge.skippedInvalid += 1;
        continue;
      }
      const bytes = jsonUtf8Bytes(def);
      if (promoted.length >= leafCap || bridge.promotedBytes + bytes > bytesCap) {
        bridge.skippedCap += 1;
        continue;
      }
      occupied.add(alias);
      bridge.aliases.set(alias, identity);
      promoted.push(def);
      bridge.promotedBytes += bytes;
    }
  }
  bridge.promotedN = promoted.length;
  if (promoted.length > 0) payload.tools = [...payload.tools, ...promoted];
}

function flattenNamespacedHistoryCalls(payload: JsonObject, bridge: ToolSearchBridge): void {
  if (Array.isArray(payload.input)) {
    payload.input = payload.input.map((item) => flattenHistoryFunctionCall(item, bridge));
  }
  if (Array.isArray(payload.output)) {
    payload.output = payload.output.map((item) => flattenHistoryFunctionCall(item, bridge));
  }
}

function flattenHistoryFunctionCall(item: unknown, bridge: ToolSearchBridge): unknown {
  if (!isRecord(item) || !isFunctionCallItem(item)) return item;
  const identity = functionCallIdentity(item);
  if (!identity?.namespace) return item;
  const alias = canonicalAlias(identity.namespace, identity.name);
  const existing = bridge.aliases.get(alias);
  if (existing && identityKey(existing) !== identityKey(identity)) {
    bridge.collisions += 1;
    return item;
  }
  if (!existing) bridge.aliases.set(alias, identity);
  return applyAliasToFunctionCall(item, alias);
}

function collectSearchCallIds(input: unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const item of input) {
    if (!isRecord(item)) continue;
    if (item.type === "tool_search_call") {
      ids.add(stringOrFallback(item.call_id, TOOL_SEARCH_NAME));
      continue;
    }
    if (isFunctionCallItem(item) && isToolSearchFunctionCall(item)) {
      ids.add(stringOrFallback(item.call_id, TOOL_SEARCH_NAME));
    }
  }
  return ids;
}

function collectSearchOutputsNewestFirst(input: unknown[], searchCallIds: Set<string>): JsonObject[] {
  const outputs: { index: number; tools: unknown[] }[] = [];
  for (const [index, item] of input.entries()) {
    const tools = searchOutputTools(item, searchCallIds);
    if (tools) outputs.push({ index, tools });
  }
  outputs.sort((a, b) => b.index - a.index);
  return outputs.map((entry) => ({ tools: entry.tools }));
}

function searchOutputTools(item: unknown, searchCallIds: Set<string>): unknown[] | undefined {
  if (!isRecord(item)) return undefined;
  if (isIncompleteStatus(item.status)) return undefined;
  if (typeof item.execution === "string" && item.execution !== "client") return undefined;
  const callId = stringOrFallback(item.call_id, TOOL_SEARCH_NAME);
  if (!searchCallIds.has(callId)) return undefined;
  if (item.type === "tool_search_output") {
    return Array.isArray(item.tools) ? item.tools : [];
  }
  if (item.type === "function_call_output") {
    return parseToolsPayload(item.output) ?? [];
  }
  return undefined;
}

function parseToolsPayload(output: unknown): unknown[] | undefined {
  if (isRecord(output) && Array.isArray(output.tools)) return output.tools;
  if (typeof output !== "string" || output.trim().length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(output);
    if (isRecord(parsed) && Array.isArray(parsed.tools)) return parsed.tools;
  } catch {
    return undefined;
  }
  return undefined;
}

function collectFunctionLeaves(tools: unknown, parentNamespace?: string): JsonObject[] {
  if (!Array.isArray(tools)) return [];
  const leaves: JsonObject[] = [];
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    if (tool.type === "namespace" && Array.isArray(tool.tools)) {
      const namespace = typeof tool.name === "string" && tool.name.trim().length > 0
        ? tool.name.trim()
        : undefined;
      if (!namespace) continue;
      leaves.push(...collectFunctionLeaves(tool.tools, namespace));
      continue;
    }
    if (parentNamespace && typeof tool.namespace !== "string") {
      leaves.push({ ...tool, namespace: parentNamespace });
    } else {
      leaves.push(tool);
    }
  }
  return leaves;
}

function isDirectFunctionLeaf(tool: JsonObject): boolean {
  const typed = tool.type === "function" || (isRecord(tool.function) && tool.type === undefined);
  if (!typed) return false;
  const callers = Array.isArray(tool.allowed_callers)
    ? tool.allowed_callers
    : isRecord(tool.function) && Array.isArray(tool.function.allowed_callers)
      ? tool.function.allowed_callers
      : undefined;
  if (callers && callers.length > 0 && !callers.includes("direct")) return false;
  return functionName(tool) !== undefined;
}

function flattenToolDefs(tools: unknown[]): JsonObject[] {
  const flat: JsonObject[] = [];
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    if (tool.type === "namespace" && Array.isArray(tool.tools)) {
      flat.push(...flattenToolDefs(tool.tools));
      continue;
    }
    flat.push(tool);
  }
  return flat;
}

function existingFunctionNames(tools: unknown[]): Set<string> {
  const names = new Set<string>();
  for (const tool of flattenToolDefs(tools)) {
    const name = functionName(tool);
    if (name) names.add(name);
  }
  return names;
}

function normalizePromotedFunction(
  tool: JsonObject,
  identity: DeferredToolIdentity,
  alias: string,
): JsonObject | undefined {
  const parameters = functionParameters(tool);
  if (parameters === undefined) return undefined;
  const original = functionDescription(tool);
  const qualified = identity.namespace ? `${identity.namespace}.${identity.name}` : identity.name;
  const description = alias === identity.name
    ? original
    : original.length > 0
      ? `${qualified}: ${original}`
      : qualified;
  return {
    type: "function",
    name: alias,
    description,
    parameters: structuredClone(parameters),
  };
}

function leafIdentity(tool: JsonObject): DeferredToolIdentity | undefined {
  const name = functionName(tool);
  if (!name) return undefined;
  const namespace = optionalNamespace(tool.namespace) ?? optionalNamespace(
    isRecord(tool.function) ? tool.function.namespace : undefined,
  );
  return namespace ? { name, namespace } : { name };
}

function functionCallIdentity(item: JsonObject): DeferredToolIdentity | undefined {
  const nested = isRecord(item.function) ? item.function : undefined;
  const name = typeof item.name === "string" && item.name.trim().length > 0
    ? item.name.trim()
    : nested && typeof nested.name === "string" && nested.name.trim().length > 0
      ? nested.name.trim()
      : undefined;
  if (!name) return undefined;
  const namespace = optionalNamespace(item.namespace) ?? optionalNamespace(nested?.namespace);
  return namespace ? { name, namespace } : { name };
}

function applyAliasToFunctionCall(item: JsonObject, alias: string): JsonObject {
  const next: JsonObject = { ...item, name: alias };
  delete next.namespace;
  if (isRecord(item.function)) {
    const fn: JsonObject = { ...item.function, name: alias };
    delete fn.namespace;
    next.function = fn;
  }
  return next;
}

function applyIdentityToFunctionCall(item: JsonObject, identity: DeferredToolIdentity): JsonObject {
  const next: JsonObject = { ...item, name: identity.name };
  if (identity.namespace) next.namespace = identity.namespace;
  else delete next.namespace;
  if (isRecord(item.function)) {
    const fn: JsonObject = { ...item.function, name: identity.name };
    if (identity.namespace) fn.namespace = identity.namespace;
    else delete fn.namespace;
    next.function = fn;
  }
  return next;
}

function isFunctionCallItem(item: JsonObject): boolean {
  return item.type === "function_call";
}

function functionName(tool: JsonObject): string | undefined {
  if (typeof tool.name === "string" && tool.name.trim().length > 0) return tool.name.trim();
  if (isRecord(tool.function) && typeof tool.function.name === "string" && tool.function.name.trim().length > 0) {
    return tool.function.name.trim();
  }
  return undefined;
}

function functionDescription(tool: JsonObject): string {
  if (typeof tool.description === "string") return tool.description;
  if (isRecord(tool.function) && typeof tool.function.description === "string") return tool.function.description;
  return "";
}

function functionParameters(tool: JsonObject): JsonObject | undefined {
  if (isRecord(tool.parameters)) return tool.parameters;
  if (isRecord(tool.function) && isRecord(tool.function.parameters)) return tool.function.parameters;
  return undefined;
}

function canonicalAlias(namespace: string | undefined, name: string): string {
  const raw = namespace ? `${namespace}__${name}` : name;
  const cleaned = raw.replace(ALIAS_RE, "_");
  if (cleaned === raw && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(cleaned)) return cleaned;
  const hash = createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 8);
  const prefix = (cleaned.replace(/^[^A-Za-z0-9]+/, "").slice(0, 55) || "tool").replace(/_+$/g, "");
  return `${prefix}_${hash}`.slice(0, MAX_ALIAS_LEN);
}

function identityKey(identity: DeferredToolIdentity): string {
  return `${identity.namespace ?? ""}\0${identity.name}`;
}

function optionalNamespace(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isIncompleteStatus(status: unknown): boolean {
  return typeof status === "string" && INCOMPLETE_STATUS.has(status);
}

function stringifyArguments(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "{}";
  return JSON.stringify(value);
}

function parseArguments(value: unknown): JsonObject {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : { query: String(parsed) };
  } catch {
    return { query: value };
  }
}

function stringOrFallback(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
