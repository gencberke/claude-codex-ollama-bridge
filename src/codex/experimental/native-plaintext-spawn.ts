import { createHash } from "node:crypto";
import type { Transform } from "node:stream";
import { sseRewriteTransform } from "../sse.js";
import type { NativePlaintextSpawnPolicy } from "../config/schema.js";
import { isEncryptedFieldName } from "../encrypted.js";
import type { JsonObject } from "../../core/json.js";
import { isRecord } from "../../core/json.js";

/**
 * The isolated Gate 1-3 aliases are intentionally non-reserved, top-level
 * function names. The upstream `collaboration` namespace is never made
 * plaintext in place.
 */
export const NATIVE_PLAINTEXT_SPAWN_ALIAS = "cob_plaintext_spawn_agent" as const;
export const NATIVE_PLAINTEXT_SEND_ALIAS = "cob_plaintext_send_message" as const;
export const NATIVE_PLAINTEXT_FOLLOWUP_ALIAS = "cob_plaintext_followup_task" as const;
export const NATIVE_PLAINTEXT_SPAWN_MODEL = "gpt-5.6-sol" as const;

export type NativePlaintextCanonicalName = "spawn_agent" | "send_message" | "followup_task";
export type NativePlaintextAlias =
  | typeof NATIVE_PLAINTEXT_SPAWN_ALIAS
  | typeof NATIVE_PLAINTEXT_SEND_ALIAS
  | typeof NATIVE_PLAINTEXT_FOLLOWUP_ALIAS;

type NativePlaintextAliasBinding = Readonly<{
  alias: NativePlaintextAlias;
  canonicalName: NativePlaintextCanonicalName;
}>;

const NATIVE_PLAINTEXT_ALIAS_BINDINGS = [
  { alias: NATIVE_PLAINTEXT_SPAWN_ALIAS, canonicalName: "spawn_agent" },
  { alias: NATIVE_PLAINTEXT_SEND_ALIAS, canonicalName: "send_message" },
  { alias: NATIVE_PLAINTEXT_FOLLOWUP_ALIAS, canonicalName: "followup_task" },
] as const satisfies readonly NativePlaintextAliasBinding[];

export type NativePlaintextSpawnContext = {
  /** Fixed alias→canonical bindings prevent one alias being cross-mapped. */
  bindings: readonly NativePlaintextAliasBinding[];
  schemaSha256: string;
};

export type NativePlaintextSpawnResult = {
  payload: JsonObject;
  context?: NativePlaintextSpawnContext;
};

export type NativePlaintextSpawnReject = {
  status: 409 | 502;
  body: {
    error: {
      type: "invalid_request_error" | "server_error";
      code: string;
      message: string;
      observed_schema_sha256?: string;
      diagnostics?: NativePlaintextSpawnResponseDiagnostic;
    };
  };
};

export type NativePlaintextSpawnJsonClassification = "invalid" | "array" | "object" | "scalar";

/**
 * Content-free facts captured at the Gate 1-3 response boundary. These fields
 * are deliberately structural: no response body, function arguments, ids,
 * or text are retained or emitted.
 */
export type NativePlaintextSpawnResponseDiagnostic = {
  upstream_status: number;
  upstream_content_type: string;
  raw_byte_length: number;
  json_classification: NativePlaintextSpawnJsonClassification;
  top_level_type?: string;
  top_level_keys?: string[];
  mapper_error_class?: string;
  mapper_error_code?: string;
};

export type NativePlaintextSpawnResponseObservation = {
  value?: unknown;
  diagnostic: NativePlaintextSpawnResponseDiagnostic;
};

export class NativePlaintextSpawnError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "NativePlaintextSpawnError";
  }
}

/**
 * Parse only far enough to classify the upstream response. The parsed value
 * is returned to the response mapper, while the diagnostic contains no body
 * data beyond top-level type/key names explicitly needed by the canary.
 */
