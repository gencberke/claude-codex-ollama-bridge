import type { JsonObject } from "./types.js";
import { isRecord } from "./types.js";

/** Codex's native freeform tool identity. */
export const APPLY_PATCH_TOOL_NAME = "apply_patch" as const;
/**
 * A deliberately non-native, cob-owned function name.  It is never accepted
 * from a caller as an existing tool: a collision is a request error.
 */
export const COB_APPLY_PATCH_ALIAS = "cob_apply_patch_v1" as const;
/** Compatibility spelling for callers that use the shorter constant name. */
export const APPLY_PATCH_ALIAS = COB_APPLY_PATCH_ALIAS;
export const APPLY_PATCH_INPUT_KEY = "input" as const;

export type ApplyPatchPolicy = {
  enabled: boolean;
};

export type ApplyPatchPolicyInput = boolean | ApplyPatchPolicy | undefined;

/**
 * Options for the request-side bridge.  Private checkpoints may retain the
 * validated provider alias history after public JSON has already been
 * normalized, so a continuation can contain cob's alias function_call items.
 * That history is trusted only when the gateway has already validated the
 * client request and resolved a previous_response_id; callers must not enable
 * this for an initial/client-supplied payload.
 */
export type ApplyPatchPrepareOptions = {
  readonly allowTrustedAliasHistory?: boolean;
};

export type ApplyPatchReject = {
  status: 400;
  body: {
    error: {
      type: "invalid_request_error";
      code: string;
      message: string;
    };
  };
};

export type ApplyPatchBridge = {
  readonly enabled: boolean;
  readonly alias: typeof COB_APPLY_PATCH_ALIAS;
  readonly declared: boolean;
  /** Active Ollama argument streams, used only while rewriting one SSE turn. */
  readonly activeCalls: Map<string, ApplyPatchActiveCall>;
};

export type ApplyPatchActiveCall = {
  readonly itemId?: string;
  readonly callId: string;
  readonly deltas: string[];
};

export type ApplyPatchGuardIssue = {
  readonly code: "ollama_undeclared_tool_call" | "ollama_tool_call_invalid";
  readonly kind: "undeclared" | "invalid_name" | "invalid_type" | "empty_name";
  readonly name?: unknown;
};

/** Returned by an SSE rewrite callback when an alias argument delta is consumed. */
export const APPLY_PATCH_OMIT = Symbol("apply-patch-omit");

const TOOL_KEYS = new Set(["type", "name", "description", "format"]);
const FORMAT_KEYS = new Set(["type", "syntax", "definition"]);
const INTERNAL_METADATA_KEY = "internal_chat_message_metadata_passthrough";
const CALL_KEYS = new Set(["type", "id", "call_id", "name", "input", "status", INTERNAL_METADATA_KEY]);
const OUTPUT_KEYS = new Set(["type", "id", "call_id", "output", "status", INTERNAL_METADATA_KEY]);
const FUNCTION_CALL_KEYS = new Set(["type", "id", "call_id", "name", "arguments", "status"]);
const FUNCTION_CALL_ARGUMENTS_DELTA_KEYS = new Set([
  "type",
  "item_id",
  "call_id",
  "output_index",
  "sequence_number",
  "delta",
]);
const FUNCTION_CALL_ARGUMENTS_DONE_KEYS = new Set([
  "type",
  "item_id",
  "call_id",
  "output_index",
  "sequence_number",
  "arguments",
]);
const ALLOWED_STATUSES = new Set([
  "in_progress",
  "completed",
  "incomplete",
  "failed",
  "cancelled",
  "expired",
]);

/**
 * Validate the custom/freeform surface without mutating the request.  The
 * gateway uses this before assembling a continuation; the actual conversion
 * happens at the final Ollama wire boundary.
 */
