import { OLLAMA_PREFIX, PREFERRED_NATIVE_COMPACT_SLUGS } from "./constants.js";
import type { CompactionPolicy } from "./cob-config.js";
import { MAX_COB_COMPACT_SUMMARY_BYTES } from "./compact-envelope.js";
import { isEncryptedFieldName } from "./encrypted.js";
import type { JsonObject } from "./types.js";
import { isRecord } from "./types.js";

export const OLLAMA_COMPACT_HANDOFF_SECTIONS = [
  "Goal",
  "Constraints",
  "Completed",
  "Pending",
  "Decisions",
  "Tool state",
  "Verification/evidence",
] as const;

export type CompactHandoffSection = (typeof OLLAMA_COMPACT_HANDOFF_SECTIONS)[number];
export type CompactHandoffSectionFlags = Record<CompactHandoffSection, boolean>;

export const COB_OLLAMA_COMPACT_INSTRUCTIONS = [
  "You are compacting a conversation for later continuation.",
  "Do not call tools. Reply with the handoff only.",
  "Write these sections in this order using the heading text exactly.",
  "Write None when a section has nothing to record:",
  "",
  ...OLLAMA_COMPACT_HANDOFF_SECTIONS,
].join("\n");

const UNSUPPORTED_OLLAMA_COMPACT_MEDIA = new Set([
  "input_image",
  "input_file",
  "image_url",
  "computer_screenshot",
  "input_audio",
  "audio",
  "image",
]);

export type CompactPlan =
  | { kind: "passthrough-native" }
  | { kind: "summarize-ollama"; compactModel: string }
  | { kind: "native-for-ollama"; compactModel: string }
  | { kind: "error"; status: number; code: string; message: string };

export function compactionHeader(provider: string, model: string): string {
  const rest = model.startsWith(OLLAMA_PREFIX) ? model.slice(OLLAMA_PREFIX.length) : model;
  return `${provider}/${rest}`;
}

export function resolveCompactPlan(opts: {
  threadModel: string;
  target: "native" | "ollama" | "unknown";
  policy: CompactionPolicy;
  nativeSlugs: ReadonlySet<string>;
}): CompactPlan {
  if (opts.target === "native") return { kind: "passthrough-native" };
  if (opts.target !== "ollama") {
    return {
      kind: "error",
      status: 400,
      code: "unknown_model",
      message: `Unknown model ${opts.threadModel}; not in the native catalog and not an ollama/ slug.`,
    };
  }
  if (opts.policy.provider !== "native") {
    return {
      kind: "error",
      status: 400,
      code: "compaction_provider_unsupported",
      message:
        "cob compaction.provider must stay native. Ollama /compact is never called. Set compaction.ollama_threads to summarize or native.",
    };
  }
  const ollamaThreads = opts.policy.ollamaThreads ?? "summarize";
  if (ollamaThreads === "summarize") {
    const compactModel = opts.policy.ollamaModel ?? opts.threadModel;
    if (!compactModel.startsWith(OLLAMA_PREFIX)) {
      return {
        kind: "error",
        status: 400,
        code: "compaction_model_unavailable",
        message:
          "Ollama-thread summarize compact requires an ollama/ slug (the thread model, or compaction.ollama_model). Do not reuse compaction.model, which is the native ChatGPT slug.",
      };
    }
    return { kind: "summarize-ollama", compactModel };
  }
  const compactModel = resolveNativeCompactModel(opts.policy.model, opts.nativeSlugs);
  if (!compactModel) {
    return {
      kind: "error",
      status: 400,
      code: "compaction_model_unavailable",
      message:
        "Native compaction requires a catalogued native model. Set compaction.model to a loaded native slug or add one to the cob catalog.",
    };
  }
  return { kind: "native-for-ollama", compactModel };
}

export const OLLAMA_COMPACT_EFFORTS = ["none", "low", "high", "max"] as const;
export type OllamaCompactEffort = (typeof OLLAMA_COMPACT_EFFORTS)[number];