export function observeNativePlaintextSpawnResponse(
  raw: Buffer,
  upstreamStatus: number,
  upstreamContentType: string,
): NativePlaintextSpawnResponseObservation {
  const diagnostic: NativePlaintextSpawnResponseDiagnostic = {
    upstream_status: upstreamStatus,
    upstream_content_type: upstreamContentType,
    raw_byte_length: raw.length,
    json_classification: "invalid",
  };
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    return { diagnostic };
  }
  if (Array.isArray(value)) {
    diagnostic.json_classification = "array";
  } else if (isRecord(value)) {
    diagnostic.json_classification = "object";
    if (typeof value.type === "string") diagnostic.top_level_type = value.type;
    diagnostic.top_level_keys = Object.keys(value).sort();
  } else {
    diagnostic.json_classification = "scalar";
  }
  return { value, diagnostic };
}

/**
 * Stable, namespace-schema-only fingerprint. Object key order is ignored;
 * array order and every scalar are significant. Gate 1-3 passes the complete
 * top-level `collaboration` namespace container here, never an individual
 * opted-in leaf.
 * The source schema is never logged or returned to a caller.
 */
export function nativePlaintextSpawnSchemaSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** Short alias used by the isolated harness. */
export const nativePlaintextSpawnSchemaFingerprint = nativePlaintextSpawnSchemaSha256;

const OBSERVED_COLLABORATION_TOOL_NAMES = [
  "followup_task",
  "interrupt_agent",
  "list_agents",
  "send_message",
  "spawn_agent",
  "wait_agent",
] as const;

type Gate1SchemaLocation = {
  additionalIndex: number;
  namespaceIndex: number;
  spawnIndex: number;
  sendIndex: number;
  followupIndex: number;
  additional: JsonObject;
  namespace: JsonObject;
  spawn: JsonObject;
  send: JsonObject;
  followup: JsonObject;
};

type Gate1SchemaLocationResult = Gate1SchemaLocation | { reject: NativePlaintextSpawnReject };

/**
 * Prepare one native Sol request for the opt-in Gate 1-3 experiment. All
 * non-Sol requests, and the default-disabled path, return the original object
 * so the gateway can retain byte-for-byte native passthrough.
 */
export function prepareNativePlaintextSpawn(
  payload: JsonObject,
  policy: NativePlaintextSpawnPolicy | undefined,
): NativePlaintextSpawnResult | NativePlaintextSpawnReject {
  if (payload.model !== NATIVE_PLAINTEXT_SPAWN_MODEL || policy?.enabled !== true) {
    return { payload };
  }

  const location = locateObservedGate1Schema(payload);
  if ("reject" in location) return location.reject;

  if (!policy.schemaSha256) {
    return reject(
      "native_plaintext_spawn_schema_fingerprint_required",
      "native plaintext spawn schema fingerprint is required",
      nativePlaintextSpawnSchemaSha256(location.namespace),
    );
  }

  const observed = nativePlaintextSpawnSchemaSha256(location.namespace);
  if (policy.schemaSha256.toLowerCase() !== observed) {
    return reject("native_plaintext_spawn_schema_mismatch", "native plaintext spawn schema fingerprint mismatch", observed);
  }

  const next = structuredClone(payload) as JsonObject;
  const nextInput = next.input as unknown[];
  const nextAdditional = nextInput[location.additionalIndex];
  if (!isRecord(nextAdditional) || !Array.isArray(nextAdditional.tools)) {
    return reject("native_plaintext_spawn_schema_shape", "native plaintext spawn schema shape is unsupported");
  }
  const nextTools = nextAdditional.tools;
  const nextNamespace = nextTools[location.namespaceIndex];
  if (!isRecord(nextNamespace) || !Array.isArray(nextNamespace.tools)) {
    return reject("native_plaintext_spawn_schema_shape", "native plaintext spawn schema shape is unsupported");
  }
  const spawnAliasSource = nextNamespace.tools[location.spawnIndex];
  const sendAliasSource = nextNamespace.tools[location.sendIndex];
  const followupAliasSource = nextNamespace.tools[location.followupIndex];
  if (!isRecord(spawnAliasSource) || !isRecord(sendAliasSource) || !isRecord(followupAliasSource)) {
    return reject("native_plaintext_spawn_schema_shape", "native plaintext spawn schema shape is unsupported");
  }
  // The real 0.149 request puts the namespace in one additional_tools
  // developer item. Remove only the three opted-in encrypted leaves from that
  // namespace; append their non-reserved aliases alongside the namespace in
  // the same item. Every other namespace/tool/sibling keeps its order.
  const removedIndexes = new Set([location.spawnIndex, location.sendIndex, location.followupIndex]);
  nextNamespace.tools = nextNamespace.tools.filter((_tool, index) => !removedIndexes.has(index));
  nextTools.push(
    plaintextAliasClone(spawnAliasSource, NATIVE_PLAINTEXT_SPAWN_ALIAS),
    plaintextAliasClone(sendAliasSource, NATIVE_PLAINTEXT_SEND_ALIAS),
    plaintextAliasClone(followupAliasSource, NATIVE_PLAINTEXT_FOLLOWUP_ALIAS),
  );
  return {
    payload: next,
    context: { bindings: NATIVE_PLAINTEXT_ALIAS_BINDINGS, schemaSha256: observed },
  };
}