export function validateApplyPatchPayload(
  payload: JsonObject,
  policy?: ApplyPatchPolicyInput,
  options: ApplyPatchPrepareOptions = {},
): ApplyPatchReject | undefined {
  const enabled = policyEnabled(policy);
  const definitions = collectCustomDefinitions(payload.tools);
  const patchDefinitions = definitions.filter((entry) => entry.tool.name === APPLY_PATCH_TOOL_NAME);
  if (
    definitions.some((entry) => entry.nested) ||
    hasNestedCustomDefinition(payload.input) ||
    hasNestedCustomDefinition(payload.output)
  ) {
    return reject("apply_patch_tool_invalid", "The Ollama apply_patch bridge accepts only a top-level custom tool.");
  }
  if (definitions.length > 0 && !enabled) {
    return reject("ollama_custom_tool_unsupported", "Ollama does not accept Codex custom tools.");
  }
  if (definitions.length > 0) {
    for (const entry of definitions) {
      const definition = entry.tool;
      if (definition.name !== APPLY_PATCH_TOOL_NAME || !isExactApplyPatchTool(definition)) {
        return reject("apply_patch_tool_invalid", "The Ollama apply_patch bridge received an unsupported custom tool.");
      }
    }
    if (patchDefinitions.length !== 1) {
      return reject("apply_patch_tool_invalid", "The Ollama apply_patch bridge requires exactly one custom tool definition.");
    }
  }
  const aliases = collectWireFunctionNames(payload.tools);
  if (enabled && aliases.has(COB_APPLY_PATCH_ALIAS)) {
    return reject("apply_patch_alias_collision", "The Ollama apply_patch bridge alias collides with another tool.");
  }
  const history = collectApplyPatchHistory(payload);
  if (history.customCount > 0 && !enabled) {
    return reject("ollama_custom_tool_unsupported", "Ollama does not accept Codex custom tool history.");
  }
  if (history.customCount > 0 && patchDefinitions.length !== 1) {
    return reject("apply_patch_tool_undeclared", "The Codex apply_patch history is not declared on this turn.");
  }
  if (enabled && history.aliasCount > 0 && patchDefinitions.length !== 1) {
    return reject("apply_patch_tool_undeclared", "The Codex apply_patch history is not declared on this turn.");
  }
  const trustedAliasHistory = enabled && options.allowTrustedAliasHistory === true;
  if (enabled && history.aliasCount > 0 && !trustedAliasHistory) {
    return reject("apply_patch_alias_collision", "The Ollama apply_patch bridge alias is reserved by cob.");
  }
  for (const item of history.items) {
    const result = item.type === "function_call" && item.name === COB_APPLY_PATCH_ALIAS && trustedAliasHistory
      ? validateTrustedAliasHistoryItem(item)
      : validateCustomHistoryItem(item);
    if (result) return result;
  }
  return undefined;
}

/**
 * Convert one validated Codex request to the Ollama function dialect.  The
 * caller must run this after cloning the request; this function mutates that
 * clone so the original Codex payload remains available for checkpointing.
 */
export function prepareApplyPatchToOllama(
  payload: JsonObject,
  policy?: ApplyPatchPolicyInput,
  options: ApplyPatchPrepareOptions = {},
): { payload: JsonObject; bridge: ApplyPatchBridge } | ApplyPatchReject {
  const validation = validateApplyPatchPayload(payload, policy, options);
  if (validation) return validation;
  const enabled = policyEnabled(policy);
  if (!enabled) {
    return { payload, bridge: emptyApplyPatchBridge(false, false) };
  }
  const definitions = collectCustomDefinitions(payload.tools);
  const patchDefinitions = definitions.filter((entry) => entry.tool.name === APPLY_PATCH_TOOL_NAME);
  if (patchDefinitions.length === 0) {
    return { payload, bridge: emptyApplyPatchBridge(true, false) };
  }
  const convertedTools = rewriteToolDefinitions(payload.tools);
  if (convertedTools !== undefined) payload.tools = convertedTools;
  if (Array.isArray(payload.input)) payload.input = payload.input.map((item) => rewriteHistoryItem(item));
  if (Array.isArray(payload.output)) payload.output = payload.output.map((item) => rewriteHistoryItem(item));
  return {
    payload,
    bridge: emptyApplyPatchBridge(true, true),
  };
}

/** Short alias used by wire-boundary callers. */
export const rewriteApplyPatchToOllama = prepareApplyPatchToOllama;

export function emptyApplyPatchBridge(enabled = false, declared = false): ApplyPatchBridge {
  return {
    enabled,
    alias: COB_APPLY_PATCH_ALIAS,
    declared,
    activeCalls: new Map(),
  };
}