/** Legacy DeepSeek-compatible effort constant; omitted effort is model-specific on the wire. */
export const DEFAULT_OLLAMA_COMPACT_EFFORT = "high" satisfies OllamaCompactEffort;

export function buildOllamaSummarizerPayload(opts: {
  compactModel: string;
  history: unknown[];
  /** Optional explicit effort. Omit to use the model ladder default (GLM max, DeepSeek high). */
  effort?: OllamaCompactEffort;
}): JsonObject {
  const payload: JsonObject = {
    model: opts.compactModel,
    stream: false,
    store: false,
    instructions: COB_OLLAMA_COMPACT_INSTRUCTIONS,
    input: projectOllamaSummarizerHistory(opts.history),
  };
  if (opts.effort) payload.reasoning = { effort: opts.effort };
  return payload;
}

export function ollamaSummarizerInstructionCopyCount(payload: JsonObject): number {
  let copies = 0;
  if (payload.instructions === COB_OLLAMA_COMPACT_INSTRUCTIONS) copies += 1;
  const input = payload.input;
  if (!Array.isArray(input)) return copies;
  for (const item of input) {
    if (!isRecord(item)) continue;
    if (typeof item.content === "string" && item.content === COB_OLLAMA_COMPACT_INSTRUCTIONS) {
      copies += 1;
      continue;
    }
    if (!Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (isRecord(part) && part.text === COB_OLLAMA_COMPACT_INSTRUCTIONS) copies += 1;
    }
  }
  return copies;
}

export function compactHandoffSectionFlags(text: string): CompactHandoffSectionFlags {
  const parsed = parseCompactHandoffSections(text);
  const flags = {} as CompactHandoffSectionFlags;
  for (const name of OLLAMA_COMPACT_HANDOFF_SECTIONS) {
    flags[name] = parsed.some((section) => section.name === name);
  }
  return flags;
}

export function formatCompactSectionFlags(flags: CompactHandoffSectionFlags): string {
  return OLLAMA_COMPACT_HANDOFF_SECTIONS.map((name) => `${compactSectionLogKey(name)}:${flags[name] ? 1 : 0}`).join(",");
}

function compactSectionLogKey(name: CompactHandoffSection): string {
  return name.replaceAll(" ", "_").replaceAll("/", "_");
}

type ParsedCompactHandoffSection = {
  name: CompactHandoffSection;
  body: string;
};

/**
 * Recognize only complete heading lines. Plain headings keep the shipped
 * `Goal: body` form; Markdown ATX and bold headings may put the body on the
 * following line. Bold headings also support an inline body after the colon.
 */
function parseCompactHandoffHeading(
  line: string,
): { name: CompactHandoffSection; inlineBody: string } | undefined {
  const trimmed = line.trim();
  for (const name of OLLAMA_COMPACT_HANDOFF_SECTIONS) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const plain = trimmed.match(new RegExp(`^${escaped}\\s*:\\s*(.*)$`));
    if (plain) return { name, inlineBody: plain[1] ?? "" };
    if (trimmed === name) return { name, inlineBody: "" };

    // ATX headings are standalone: `## Goal` (with optional closing hashes).
    if (new RegExp(`^#{1,6}[ \\t]+${escaped}\\s*:?(?:[ \\t]+#+)?$`).test(trimmed)) {
      return { name, inlineBody: "" };
    }

    const bold = trimmed.match(new RegExp(`^\\*\\*${escaped}\\*\\*\\s*:\\s*(.*)$`));
    if (bold) return { name, inlineBody: bold[1] ?? "" };
    const boldColon = trimmed.match(new RegExp(`^\\*\\*${escaped}:\\*\\*\\s*(.*)$`));
    if (boldColon) return { name, inlineBody: boldColon[1] ?? "" };
    if (trimmed === `**${name}**`) return { name, inlineBody: "" };
  }
  return undefined;
}

