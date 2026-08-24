import {
  OLLAMA_CLIENT_EXECUTED_CALL_KINDS,
  OLLAMA_DIALECT,
  OLLAMA_SSE_OUTPUT_ITEM_EVENTS,
  OLLAMA_SSE_TERMINAL_EVENTS,
  OLLAMA_UNREVIEWED_CALL_KINDS,
} from "./ollama-dialect.js";
import { sha256Hex8 } from "./request-metrics.js";
import { sseDoneTerminal } from "./relay.js";
import type { JsonObject } from "./types.js";
import { isRecord } from "./types.js";

export const OLLAMA_GUARD_NAME_PREVIEW_CHARS = 100;

const REVIEWED_CALL = new Set<string>(OLLAMA_CLIENT_EXECUTED_CALL_KINDS);
const UNREVIEWED_CALL = new Set<string>(OLLAMA_UNREVIEWED_CALL_KINDS);
const SSE_OUTPUT_ITEMS = new Set<string>(OLLAMA_SSE_OUTPUT_ITEM_EVENTS);
const SSE_TERMINALS = new Set<string>(OLLAMA_SSE_TERMINAL_EVENTS);

export type OllamaToolDeclaration = {
  readonly names: ReadonlySet<string>;
  readonly count: number;
  readonly sha8: string;
};

export type OllamaGuardCode =
  | typeof OLLAMA_DIALECT.response.undeclaredTool
  | typeof OLLAMA_DIALECT.response.invalidTool;

export type OllamaGuardKind = "undeclared" | "invalid_name" | "invalid_type" | "empty_name";

export type OllamaGuardFailure = {
  code: OllamaGuardCode;
  kind: OllamaGuardKind;
  nameLength: number;
  nameSha8: string;
  preview: string;
};

export type OllamaResponseGuardState = {
  failure?: OllamaGuardFailure;
};

export function emptyOllamaToolDeclaration(): OllamaToolDeclaration {
  return declareOllamaWireTools({});
}

export function declareOllamaWireTools(payload: JsonObject): OllamaToolDeclaration {
  const ordered: string[] = [];
  const names = new Set<string>();
  for (const name of collectOllamaWireToolNames(payload.tools)) {
    if (names.has(name)) continue;
    names.add(name);
    ordered.push(name);
  }
  return Object.freeze({
    names,
    count: ordered.length,
    sha8: sha256Hex8(ordered),
  });
}

export function collectOllamaWireToolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  const names: string[] = [];
  for (const tool of flattenToolDefs(tools)) {
    const name = toolFunctionName(tool);
    if (name) names.push(name);
  }
  return names;
}

export function guardOllamaJsonResponse(
  value: unknown,
  declaration: OllamaToolDeclaration,
): OllamaGuardFailure | undefined {
  return inspectOutputBearingValue(value, declaration);
}

export function inspectOllamaSseEvent(
  value: unknown,
  declaration: OllamaToolDeclaration,
): OllamaGuardFailure | undefined {
  if (!isRecord(value)) return undefined;
  const type = typeof value.type === "string" ? value.type : undefined;
  if (type && SSE_OUTPUT_ITEMS.has(type)) {
    return inspectCallItem(value.item, declaration);
  }
  if (type === "response.failed") return undefined;
  if (type && SSE_TERMINALS.has(type)) {
    return inspectOutputBearingValue(value.response, declaration);
  }
  if (type === undefined) return inspectOutputBearingValue(value, declaration);
  return undefined;
}

export function ollamaGuardHttpBody(failure: OllamaGuardFailure): JsonObject {
  return {
    error: {
      type: "upstream_error",
      code: failure.code,
      message: ollamaGuardMessage(failure),
    },
  };
}

export function ollamaGuardFailedEvent(failure: OllamaGuardFailure): JsonObject {
  return {
    type: "response.failed",
    response: {
      status: "failed",
      error: {
        type: "upstream_error",
        code: failure.code,
        message: ollamaGuardMessage(failure),
      },
    },
  };
}

export function ollamaGuardSseTerminal(failure: OllamaGuardFailure): string {
  return `data: ${JSON.stringify(ollamaGuardFailedEvent(failure))}\n\n${sseDoneTerminal()}`;
}

export function formatOllamaGuardLog(
  failure: OllamaGuardFailure,
  declaration: OllamaToolDeclaration,
): string {
  return [
    "[cob] ollama guard rejected",
    `code=${failure.code}`,
    `kind=${failure.kind}`,
    `name_len=${failure.nameLength}`,
    `name_sha=${failure.nameSha8}`,
    `declared_n=${declaration.count}`,
    `declared_sha=${declaration.sha8}`,
  ].join(" ");
}