/**
 * Inspect provider output before it is checkpointed or returned to Codex.
 * `allowIncomplete` is used only for `response.output_item.added`, where an
 * Ollama function call may carry an empty arguments string until `done`.
 */
export function inspectApplyPatchJson(
  value: unknown,
  bridge: ApplyPatchBridge,
  allowIncomplete = false,
): ApplyPatchGuardIssue | undefined {
  if (!bridge.enabled || !bridge.declared) return inspectForbiddenCustom(value);
  return inspectApplyPatchValue(value, bridge, allowIncomplete);
}

/** Inspect an Ollama SSE event, including alias argument deltas. */
export function inspectApplyPatchSseEvent(
  value: unknown,
  bridge: ApplyPatchBridge,
): ApplyPatchGuardIssue | undefined {
  if (!bridge.enabled || !bridge.declared) return inspectForbiddenCustom(value);
  if (!isRecord(value)) return undefined;
  const type = typeof value.type === "string" ? value.type : undefined;
  if (type === "response.output_item.added") {
    return inspectCallItem(value.item, bridge, true);
  }
  if (type === "response.output_item.done") {
    return inspectCallItem(value.item, bridge, false);
  }
  if (type === "response.completed" || type === "response.incomplete") {
    return inspectApplyPatchValue(value.response, bridge, false);
  }
  if (type === "response.function_call_arguments.delta") {
    return inspectAliasDelta(value, bridge);
  }
  if (type === "response.function_call_arguments.done") {
    return inspectAliasArgumentsDone(value, bridge);
  }
  if (type === "response.custom_tool_call_input.delta" || type === "response.custom_tool_call_input.done") {
    return { code: "ollama_tool_call_invalid", kind: "invalid_type" };
  }
  return inspectForbiddenCustom(value);
}

/**
 * Rewrite Ollama function-call snapshots/deltas to Codex's custom-tool
 * dialect. Alias argument deltas are consumed, never relayed as JSON-wrapper
 * deltas; the final output_item.done carries the complete native input.
 */
export function rewriteApplyPatchFromOllama(
  value: unknown,
  bridge: ApplyPatchBridge,
): unknown {
  if (!bridge.enabled || !bridge.declared) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const rewritten = rewriteApplyPatchFromOllama(item, bridge);
      if (rewritten !== item) changed = true;
      return rewritten;
    });
    return changed ? next : value;
  }
  if (!isRecord(value)) return value;
  const type = typeof value.type === "string" ? value.type : undefined;
  if (type === "response.function_call_arguments.delta") {
    const active = activeCallForEvent(value, bridge);
    if (!active) return value;
    active.deltas.push(value.delta as string);
    return APPLY_PATCH_OMIT;
  }
  if (type === "response.function_call_arguments.done") {
    // Ollama may emit this bookkeeping event before output_item.done. It is
    // safe to consume only when its item/call id correlates to the active
    // patch alias; an ordinary function's done event must pass unchanged.
    return activeCallForEvent(value, bridge) ? APPLY_PATCH_OMIT : value;
  }
  if (type === "response.output_item.added" || type === "response.output_item.done") {
    const item = value.item;
    if (isRecord(item) && isAliasFunctionCall(item, bridge)) {
      const allowIncomplete = type === "response.output_item.added";
      const mapped = rewriteFunctionCall(item, bridge, allowIncomplete);
      if (type === "response.output_item.done") forgetActiveCall(item, bridge);
      return mapped === APPLY_PATCH_OMIT ? APPLY_PATCH_OMIT : { ...value, item: mapped };
    }
  }
  if (type === "response.completed" || type === "response.incomplete") {
    if (isRecord(value.response)) {
      return { ...value, response: rewriteApplyPatchFromOllama(value.response, bridge) };
    }
  }
  if (isAliasFunctionCall(value, bridge)) {
    return rewriteFunctionCall(value, bridge, false);
  }
  let changed = false;
  const next: JsonObject = {};
  for (const [key, nested] of Object.entries(value)) {
    const rewritten = rewriteApplyPatchFromOllama(nested, bridge);
    if (rewritten !== nested) changed = true;
    next[key] = rewritten;
  }
  return changed ? next : value;
}