function parseCompactHandoffSections(text: string): ParsedCompactHandoffSection[] {
  const sections: ParsedCompactHandoffSection[] = [];
  let current: { name: CompactHandoffSection; bodyLines: string[] } | undefined;
  const finishCurrent = (): void => {
    if (!current) return;
    sections.push({ name: current.name, body: current.bodyLines.join("\n").trim() });
  };

  for (const line of text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")) {
    const heading = parseCompactHandoffHeading(line);
    if (heading) {
      finishCurrent();
      current = { name: heading.name, bodyLines: [heading.inlineBody] };
    } else if (current) {
      current.bodyLines.push(line);
    }
  }
  finishCurrent();
  return sections;
}

export function ollamaCompactHandoffSkeleton(
  body: Partial<Record<CompactHandoffSection, string>> = {},
): string {
  return OLLAMA_COMPACT_HANDOFF_SECTIONS.map((name) => `${name}: ${body[name] ?? "None"}`).join("\n");
}

/**
 * Stage 3: a malformed or incomplete skeleton fails closed. Missing headings
 * are not filled in, and cob does not resend the full history.
 */
export function incompleteOllamaCompactHandoffError(
  text: string,
): Extract<OllamaSummaryExtract, { kind: "error" }> | undefined {
  const sections = parseCompactHandoffSections(text);
  const firstContentLine = text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .find((line) => line.trim().length > 0);
  const firstHeading = firstContentLine ? parseCompactHandoffHeading(firstContentLine) : undefined;
  const isComplete =
    firstHeading?.name === OLLAMA_COMPACT_HANDOFF_SECTIONS[0] &&
    sections.length === OLLAMA_COMPACT_HANDOFF_SECTIONS.length &&
    sections.every(
      (section, index) =>
        section.name === OLLAMA_COMPACT_HANDOFF_SECTIONS[index] && section.body.length > 0,
    );
  if (isComplete) return undefined;
  return {
    kind: "error",
    code: "compaction_summary_incomplete",
    message:
      "Ollama compact summarizer returned an incomplete or malformed handoff; resend the full context without compacting because cob will not automatically resend history",
  };
}

const OLLAMA_SUMMARIZER_KEEP_TYPES = new Set(["message", "reasoning"]);

const OLLAMA_SUMMARIZER_DROP_TYPES = new Set([
  "item_reference",
  "compaction",
  "compaction_trigger",
]);

/**
 * Ollama /v1/responses 400s on Codex-only input types (item_reference,
 * web_search_call, …). Keep messages and reasoning; drop pointer-only items;
 * flatten tool/search records to a short text note. Live function_call items
 * prime 0731 to keep calling tools on a no-tools compact request.
 */
export function projectOllamaSummarizerHistory(history: unknown[]): unknown[] {
  const next: unknown[] = [];
  for (const item of Array.isArray(history) ? history : []) {
    const projected = projectOllamaSummarizerItem(item);
    if (projected !== undefined) next.push(projected);
  }
  return next;
}

function projectOllamaSummarizerItem(item: unknown): unknown | undefined {
  if (!isRecord(item) || typeof item.type !== "string") return item;
  if (OLLAMA_SUMMARIZER_DROP_TYPES.has(item.type)) return undefined;
  if (item.type === "reasoning" && isEmptyReasoningItem(item)) return undefined;
  if (OLLAMA_SUMMARIZER_KEEP_TYPES.has(item.type)) return item;
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: compactUnknownItemNote(item) }],
  };
}

function isEmptyReasoningItem(value: JsonObject): boolean {
  const hasSummary = Array.isArray(value.summary) && value.summary.length > 0;
  const hasContent = Array.isArray(value.content) && value.content.length > 0;
  return !hasSummary && !hasContent;
}