/**
 * Map the permitted aliases back to Codex's reserved V2 identities. The
 * function is deliberately strict: an upstream canonical encrypted call is
 * never guessed at, aliases cannot cross-map, and malformed alias arguments
 * are not forwarded.
 */
export function mapNativePlaintextSpawnJson(value: unknown, context: NativePlaintextSpawnContext): unknown {
  return mapResponseValue(value, context);
}

/** Native JSON/SSE response transform used only after a request was rewritten. */
export function nativePlaintextSpawnSseTransform(context: NativePlaintextSpawnContext): Transform {
  return sseRewriteTransform((value) => {
    const allowIncompleteArguments =
      isRecord(value) && value.type === "response.output_item.added";
    return mapResponseValue(value, context, allowIncompleteArguments);
  }, undefined, { failOnError: true, failOnUnknownField: true });
}

export function nativePlaintextSpawnError(
  error: unknown,
  diagnostic?: NativePlaintextSpawnResponseDiagnostic,
): NativePlaintextSpawnReject {
  if (error instanceof NativePlaintextSpawnError) {
    return responseReject(error.code, error.message, withMapperDiagnostic(diagnostic, error));
  }
  return responseReject(
    "native_plaintext_spawn_response_invalid",
    "native plaintext spawn response was not an accepted shape",
    withMapperDiagnostic(diagnostic, error),
  );
}

/**
 * One-line, content-free log record for a rejected canary response. Values
 * that originate with the upstream are JSON quoted so a hostile header, type,
 * or key name cannot create a second log line.
 */
export function formatNativePlaintextSpawnResponseDiagnostic(
  diagnostic: NativePlaintextSpawnResponseDiagnostic,
): string {
  return [
    "[cob] native plaintext spawn response rejected",
    `upstream_status=${diagnostic.upstream_status}`,
    `upstream_content_type=${quoteDiagnostic(diagnostic.upstream_content_type)}`,
    `raw_byte_length=${diagnostic.raw_byte_length}`,
    `json_classification=${diagnostic.json_classification}`,
    `top_level_type=${diagnostic.top_level_type === undefined ? "-" : quoteDiagnostic(diagnostic.top_level_type)}`,
    `top_level_keys=${diagnostic.top_level_keys === undefined ? "-" : JSON.stringify(diagnostic.top_level_keys)}`,
    `mapper_error_class=${diagnostic.mapper_error_class === undefined ? "-" : quoteDiagnostic(diagnostic.mapper_error_class)}`,
    `mapper_error_code=${diagnostic.mapper_error_code === undefined ? "-" : quoteDiagnostic(diagnostic.mapper_error_code)}`,
  ].join(" ");
}

function quoteDiagnostic(value: string): string {
  return JSON.stringify(value);
}

function responseReject(
  code: string,
  message: string,
  diagnostic?: NativePlaintextSpawnResponseDiagnostic,
): NativePlaintextSpawnReject {
  return {
    status: 502,
    body: {
      error: {
        type: "server_error",
        code,
        message,
        ...(diagnostic ? { diagnostics: diagnostic } : {}),
      },
    },
  };
}