/** Short alias used by response normalization callers. */
export const rewriteApplyPatchFromOllamaResponse = rewriteApplyPatchFromOllama;

function policyEnabled(policy: ApplyPatchPolicyInput): boolean {
  return typeof policy === "boolean" ? policy : policy?.enabled === true;
}

function reject(code: string, message: string): ApplyPatchReject {
  return { status: 400, body: { error: { type: "invalid_request_error", code, message } } };
}

function collectCustomDefinitions(tools: unknown): Array<{ tool: JsonObject; nested: boolean }> {
  if (!Array.isArray(tools)) return [];
  const found: Array<{ tool: JsonObject; nested: boolean }> = [];
  const visit = (value: unknown, nested: boolean): void => {
    if (!isRecord(value)) return;
    if (value.type === "custom") found.push({ tool: value, nested });
    if (Array.isArray(value.tools)) {
      for (const tool of value.tools) visit(tool, true);
    }
  };
  for (const tool of tools) visit(tool, false);
  return found;
}

function hasNestedCustomDefinition(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasNestedCustomDefinition);
  if (!isRecord(value)) return false;
  if (value.type === "custom") return true;
  return Object.values(value).some(hasNestedCustomDefinition);
}

function rewriteToolDefinitions(tools: unknown): unknown[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((tool) => {
    if (!isRecord(tool)) return tool;
    if (tool.type === "namespace" && Array.isArray(tool.tools)) {
      return { ...tool, tools: rewriteToolDefinitions(tool.tools) ?? tool.tools };
    }
    if (tool.type !== "custom" || tool.name !== APPLY_PATCH_TOOL_NAME) return tool;
    const converted: JsonObject = {
      type: "function",
      name: COB_APPLY_PATCH_ALIAS,
      parameters: {
        type: "object",
        properties: { [APPLY_PATCH_INPUT_KEY]: { type: "string" } },
        required: [APPLY_PATCH_INPUT_KEY],
        additionalProperties: false,
      },
    };
    if (typeof tool.description === "string") converted.description = tool.description;
    return converted;
  });
}

function rewriteHistoryItem(item: unknown): unknown {
  if (!isRecord(item)) return item;
  if (item.type === "custom_tool_call") {
    const call = item;
    const next: JsonObject = {
      type: "function_call",
      call_id: call.call_id,
      name: COB_APPLY_PATCH_ALIAS,
      arguments: JSON.stringify({ [APPLY_PATCH_INPUT_KEY]: call.input }),
    };
    if (typeof call.id === "string") next.id = call.id;
    if (typeof call.status === "string") next.status = call.status;
    return next;
  }
  if (item.type === "custom_tool_call_output") {
    const next: JsonObject = {
      type: "function_call_output",
      call_id: item.call_id,
      output: item.output,
    };
    if (typeof item.id === "string") next.id = item.id;
    if (typeof item.status === "string") next.status = item.status;
    return next;
  }
  return item;
}

function collectApplyPatchHistory(payload: JsonObject): {
  items: JsonObject[];
  customCount: number;
  aliasCount: number;
} {
  const items: JsonObject[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    if (value.type === "custom_tool_call" || value.type === "custom_tool_call_output") items.push(value);
    if (value.type === "function_call" && (value.name === COB_APPLY_PATCH_ALIAS || value.name === APPLY_PATCH_TOOL_NAME)) {
      items.push(value);
    }
  };
  visit(payload.input);
  visit(payload.output);
  return {
    items,
    customCount: items.filter((item) => item.type === "custom_tool_call" || item.type === "custom_tool_call_output").length,
    aliasCount: items.filter((item) => item.type === "function_call" && item.name === COB_APPLY_PATCH_ALIAS).length,
  };
}