function compactUnknownItemNote(item: JsonObject): string {
  const type = String(item.type);
  const parts = [`[compact item ${type}]`];
  for (const key of ["name", "call_id", "query", "action", "status", "arguments", "output", "text"]) {
    const clipped = clipCompactNoteValue(item[key]);
    if (clipped) parts.push(`${key}=${clipped}`);
  }
  return parts.join(" ");
}

function clipCompactNoteValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    return trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed;
  }
  if (Array.isArray(value) || isRecord(value)) {
    const json = JSON.stringify(value);
    if (!json || json === "{}" || json === "[]") return undefined;
    return json.length > 500 ? `${json.slice(0, 500)}…` : json;
  }
  return undefined;
}

export function ollamaSummaryHandoffItem(summary: string): JsonObject {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "input_text", text: summary }],
  };
}

export type OllamaSummaryExtract =
  | { kind: "ok"; text: string }
  | { kind: "error"; code: string; message: string };

export function extractOllamaCompactSummary(value: unknown): OllamaSummaryExtract {
  const envelope = isRecord(value) && isRecord(value.response) ? value.response : value;
  if (!isRecord(envelope)) {
    return {
      kind: "error",
      code: "compaction_summary_invalid",
      message: "Ollama compact summarizer response is not an object",
    };
  }
  if (typeof envelope.status === "string" && envelope.status !== "completed") {
    return {
      kind: "error",
      code: envelope.status === "incomplete" ? "compaction_summary_truncated" : "compaction_summary_invalid",
      message: `Ollama compact summarizer status is ${envelope.status}`,
    };
  }
  if (isRecord(envelope.incomplete_details)) {
    return {
      kind: "error",
      code: "compaction_summary_truncated",
      message: "Ollama compact summarizer response was truncated",
    };
  }
  if (!Array.isArray(envelope.output)) {
    return {
      kind: "error",
      code: "compaction_summary_invalid",
      message: "Ollama compact summarizer response has no output array",
    };
  }
  const texts: string[] = [];
  const reasoningTexts: string[] = [];
  let calledTool = false;
  for (const item of envelope.output) {
    if (!isRecord(item)) continue;
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      calledTool = true;
      continue;
    }
    if (item.type === "reasoning" && Array.isArray(item.summary)) {
      for (const part of item.summary) {
        if (isRecord(part) && part.type === "summary_text" && typeof part.text === "string") {
          reasoningTexts.push(part.text);
        }
      }
    }
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    if (item.status === "incomplete") {
      return {
        kind: "error",
        code: "compaction_summary_truncated",
        message: "Ollama compact summarizer message was truncated",
      };
    }
    for (const part of item.content) {
      if (!isRecord(part)) continue;
      if ((part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
        texts.push(part.text);
      }
    }
  }
  const text = texts.join("\n").trim() || reasoningTexts.join("\n").trim();
  if (text.length === 0) {
    if (calledTool) {
      return {
        kind: "error",
        code: "compaction_summary_invalid",
        message: "Ollama compact summarizer called a tool; cob refuses to treat that as a handoff",
      };
    }
    return {
      kind: "error",
      code: "compaction_summary_empty",
      message: "Ollama compact summarizer returned no handoff text",
    };
  }
  if (Buffer.byteLength(text, "utf8") > MAX_COB_COMPACT_SUMMARY_BYTES) {
    return {
      kind: "error",
      code: "compaction_summary_too_large",
      message: `Ollama compact summary exceeds ${MAX_COB_COMPACT_SUMMARY_BYTES} bytes`,
    };
  }
  return { kind: "ok", text };
}

export function unsupportedOllamaCompactMediaError(value: unknown, path = "input"): string | undefined {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const err = unsupportedOllamaCompactMediaError(value[i], `${path}[${i}]`);
      if (err) return err;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (typeof value.type === "string" && UNSUPPORTED_OLLAMA_COMPACT_MEDIA.has(value.type)) {
    return `${path}: ${value.type} cannot be summarized; resend the full context without images or files`;
  }
  for (const [key, nested] of Object.entries(value)) {
    const err = unsupportedOllamaCompactMediaError(nested, `${path}.${key}`);
    if (err) return err;
  }
  return undefined;
}