function withMapperDiagnostic(
  diagnostic: NativePlaintextSpawnResponseDiagnostic | undefined,
  error: unknown,
): NativePlaintextSpawnResponseDiagnostic | undefined {
  if (!diagnostic) return undefined;
  const mapperErrorClass = error instanceof Error
    ? error.constructor.name || error.name || "Error"
    : typeof error;
  const mapperErrorCode = error instanceof NativePlaintextSpawnError
    ? error.code
    : isRecord(error) && typeof error.code === "string"
      ? error.code
      : "native_plaintext_spawn_response_invalid";
  return {
    ...diagnostic,
    mapper_error_class: mapperErrorClass,
    mapper_error_code: mapperErrorCode,
  };
}

function reject(
  code: string,
  message: string,
  observedSchemaSha256?: string,
): NativePlaintextSpawnReject {
  return {
    status: code.startsWith("native_plaintext_spawn_response_") ? 502 : 409,
    body: {
      error: {
        type: code.startsWith("native_plaintext_spawn_response_") ? "server_error" : "invalid_request_error",
        code,
        message,
        ...(observedSchemaSha256 ? { observed_schema_sha256: observedSchemaSha256 } : {}),
      },
    },
  };
}

function locateObservedGate1Schema(payload: JsonObject): Gate1SchemaLocationResult {
  // The captured 0.149 wire has no top-level tools. Keeping this guard
  // explicit prevents an older/alternate projection from being accepted by
  // the experiment accidentally.
  if (Object.hasOwn(payload, "tools")) {
    return { reject: reject("native_plaintext_spawn_schema_shape", "native plaintext spawn schema shape is unsupported") };
  }
  if (!Array.isArray(payload.input)) {
    return { reject: reject("native_plaintext_spawn_schema_missing", "native plaintext spawn schema is missing") };
  }

  const additionalIndexes = payload.input.flatMap((item, index) =>
    isRecord(item) && item.type === "additional_tools" ? [index] : [],
  );
  if (additionalIndexes.length === 0) {
    return { reject: reject("native_plaintext_spawn_schema_missing", "native plaintext spawn schema is missing") };
  }
  if (additionalIndexes.length !== 1) {
    return { reject: reject("native_plaintext_spawn_schema_ambiguous", "native plaintext spawn schema is ambiguous") };
  }

  const additionalIndex = additionalIndexes[0]!;
  const additional = payload.input[additionalIndex];
  if (!isRecord(additional) || additional.role !== "developer" || !Array.isArray(additional.tools)) {
    return { reject: reject("native_plaintext_spawn_schema_shape", "native plaintext spawn schema shape is unsupported") };
  }

  // A second tool-bearing input item is an alternate location, not a schema
  // we can safely infer. Ordinary user/developer messages remain untouched.
  for (let index = 0; index < payload.input.length; index += 1) {
    if (index === additionalIndex) continue;
    const item = payload.input[index];
    if (isRecord(item) && Object.hasOwn(item, "tools")) {
      return { reject: reject("native_plaintext_spawn_schema_shape", "native plaintext spawn schema shape is unsupported") };
    }
    if (containsToolVariant(item)) {
      return { reject: reject("native_plaintext_spawn_schema_shape", "native plaintext spawn schema shape is unsupported") };
    }
  }

  if (containsAliasName(additional.tools)) {
    return { reject: reject("native_plaintext_spawn_alias_collision", "native plaintext spawn alias collision") };
  }
  if (additional.tools.length === 0) {
    return { reject: reject("native_plaintext_spawn_schema_missing", "native plaintext spawn schema is missing") };
  }
  if (additional.tools.some((tool) => !isRecord(tool) || tool.type !== "namespace")) {
    return { reject: reject("native_plaintext_spawn_schema_shape", "native plaintext spawn schema shape is unsupported") };
  }
  const namespaceIndexes = additional.tools.flatMap((tool, index) =>
    isCollaborationNamespace(tool) ? [index] : [],
  );
  if (namespaceIndexes.length === 0) {
    return { reject: reject("native_plaintext_spawn_schema_missing", "native plaintext spawn schema is missing") };
  }
  if (namespaceIndexes.length !== 1) {
    return { reject: reject("native_plaintext_spawn_schema_ambiguous", "native plaintext spawn schema is ambiguous") };
  }
  const namespaceIndex = namespaceIndexes[0]!;
  const namespace = additional.tools[namespaceIndex];
  if (!isCollaborationNamespace(namespace)) {
    return { reject: reject("native_plaintext_spawn_schema_shape", "native plaintext spawn schema shape is unsupported") };
  }
  if (additional.tools.some((tool, index) => index !== namespaceIndex && containsCollaborationVariant(tool))) {
    return { reject: reject("native_plaintext_spawn_schema_shape", "native plaintext spawn schema shape is unsupported") };
  }
  if (!Array.isArray(namespace.tools)) {
    return { reject: reject("native_plaintext_spawn_schema_shape", "native plaintext spawn schema shape is unsupported") };
  }
  const names = namespace.tools.map((tool) => (isRecord(tool) ? tool.name : undefined));
  if (names.some((name) => typeof name !== "string")) {
    return { reject: reject("native_plaintext_spawn_schema_shape", "native plaintext spawn schema shape is unsupported") };
  }
  const duplicateReservedName = OBSERVED_COLLABORATION_TOOL_NAMES.find(
    (name) => names.filter((candidate) => candidate === name).length > 1,
  );
  if (duplicateReservedName !== undefined) {
    return { reject: reject("native_plaintext_spawn_schema_ambiguous", "native plaintext spawn schema is ambiguous") };
  }
  if (names.length !== OBSERVED_COLLABORATION_TOOL_NAMES.length) {
    return {
      reject: reject(
        "native_plaintext_spawn_schema_shape",
        "native plaintext spawn schema shape is unsupported",
      ),
    };
  }
  if (!names.every((name, index) => name === OBSERVED_COLLABORATION_TOOL_NAMES[index])) {
    return { reject: reject("native_plaintext_spawn_schema_shape", "native plaintext spawn schema shape is unsupported") };
  }

  const spawnIndex = OBSERVED_COLLABORATION_TOOL_NAMES.indexOf("spawn_agent");
  const sendIndex = OBSERVED_COLLABORATION_TOOL_NAMES.indexOf("send_message");
  const followupIndex = OBSERVED_COLLABORATION_TOOL_NAMES.indexOf("followup_task");
  const spawn = namespace.tools[spawnIndex];
  const send = namespace.tools[sendIndex];
  const followup = namespace.tools[followupIndex];
  if (
    !isRecord(spawn) ||
    !isKnownSpawnSchema(spawn) ||
    !isRecord(send) ||
    !isKnownSendSchema(send) ||
    !isRecord(followup) ||
    !isKnownFollowupSchema(followup)
  ) {
    return { reject: reject("native_plaintext_spawn_schema_shape", "native plaintext spawn schema shape is unsupported") };
  }
  if (containsAliasName(namespace.tools)) {
    return { reject: reject("native_plaintext_spawn_alias_collision", "native plaintext spawn alias collision") };
  }
  return { additionalIndex, namespaceIndex, spawnIndex, sendIndex, followupIndex, additional, namespace, spawn, send, followup };
}