function validateCustomHistoryItem(item: JsonObject): ApplyPatchReject | undefined {
  if (item.type === "custom_tool_call") {
    if (item.name !== APPLY_PATCH_TOOL_NAME) {
      return reject("apply_patch_tool_invalid", "The Ollama apply_patch bridge received an unsupported custom call.");
    }
    if (!hasOnlyKeys(item, CALL_KEYS) || typeof item.call_id !== "string" || item.call_id.length === 0 || typeof item.input !== "string") {
      return reject("apply_patch_input_invalid", "The Codex apply_patch call must contain a string input and call id.");
    }
    return validateOptionalItemFields(item);
  }
  if (item.type === "custom_tool_call_output") {
    if (!hasOnlyKeys(item, OUTPUT_KEYS) || typeof item.call_id !== "string" || item.call_id.length === 0 || typeof item.output !== "string") {
      return reject("apply_patch_output_invalid", "The Codex apply_patch output must contain a string output and call id.");
    }
    return validateOptionalItemFields(item);
  }
  if (item.type === "function_call" && item.name === COB_APPLY_PATCH_ALIAS) {
    return reject("apply_patch_alias_collision", "The Ollama apply_patch bridge alias is reserved by cob.");
  }
  if (item.type === "function_call" && item.name === APPLY_PATCH_TOOL_NAME) {
    return reject("apply_patch_tool_invalid", "Ollama accepts only the declared Codex custom apply_patch tool.");
  }
  return undefined;
}

function validateTrustedAliasHistoryItem(item: JsonObject): ApplyPatchReject | undefined {
  if (
    !hasOnlyKeys(item, FUNCTION_CALL_KEYS) ||
    item.type !== "function_call" ||
    item.name !== COB_APPLY_PATCH_ALIAS ||
    typeof item.call_id !== "string" ||
    item.call_id.length === 0 ||
    typeof item.arguments !== "string" ||
    !isPatchArguments(item.arguments)
  ) {
    return reject("apply_patch_alias_history_invalid", "The stored apply_patch provider call is not a valid function call.");
  }
  if (item.id !== undefined && (typeof item.id !== "string" || item.id.length === 0)) {
    return reject("apply_patch_alias_history_invalid", "The stored apply_patch provider call id is invalid.");
  }
  if (item.status !== undefined && (typeof item.status !== "string" || !ALLOWED_STATUSES.has(item.status))) {
    return reject("apply_patch_alias_history_invalid", "The stored apply_patch provider call status is invalid.");
  }
  if (containsEncryptedField(item)) {
    return reject("apply_patch_encrypted_unsupported", "Encrypted apply_patch fields cannot be sent to Ollama.");
  }
  return undefined;
}

function validateOptionalItemFields(item: JsonObject): ApplyPatchReject | undefined {
  if (typeof item.id === "string" && item.id.length === 0) {
    return reject("apply_patch_input_invalid", "The Codex apply_patch item id cannot be empty.");
  }
  if (item.id !== undefined && typeof item.id !== "string") {
    return reject("apply_patch_input_invalid", "The Codex apply_patch item id must be a string.");
  }
  if (item.status !== undefined && (typeof item.status !== "string" || !ALLOWED_STATUSES.has(item.status))) {
    return reject("apply_patch_input_invalid", "The Codex apply_patch item status is unsupported.");
  }
  const metadata = item[INTERNAL_METADATA_KEY];
  if (metadata !== undefined) {
    if (
      !isRecord(metadata) ||
      !Object.keys(metadata).every((key) => key === "turn_id" || key === "create_time") ||
      (metadata.turn_id !== undefined && (typeof metadata.turn_id !== "string" || metadata.turn_id.length === 0)) ||
      (metadata.create_time !== undefined && (typeof metadata.create_time !== "number" || !Number.isFinite(metadata.create_time)))
    ) {
      return reject("apply_patch_input_invalid", "The Codex apply_patch item metadata is unsupported.");
    }
  }
  if (containsEncryptedField(item)) {
    return reject("apply_patch_encrypted_unsupported", "Encrypted apply_patch fields cannot be sent to Ollama.");
  }
  return undefined;
}

function isExactApplyPatchTool(tool: JsonObject): boolean {
  if (tool.type !== "custom" || tool.name !== APPLY_PATCH_TOOL_NAME) return false;
  if (!hasOnlyKeys(tool, TOOL_KEYS)) return false;
  if (tool.description !== undefined && typeof tool.description !== "string") return false;
  if (!isRecord(tool.format) || !hasOnlyKeys(tool.format, FORMAT_KEYS)) return false;
  if (
    tool.format.type !== "grammar" ||
    tool.format.syntax !== "lark" ||
    typeof tool.format.definition !== "string" ||
    tool.format.definition.length === 0
  ) return false;
  return !containsEncryptedField(tool);
}