export function resolveNativeCompactModel(
  configured: string | undefined,
  nativeSlugs: ReadonlySet<string>,
): string | undefined {
  if (configured && configured.trim().length > 0) {
    const model = configured.trim();
    return nativeSlugs.has(model) ? model : undefined;
  }
  for (const slug of PREFERRED_NATIVE_COMPACT_SLUGS) {
    if (nativeSlugs.has(slug)) return slug;
  }
  return nativeSlugs.values().next().value;
}

export type CompactionTriggerResult =
  | { kind: "none" }
  | { kind: "trigger"; inputWithoutTrigger: unknown[] }
  | { kind: "error"; status: number; code: string; message: string };

/**
 * Classify the v2 compaction trigger before any provider-specific rewriting.
 * The trigger is transient and must never enter the Ollama transcript or a
 * durable checkpoint history.
 */
export function classifyCompactionTrigger(payload: JsonObject): CompactionTriggerResult {
  if (!Array.isArray(payload.input)) return { kind: "none" };
  const triggerIndexes = payload.input.flatMap((item, index) =>
    isRecord(item) && item.type === "compaction_trigger" ? [index] : [],
  );
  if (triggerIndexes.length === 0) return { kind: "none" };
  if (triggerIndexes.length !== 1 || triggerIndexes[0] !== payload.input.length - 1) {
    return {
      kind: "error",
      status: 400,
      code: "invalid_compaction_trigger",
      message: "Responses compaction requires exactly one terminal compaction_trigger input item.",
    };
  }
  return { kind: "trigger", inputWithoutTrigger: payload.input.slice(0, -1) };
}

export function findCompactionInputItem(payload: JsonObject): JsonObject | undefined {
  if (!Array.isArray(payload.input)) return undefined;
  return payload.input.find(
    (item): item is JsonObject => isRecord(item) && item.type === "compaction",
  );
}

/**
 * Validate the completed response returned by the native v2 compactor. The
 * encrypted payload is intentionally opaque: cob checks shape and presence,
 * never attempts to decrypt or manufacture replacement ciphertext.
 */
export function nativeCompactionResponseError(value: unknown): string | undefined {
  const envelope = isRecord(value) && isRecord(value.response) ? value.response : value;
  if (!isRecord(envelope)) return "native compaction response is not an object";
  if (envelope.status !== "completed") {
    return `native compaction response status is ${typeof envelope.status === "string" ? envelope.status : "missing"}`;
  }
  if (!Array.isArray(envelope.output)) return "native compaction response has no output array";
  const items = envelope.output.filter(
    (item): item is JsonObject => isRecord(item) && item.type === "compaction",
  );
  if (items.length !== 1) {
    return `native compaction response must contain exactly one compaction output item; got ${items.length}`;
  }
  const encrypted = items[0]?.encrypted_content;
  if (typeof encrypted !== "string" || encrypted.trim().length === 0) {
    return "native compaction output is missing encrypted_content";
  }
  if (typeof envelope.id !== "string" || envelope.id.trim().length === 0) {
    return "native compaction response is missing a response id";
  }
  return undefined;
}

/**
 * Project one archived item into the subset accepted as Ollama follow-up
 * input. Compaction items are deliberately left opaque here; callers must
 * resolve them from the bridge-owned checkpoint before forwarding.
 */
export function projectOllamaInputValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => projectOllamaInputValue(item));
  if (!isRecord(value)) return value;
  const next: JsonObject = {};
  for (const [key, nested] of Object.entries(value)) {
    if (isEncryptedFieldName(key)) continue;
    if (key === "status" && value.type === "message") continue;
    next[key] = projectOllamaInputValue(nested);
  }
  if (next.type === "output_text") {
    next.type = "input_text";
  }
  return next;
}