function isCollaborationNamespace(value: unknown): value is JsonObject {
  return isRecord(value) && value.type === "namespace" && value.name === "collaboration" && !Object.hasOwn(value, "namespace");
}

function containsAliasName(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => containsAliasName(item));
  if (!isRecord(value)) return false;
  if (isPlaintextAlias(value.name)) return true;
  if (isRecord(value.function) && isPlaintextAlias(value.function.name)) return true;
  return Object.values(value).some((nested) => containsAliasName(nested));
}

function containsToolVariant(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => containsToolVariant(item));
  if (!isRecord(value)) return false;
  if (value.type === "function" || value.type === "namespace" || value.type === "additional_tools") return true;
  return Object.values(value).some((nested) => containsToolVariant(nested));
}

function containsCollaborationVariant(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => containsCollaborationVariant(item));
  if (!isRecord(value)) return false;
  if (value.type === "function") {
    const name = typeof value.name === "string" ? value.name : "";
    const nestedName = isRecord(value.function) && typeof value.function.name === "string" ? value.function.name : "";
    return (
      name === "spawn_agent" ||
      name === "send_message" ||
      name === "followup_task" ||
      name === "collaboration.spawn_agent" ||
      name === "collaboration.send_message" ||
      name === "collaboration.followup_task" ||
      nestedName === "spawn_agent" ||
      nestedName === "send_message" ||
      nestedName === "followup_task" ||
      nestedName === "collaboration.spawn_agent" ||
      nestedName === "collaboration.send_message" ||
      nestedName === "collaboration.followup_task"
    );
  }
  return Object.values(value).some((nested) => containsCollaborationVariant(nested));
}