function inspectApplyPatchValue(value: unknown, bridge: ApplyPatchBridge, allowIncomplete: boolean): ApplyPatchGuardIssue | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const failure = inspectApplyPatchValue(item, bridge, allowIncomplete);
      if (failure) return failure;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (isAliasFunctionCall(value, bridge)) return inspectAliasCall(value, bridge, allowIncomplete);
  if (value.type === "custom_tool_call" || value.type === "custom_tool_call_output") {
    return { code: "ollama_tool_call_invalid", kind: "invalid_type", name: value.name };
  }
  if (isRecord(value.response)) {
    const failure = inspectApplyPatchValue(value.response, bridge, allowIncomplete);
    if (failure) return failure;
  }
  if (Array.isArray(value.output)) return inspectApplyPatchValue(value.output, bridge, allowIncomplete);
  return undefined;
}

function inspectForbiddenCustom(value: unknown): ApplyPatchGuardIssue | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const failure = inspectForbiddenCustom(item);
      if (failure) return failure;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (value.type === "custom_tool_call" || value.type === "custom_tool_call_output") {
    return { code: "ollama_tool_call_invalid", kind: "invalid_type", name: value.name };
  }
  if (isRecord(value.response)) {
    const failure = inspectForbiddenCustom(value.response);
    if (failure) return failure;
  }
  if (Array.isArray(value.output)) return inspectForbiddenCustom(value.output);
  return undefined;
}

function inspectCallItem(item: unknown, bridge: ApplyPatchBridge, allowIncomplete: boolean): ApplyPatchGuardIssue | undefined {
  if (!isRecord(item)) return undefined;
  if (isAliasFunctionCall(item, bridge)) return inspectAliasCall(item, bridge, allowIncomplete);
  if (item.type === "custom_tool_call" || item.type === "custom_tool_call_output") {
    return { code: "ollama_tool_call_invalid", kind: "invalid_type", name: item.name };
  }
  return undefined;
}

function inspectAliasCall(item: JsonObject, bridge: ApplyPatchBridge, allowIncomplete: boolean): ApplyPatchGuardIssue | undefined {
  if (!hasOnlyKeys(item, FUNCTION_CALL_KEYS) || item.type !== "function_call" || item.name !== bridge.alias) {
    return { code: "ollama_tool_call_invalid", kind: "invalid_type", name: item.name };
  }
  if (typeof item.call_id !== "string" || item.call_id.length === 0) {
    return { code: "ollama_tool_call_invalid", kind: "invalid_name", name: item.name };
  }
  if (item.id !== undefined && (typeof item.id !== "string" || item.id.length === 0)) {
    return { code: "ollama_tool_call_invalid", kind: "invalid_type", name: item.name };
  }
  if (item.status !== undefined && (typeof item.status !== "string" || !ALLOWED_STATUSES.has(item.status))) {
    return { code: "ollama_tool_call_invalid", kind: "invalid_type", name: item.name };
  }
  if (activeCallIdentityConflict(item, bridge)) {
    return { code: "ollama_tool_call_invalid", kind: "invalid_type", name: item.name };
  }
  rememberActiveCall(item, bridge);
  const active = bridge.activeCalls.get(item.call_id) ??
    (typeof item.id === "string" ? bridge.activeCalls.get(item.id) : undefined);
  if (allowIncomplete && (item.arguments === undefined || item.arguments === "")) return undefined;
  if (!allowIncomplete && (item.arguments === undefined || item.arguments === "") && active && active.deltas.length > 0) {
    if (!isPatchArguments(active.deltas.join(""))) {
      return { code: "ollama_tool_call_invalid", kind: "invalid_type", name: item.name };
    }
    return undefined;
  }
  if (typeof item.arguments !== "string" || !isPatchArguments(item.arguments)) {
    return { code: "ollama_tool_call_invalid", kind: "invalid_type", name: item.name };
  }
  if (active && active.deltas.length > 0 && active.deltas.join("") !== item.arguments) {
    return { code: "ollama_tool_call_invalid", kind: "invalid_type", name: item.name };
  }
  return undefined;
}