/**
 * Native Responses compaction rejects assistant `input_text` (`output_text` or
 * `refusal` only). Cob stores Ollama-safe history, so restore assistant content
 * types before the ChatGPT compact call. User/developer messages stay
 * `input_text`. Ciphertext is never forwarded.
 *
 * Ollama-thread compact uses `store: false` (the v2 compactor rejects stored
 * responses). Codex still embeds item ids (`rs_…`, `msg_…`) from the local
 * thread; ChatGPT then 404s looking them up. Strip those ids, drop
 * id-only references, and keep in-request `call_id` pairing.
 */
export function projectNativeCompactInput(value: unknown): unknown {
  if (Array.isArray(value)) {
    const next: unknown[] = [];
    for (const item of value) {
      const projected = projectNativeCompactInput(item);
      if (shouldDropNativeCompactItem(projected)) continue;
      next.push(projected);
    }
    return next;
  }
  if (!isRecord(value)) return value;
  const next: JsonObject = {};
  for (const [key, nested] of Object.entries(value)) {
    if (isEncryptedFieldName(key)) continue;
    next[key] = projectNativeCompactInput(nested);
  }
  if (typeof next.type === "string") {
    delete next.id;
  }
  if (next.type === "message" && next.role === "assistant" && Array.isArray(next.content)) {
    next.content = next.content.map((part) => {
      if (!isRecord(part) || part.type !== "input_text") return part;
      return { ...part, type: "output_text" };
    });
  }
  return next;
}

function shouldDropNativeCompactItem(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "item_reference") return true;
  if (value.type !== "reasoning") return false;
  return isEmptyReasoningItem(value);
}

export function nativeCompactRequest(payload: JsonObject, compactModel: string): JsonObject {
  const next: JsonObject = {
    ...payload,
    model: compactModel,
  };
  delete next.previous_response_id;
  // The ChatGPT v2 compactor rejects stored responses. Native-thread
  // passthrough remains byte-for-byte; this applies only to Ollama reroutes.
  next.store = false;
  return next;
}

export function isResponseEnvelope(value: JsonObject): boolean {
  return (
    value.object === "response" ||
    value.object === "response.compaction" ||
    Array.isArray(value.output)
  );
}

/** Strict wire check for any input that is about to cross into Ollama. */
export function ollamaFollowUpInputError(value: unknown, path = "input"): string | undefined {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const err = ollamaFollowUpInputError(value[i], `${path}[${i}]`);
      if (err) return err;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (value.type === "compaction" || value.type === "compaction_trigger") {
    return `${path}: ${value.type} must be resolved by cob before Ollama forwarding`;
  }
  if (
    Object.entries(value).some(
      ([key, nested]) =>
        isEncryptedFieldName(key) && nested !== undefined && nested !== "" && !(Array.isArray(nested) && nested.length === 0),
    )
  ) {
    return `${path}: encrypted fields must not be sent to Ollama`;
  }
  if (value.type === "message") {
    if (value.status !== undefined) {
      return `${path}: output-only status is not valid on Ollama input items`;
    }
    if (Array.isArray(value.content)) {
      for (let i = 0; i < value.content.length; i += 1) {
        const part = value.content[i];
        if (isRecord(part) && part.type === "output_text") {
          return `${path}.content[${i}]: output_text is not valid on Ollama input items`;
        }
      }
    }
  }
  for (const [key, nested] of Object.entries(value)) {
    if (isEncryptedFieldName(key)) continue;
    const err = ollamaFollowUpInputError(nested, `${path}.${key}`);
    if (err) return err;
  }
  return undefined;
}

export function assertValidOllamaFollowUpInput(value: unknown): void {
  const err = ollamaFollowUpInputError(value);
  if (err) throw new Error(err);
}