export function ollamaGuardMessage(failure: OllamaGuardFailure): string {
  if (failure.code === OLLAMA_DIALECT.response.invalidTool) {
    if (failure.kind === "invalid_type") {
      return "Ollama returned an unreviewed client tool call type.";
    }
    return "Ollama returned a client tool call with an invalid name.";
  }
  if (failure.preview.length > 0) {
    return `Ollama returned a client tool call that was not in the final outbound catalog: ${failure.preview}`;
  }
  return "Ollama returned a client tool call that was not in the final outbound catalog.";
}

function inspectOutputBearingValue(
  value: unknown,
  declaration: OllamaToolDeclaration,
): OllamaGuardFailure | undefined {
  if (!isRecord(value)) return undefined;
  const direct = inspectOutputArray(value.output, declaration);
  if (direct) return direct;
  if (isRecord(value.response)) return inspectOutputArray(value.response.output, declaration);
  return undefined;
}

function inspectOutputArray(
  output: unknown,
  declaration: OllamaToolDeclaration,
): OllamaGuardFailure | undefined {
  if (!Array.isArray(output)) return undefined;
  for (const item of output) {
    const failure = inspectCallItem(item, declaration);
    if (failure) return failure;
  }
  return undefined;
}

function inspectCallItem(item: unknown, declaration: OllamaToolDeclaration): OllamaGuardFailure | undefined {
  if (!isRecord(item)) return undefined;
  const kind = classifyCallType(item.type);
  if (kind === undefined) return undefined;
  if (kind === "unreviewed") {
    return guardFailure("invalid_type", OLLAMA_DIALECT.response.invalidTool, readRawCallName(item));
  }
  return inspectReviewedCallName(item, declaration);
}

function inspectReviewedCallName(
  item: JsonObject,
  declaration: OllamaToolDeclaration,
): OllamaGuardFailure | undefined {
  const raw = readRawCallName(item);
  if (typeof raw !== "string") {
    return guardFailure("invalid_name", OLLAMA_DIALECT.response.invalidTool, raw);
  }
  const name = raw.trim();
  if (name.length === 0) {
    return guardFailure("empty_name", OLLAMA_DIALECT.response.invalidTool, raw);
  }
  if (!declaration.names.has(name)) {
    return guardFailure("undeclared", OLLAMA_DIALECT.response.undeclaredTool, name);
  }
  return undefined;
}

function classifyCallType(type: unknown): "reviewed" | "unreviewed" | undefined {
  if (typeof type !== "string") return undefined;
  if (REVIEWED_CALL.has(type)) return "reviewed";
  if (UNREVIEWED_CALL.has(type)) return "unreviewed";
  if (type.endsWith("_call") && !type.endsWith("_call_output")) return "unreviewed";
  return undefined;
}

function readRawCallName(item: JsonObject): unknown {
  if ("name" in item) return item.name;
  if (isRecord(item.function) && "name" in item.function) return item.function.name;
  return undefined;
}

function guardFailure(kind: OllamaGuardKind, code: OllamaGuardCode, rawName: unknown): OllamaGuardFailure {
  const name = typeof rawName === "string" ? rawName : "";
  return {
    code,
    kind,
    nameLength: name.length,
    nameSha8: sha256Hex8(typeof rawName === "string" ? rawName : null),
    preview: safeNamePreview(name),
  };
}

function safeNamePreview(name: string): string {
  if (name.length === 0) return "";
  const clipped = name.length > OLLAMA_GUARD_NAME_PREVIEW_CHARS
    ? name.slice(0, OLLAMA_GUARD_NAME_PREVIEW_CHARS)
    : name;
  const escaped = JSON.stringify(clipped);
  return escaped.length > OLLAMA_GUARD_NAME_PREVIEW_CHARS
    ? escaped.slice(0, OLLAMA_GUARD_NAME_PREVIEW_CHARS)
    : escaped;
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

function toolFunctionName(tool: JsonObject): string | undefined {
  if (typeof tool.name === "string" && tool.name.trim().length > 0) return tool.name.trim();
  if (isRecord(tool.function) && typeof tool.function.name === "string" && tool.function.name.trim().length > 0) {
    return tool.function.name.trim();
  }
  return undefined;
}
