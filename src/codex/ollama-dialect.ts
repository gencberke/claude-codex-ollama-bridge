/**
 * Pinned Ollama Responses dialect. Source/test authority only — not runtime
 * discovery. Normal requests and `cob status` must not call `/api/version`.
 *
 * Reviewed against Ollama 0.33.1 `openai/responses.go`.
 *
 * The tagged 0.33.1 Responses source is unchanged from the reviewed 0.32.15
 * source, so the request and response invariants below remain intentionally
 * narrow.
 */

export const OLLAMA_DIALECT_VERSION = 2 as const;
export const OLLAMA_REVIEWED_VERSION = "0.33.1" as const;
export const OLLAMA_REVIEWED_SOURCE_PATH = "openai/responses.go" as const;
export const OLLAMA_RESPONSES_ENDPOINT = "/v1/responses" as const;

/**
 * Top-level JSON keys shared by Ollama 0.32.15 and 0.33.1
 * `ResponsesRequest`.
 * `tool_choice` is documented as unsupported and is not a struct field.
 * `conversation` is present but not implemented.
 */
export const OLLAMA_0_32_15_RESPONSES_REQUEST_FIELDS = [
  "model",
  "background",
  "conversation",
  "include",
  "input",
  "instructions",
  "max_output_tokens",
  "reasoning",
  "temperature",
  "text",
  "top_p",
  "truncation",
  "tools",
  "stream",
] as const;

/** Reviewed Ollama 0.33.1 Responses request surface that cob forwards. */
export const OLLAMA_REQUEST_ALLOWLIST = [
  "model",
  "input",
  "instructions",
  "max_output_tokens",
  "reasoning",
  "temperature",
  "text",
  "top_p",
  "truncation",
  "tools",
  "stream",
] as const;

export const OLLAMA_ADVISORY_FIELDS = [
  "store",
  "background",
  "include",
  "metadata",
  "client_metadata",
  "stream_options",
  "parallel_tool_calls",
  "reasoning_effort",
  "prompt_cache_key",
  "prompt_cache_retention",
  "safety_identifier",
  "service_tier",
  "previous_response_id",
  "user",
  "max_tool_calls",
] as const;

export const OLLAMA_CLIENT_EXECUTED_CALL_KINDS = ["function_call"] as const;

export const OLLAMA_UNREVIEWED_CALL_KINDS = [
  "custom_tool_call",
  "tool_search_call",
  "computer_call",
  "file_search_call",
  "web_search_call",
  "mcp_call",
  "code_interpreter_call",
  "image_generation_call",
  "local_shell_call",
  "shell_call",
] as const;

export const OLLAMA_SSE_OUTPUT_ITEM_EVENTS = [
  "response.output_item.added",
  "response.output_item.done",
] as const;

export const OLLAMA_SSE_TERMINAL_EVENTS = [
  "response.completed",
  "response.incomplete",
  "response.failed",
] as const;

export type OllamaDialectCapability =
  | "supported"
  | "unsupported"
  | "unknown"
  | "cob-owned";

export const OLLAMA_DIALECT = {
  version: OLLAMA_DIALECT_VERSION,
  upstream: {
    version: OLLAMA_REVIEWED_VERSION,
    sourcePath: OLLAMA_REVIEWED_SOURCE_PATH,
    endpoint: OLLAMA_RESPONSES_ENDPOINT,
  },
  providerState: "stateless" as const,
  request: {
    accepted: OLLAMA_REQUEST_ALLOWLIST,
    advisoryDropped: OLLAMA_ADVISORY_FIELDS,
    upstreamResponsesRequestFields: OLLAMA_0_32_15_RESPONSES_REQUEST_FIELDS,
    correctnessRejected: {
      conversation: "conversation_unsupported",
      unknownField: "ollama_field_unsupported",
      toolChoiceNonAuto: "ollama_tool_choice_unsupported",
      toolChoiceInvalid: "ollama_tool_choice_invalid",
      textFormat: "ollama_text_format_unsupported",
    },
  },
  response: {
    successfulJson: {
      object: "response",
      id: "non-empty-string",
      output: "array",
    },
    sseTerminals: OLLAMA_SSE_TERMINAL_EVENTS,
    /** Ollama 0.32.15 cloud closes after response.completed without [DONE]. */
    sseDone: "optional-after-completed" as const,
    sseOutputItems: OLLAMA_SSE_OUTPUT_ITEM_EVENTS,
    usage: "optional-exact-never-fabricated" as const,
    clientExecutedCallKinds: OLLAMA_CLIENT_EXECUTED_CALL_KINDS,
    unreviewedCallKinds: OLLAMA_UNREVIEWED_CALL_KINDS,
    toolNameSource: "final_outbound_tools" as const,
    namespaceEncoding: "dot-qualified" as const,
    undeclaredTool: "ollama_undeclared_tool_call",
    invalidTool: "ollama_tool_call_invalid",
    invalidResponse: "ollama_response_invalid",
  },
  capabilities: {
    chatCompletions: "unsupported",
    previousResponseId: "cob-owned",
    conversation: "unsupported",
    ollamaCompactEndpoint: "unsupported",
    multiAgentV2: "unsupported",
    undeclaredClientTools: "unsupported",
    usageEstimation: "unsupported",
    retriesAfterHeaders: "unsupported",
    structuredTextJsonSchema: "supported",
    toolChoiceAutoOnly: "supported",
  } satisfies Record<string, OllamaDialectCapability>,
} as const;