function inspectAliasDelta(value: JsonObject, bridge: ApplyPatchBridge): ApplyPatchGuardIssue | undefined {
  if (activeCallIdentityConflict(value, bridge)) {
    return { code: "ollama_tool_call_invalid", kind: "invalid_type" };
  }
  const active = activeCallForEvent(value, bridge);
  if (!active) return undefined;
  if (!hasOnlyKeys(value, FUNCTION_CALL_ARGUMENTS_DELTA_KEYS)) {
    return { code: "ollama_tool_call_invalid", kind: "invalid_type" };
  }
  if (typeof value.delta !== "string") return { code: "ollama_tool_call_invalid", kind: "invalid_type" };
  if (typeof value.item_id === "string" && active.itemId !== undefined && value.item_id !== active.itemId) {
    return { code: "ollama_tool_call_invalid", kind: "invalid_type" };
  }
  if (typeof value.call_id === "string" && value.call_id !== active.callId) {
    return { code: "ollama_tool_call_invalid", kind: "invalid_type" };
  }
  return undefined;
}

function inspectAliasArgumentsDone(value: JsonObject, bridge: ApplyPatchBridge): ApplyPatchGuardIssue | undefined {
  if (activeCallIdentityConflict(value, bridge)) {
    return { code: "ollama_tool_call_invalid", kind: "invalid_type" };
  }
  const active = activeCallForEvent(value, bridge);
  // A done event for an ordinary function has no patch identity. It is not
  // ours to consume or reject.
  if (!active) return undefined;
  if (!hasOnlyKeys(value, FUNCTION_CALL_ARGUMENTS_DONE_KEYS)) {
    return { code: "ollama_tool_call_invalid", kind: "invalid_type" };
  }
  if (typeof value.item_id === "string" && active.itemId !== undefined && value.item_id !== active.itemId) {
    return { code: "ollama_tool_call_invalid", kind: "invalid_type" };
  }
  if (typeof value.call_id === "string" && value.call_id !== active.callId) {
    return { code: "ollama_tool_call_invalid", kind: "invalid_type" };
  }
  if (value.arguments !== undefined) {
    if (typeof value.arguments !== "string" || !isPatchArguments(value.arguments)) {
      return { code: "ollama_tool_call_invalid", kind: "invalid_type" };
    }
    if (active.deltas.length > 0 && value.arguments !== active.deltas.join("")) {
      return { code: "ollama_tool_call_invalid", kind: "invalid_type" };
    }
  }
  return undefined;
}

function rewriteFunctionCall(item: JsonObject, bridge: ApplyPatchBridge, allowIncomplete: boolean): JsonObject | typeof APPLY_PATCH_OMIT {
  const active = ensureActiveCall(item, bridge);
  let rawArguments = typeof item.arguments === "string" ? item.arguments : "";
  if (rawArguments.length > 0 && active && active.deltas.length > 0 && rawArguments !== active.deltas.join("")) {
    throw new Error("Ollama apply_patch argument stream did not match its completed call");
  }
  if (rawArguments.length === 0 && active && active.deltas.length > 0) rawArguments = active.deltas.join("");
  const parsed = rawArguments.length === 0 && allowIncomplete ? "" : parsePatchInput(rawArguments);
  if (parsed === undefined) throw new Error("Ollama apply_patch arguments are not a valid string wrapper");
  const next: JsonObject = {
    type: "custom_tool_call",
    call_id: item.call_id,
    name: APPLY_PATCH_TOOL_NAME,
    input: parsed,
  };
  if (typeof item.status === "string") next.status = item.status;
  if (typeof item.id === "string") next.id = item.id;
  return next;
}

function parsePatchInput(argumentsValue: string): string | undefined {
  if (!isPatchArguments(argumentsValue)) return undefined;
  try {
    const parsed: unknown = JSON.parse(argumentsValue);
    return isRecord(parsed) && typeof parsed[APPLY_PATCH_INPUT_KEY] === "string"
      ? parsed[APPLY_PATCH_INPUT_KEY]
      : undefined;
  } catch {
    return undefined;
  }
}