function isKnownSpawnSchema(tool: JsonObject): boolean {
  return isKnownEncryptedMessageTool(tool, "spawn_agent");
}

function isKnownSendSchema(tool: JsonObject): boolean {
  return isKnownTargetedMessageSchema(tool, "send_message");
}

function isKnownFollowupSchema(tool: JsonObject): boolean {
  return isKnownTargetedMessageSchema(tool, "followup_task");
}

function isKnownTargetedMessageSchema(
  tool: JsonObject,
  name: "send_message" | "followup_task",
): boolean {
  if (!isKnownEncryptedMessageTool(tool, name)) return false;
  const parameters = tool.parameters;
  if (!isRecord(parameters) || !Array.isArray(parameters.required)) return false;
  if (!parameters.required.includes("target") || !parameters.required.includes("message")) return false;
  const properties = parameters.properties;
  if (!isRecord(properties) || !isRecord(properties.target)) return false;
  return properties.target.type === "string";
}

function isKnownEncryptedMessageTool(tool: JsonObject, name: NativePlaintextCanonicalName): boolean {
  if (tool.type !== "function" || tool.name !== name || Object.hasOwn(tool, "namespace")) return false;
  if (!isRecord(tool.parameters) || tool.parameters.type !== "object") return false;
  if (!isRecord(tool.parameters.properties) || !isRecord(tool.parameters.properties.message)) return false;
  const message = tool.parameters.properties.message;
  return message.type === "string" && message.encrypted === true;
}

function plaintextAliasClone(canonical: JsonObject, alias: NativePlaintextAlias): JsonObject {
  const clone = structuredClone(canonical) as JsonObject;
  clone.name = alias;
  const parameters = clone.parameters;
  if (isRecord(parameters) && isRecord(parameters.properties) && isRecord(parameters.properties.message)) {
    delete parameters.properties.message.encrypted;
  }
  return clone;
}

function mapResponseValue(
  value: unknown,
  context: NativePlaintextSpawnContext,
  allowIncompleteArguments = false,
): unknown {
  if (Array.isArray(value)) return value.map((item) => mapResponseValue(item, context, allowIncompleteArguments));
  if (!isRecord(value)) return value;
  if (isRecord(value.function)) {
    const nestedName = typeof value.function.name === "string" ? value.function.name : "";
    if (isPlaintextAlias(nestedName) || isCanonicalFunctionCall(nestedName, undefined)) {
      throw new NativePlaintextSpawnError(
        "native_plaintext_spawn_alias_shape",
        "native plaintext spawn response returned an unexpected function shape",
      );
    }
  }
  if (value.type === "function_call") return mapFunctionCall(value, context, allowIncompleteArguments);
  const next: JsonObject = {};
  for (const [key, nested] of Object.entries(value)) {
    next[key] = mapResponseValue(nested, context, allowIncompleteArguments);
  }
  return next;
}

function mapFunctionCall(
  item: JsonObject,
  context: NativePlaintextSpawnContext,
  allowIncompleteArguments: boolean,
): JsonObject {
  const name = typeof item.name === "string" ? item.name : "";
  const namespace = typeof item.namespace === "string" && item.namespace.length > 0 ? item.namespace : undefined;
  if (isCanonicalFunctionCall(name, namespace)) {
    throw new NativePlaintextSpawnError(
      "native_plaintext_spawn_canonical_output",
      "native plaintext spawn response returned the reserved collaboration identity",
    );
  }
  const binding = context.bindings.find((candidate) => candidate.alias === name);
  if (!binding) return mapOrdinaryFunctionCall(item, context);
  if (Object.hasOwn(item, "namespace") || Object.hasOwn(item, "function")) {
    throw new NativePlaintextSpawnError(
      "native_plaintext_spawn_alias_shape",
      "native plaintext spawn response returned an unexpected alias shape",
    );
  }
  const args = item.arguments;
  if (
    (typeof args !== "string" && !(allowIncompleteArguments && args === undefined)) ||
    (!allowIncompleteArguments && typeof args === "string" && args.trim().length === 0)
  ) {
    throw new NativePlaintextSpawnError(
      "native_plaintext_spawn_arguments_invalid",
      "native plaintext spawn response arguments are invalid",
    );
  }
  if (Object.hasOwn(item, "encrypted_function_args") && !isEmptyArray(item.encrypted_function_args)) {
    throw new NativePlaintextSpawnError(
      "native_plaintext_spawn_encrypted_output",
      "native plaintext spawn response contains encrypted function arguments",
    );
  }
  if (allowIncompleteArguments && (args === undefined || args.trim().length === 0)) {
    return {
      ...item,
      name: binding.canonicalName,
      namespace: "collaboration",
      encrypted_function_args: [],
    };
  }
  if (typeof args !== "string") {
    throw new NativePlaintextSpawnError(
      "native_plaintext_spawn_arguments_invalid",
      "native plaintext spawn response arguments are invalid",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    throw new NativePlaintextSpawnError(
      "native_plaintext_spawn_arguments_invalid",
      "native plaintext spawn response arguments are invalid",
    );
  }
  assertClosedAliasArguments(parsed, binding);
  return {
    ...item,
    name: binding.canonicalName,
    namespace: "collaboration",
    encrypted_function_args: [],
  };
}

function assertClosedAliasArguments(parsed: unknown, binding: NativePlaintextAliasBinding): void {
  if (!isRecord(parsed)) {
    throw new NativePlaintextSpawnError(
      "native_plaintext_spawn_arguments_invalid",
      "native plaintext spawn response arguments are invalid",
    );
  }
  const keys = Object.keys(parsed);
  if (keys.some((key) => isEncryptedFieldName(key))) {
    throw new NativePlaintextSpawnError(
      "native_plaintext_spawn_encrypted_output",
      "native plaintext spawn response contains encrypted function arguments",
    );
  }
  if (binding.canonicalName === "spawn_agent") {
    if (!keys.every((key) => key === "message" || key === "model") || typeof parsed.message !== "string") {
      throw new NativePlaintextSpawnError(
        "native_plaintext_spawn_arguments_invalid",
        "native plaintext spawn response arguments are invalid",
      );
    }
    if (parsed.model !== undefined && (typeof parsed.model !== "string" || !parsed.model.startsWith("ollama/"))) {
      throw new NativePlaintextSpawnError(
        "native_plaintext_spawn_arguments_invalid",
        "native plaintext spawn response arguments are invalid",
      );
    }
    return;
  }
  if (
    keys.length !== 2 ||
    typeof parsed.message !== "string" ||
    typeof parsed.target !== "string"
  ) {
    throw new NativePlaintextSpawnError(
      "native_plaintext_spawn_arguments_invalid",
      "native plaintext spawn response arguments are invalid",
    );
  }
}

function mapOrdinaryFunctionCall(item: JsonObject, context: NativePlaintextSpawnContext): JsonObject {
  const next: JsonObject = {};
  for (const [key, nested] of Object.entries(item)) {
    next[key] = mapResponseValue(nested, context);
  }
  return next;
}

function isCanonicalFunctionCall(name: string, namespace: string | undefined): boolean {
  return (
    (namespace === undefined || namespace === "collaboration") &&
    (name === "spawn_agent" || name === "send_message" || name === "followup_task")
  ) ||
    name === "collaboration.spawn_agent" ||
    name === "collaboration.send_message" ||
    name === "collaboration.followup_task";
}

function isPlaintextAlias(value: unknown): value is NativePlaintextAlias {
  return (
    value === NATIVE_PLAINTEXT_SPAWN_ALIAS ||
    value === NATIVE_PLAINTEXT_SEND_ALIAS ||
    value === NATIVE_PLAINTEXT_FOLLOWUP_ALIAS
  );
}

function isEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(String(value));
}