function isPatchArguments(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) && Object.keys(parsed).length === 1 && typeof parsed[APPLY_PATCH_INPUT_KEY] === "string" && !containsEncryptedField(parsed);
  } catch {
    return false;
  }
}

function isAliasFunctionCall(value: JsonObject, bridge: ApplyPatchBridge): boolean {
  return value.type === "function_call" && value.name === bridge.alias;
}

function ensureActiveCall(item: JsonObject, bridge: ApplyPatchBridge): ApplyPatchActiveCall | undefined {
  if (typeof item.call_id !== "string" || item.call_id.length === 0) return undefined;
  if (activeCallIdentityConflict(item, bridge)) {
    throw new Error("Ollama apply_patch call identity conflicted");
  }
  return rememberActiveCall(item, bridge);
}

function rememberActiveCall(item: JsonObject, bridge: ApplyPatchBridge): ApplyPatchActiveCall | undefined {
  if (typeof item.call_id !== "string" || item.call_id.length === 0) return undefined;
  const itemId = typeof item.id === "string" && item.id.length > 0 ? item.id : undefined;
  const existing = bridge.activeCalls.get(item.call_id) ?? (itemId ? bridge.activeCalls.get(itemId) : undefined);
  if (existing) return existing;
  const active: ApplyPatchActiveCall = { itemId, callId: item.call_id, deltas: [] };
  bridge.activeCalls.set(item.call_id, active);
  if (itemId) bridge.activeCalls.set(itemId, active);
  return active;
}

function activeCallIdentityConflict(value: JsonObject, bridge: ApplyPatchBridge): boolean {
  const itemId = typeof value.item_id === "string"
    ? value.item_id
    : typeof value.id === "string"
      ? value.id
      : undefined;
  const callId = typeof value.call_id === "string" ? value.call_id : undefined;
  const byItem = itemId ? bridge.activeCalls.get(itemId) : undefined;
  const byCall = callId ? bridge.activeCalls.get(callId) : undefined;
  if (byItem && byCall && byItem !== byCall) return true;
  if (byItem && callId !== undefined && byItem.callId !== callId) return true;
  if (byCall && itemId !== undefined && byCall.itemId !== undefined && byCall.itemId !== itemId) return true;
  return false;
}

function activeCallForEvent(value: JsonObject, bridge: ApplyPatchBridge): ApplyPatchActiveCall | undefined {
  const itemId = typeof value.item_id === "string" ? value.item_id : undefined;
  const callId = typeof value.call_id === "string" ? value.call_id : undefined;
  const byItem = itemId ? bridge.activeCalls.get(itemId) : undefined;
  const byCall = callId ? bridge.activeCalls.get(callId) : undefined;
  if (byItem && byCall && byItem !== byCall) return undefined;
  return byItem ?? byCall;
}

function forgetActiveCall(item: JsonObject, bridge: ApplyPatchBridge): void {
  const active = activeCallForEvent(item, bridge);
  if (!active) return;
  bridge.activeCalls.delete(active.callId);
  if (active.itemId) bridge.activeCalls.delete(active.itemId);
}

function collectWireFunctionNames(tools: unknown): Set<string> {
  const names = new Set<string>();
  const visit = (value: unknown, namespace?: string): void => {
    if (!isRecord(value)) return;
    if (value.type === "namespace" && Array.isArray(value.tools)) {
      const own = typeof value.name === "string" && value.name.length > 0 ? value.name : namespace;
      for (const child of value.tools) visit(child, own);
      return;
    }
    if (value.type === "function") {
      const direct = typeof value.name === "string" ? value.name : isRecord(value.function) && typeof value.function.name === "string" ? value.function.name : undefined;
      const trimmed = direct?.trim();
      if (trimmed) names.add(namespace ? `${namespace}.${trimmed}` : trimmed);
    }
  };
  if (Array.isArray(tools)) for (const tool of tools) visit(tool);
  return names;
}

function hasOnlyKeys(value: JsonObject, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function containsEncryptedField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsEncryptedField);
  if (!isRecord(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "encrypted_content" || key === "encrypted_function_args" || key === "encrypted") return true;
    if (containsEncryptedField(nested)) return true;
  }
  return false;
}
