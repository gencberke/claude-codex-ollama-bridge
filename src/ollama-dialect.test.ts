import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OLLAMA_0_32_15_RESPONSES_REQUEST_FIELDS as BOUNDARY_PINNED,
  OLLAMA_ADVISORY_FIELDS as BOUNDARY_ADVISORY,
  OLLAMA_REQUEST_ALLOWLIST as BOUNDARY_ALLOWLIST,
} from "./codex/ollama-boundary.js";
import {
  OLLAMA_0_32_15_RESPONSES_REQUEST_FIELDS,
  OLLAMA_ADVISORY_FIELDS,
  OLLAMA_CLIENT_EXECUTED_CALL_KINDS,
  OLLAMA_DIALECT,
  OLLAMA_DIALECT_VERSION,
  OLLAMA_REQUEST_ALLOWLIST,
  OLLAMA_RESPONSES_ENDPOINT,
  OLLAMA_REVIEWED_SOURCE_PATH,
  OLLAMA_REVIEWED_VERSION,
} from "./codex/ollama-dialect.js";

describe("Ollama dialect authority", () => {
  it("is the single owner of request-field lists consumed by the boundary", () => {
    assert.equal(BOUNDARY_ALLOWLIST, OLLAMA_REQUEST_ALLOWLIST);
    assert.equal(BOUNDARY_ADVISORY, OLLAMA_ADVISORY_FIELDS);
    assert.equal(BOUNDARY_PINNED, OLLAMA_0_32_15_RESPONSES_REQUEST_FIELDS);
    assert.equal(OLLAMA_REQUEST_ALLOWLIST, OLLAMA_DIALECT.request.accepted);
    assert.equal(OLLAMA_ADVISORY_FIELDS, OLLAMA_DIALECT.request.advisoryDropped);
    assert.equal(OLLAMA_0_32_15_RESPONSES_REQUEST_FIELDS, OLLAMA_DIALECT.request.upstreamResponsesRequestFields);
  });

  it("pins the reviewed 0.33.1 Responses surface and stateless provider contract", () => {
    assert.equal(OLLAMA_DIALECT_VERSION, 2);
    assert.equal(OLLAMA_REVIEWED_VERSION, "0.33.1");
    assert.equal(OLLAMA_DIALECT.upstream.version, OLLAMA_REVIEWED_VERSION);
    assert.equal(OLLAMA_DIALECT.upstream.sourcePath, OLLAMA_REVIEWED_SOURCE_PATH);
    assert.equal(OLLAMA_DIALECT.upstream.endpoint, OLLAMA_RESPONSES_ENDPOINT);
    assert.equal(OLLAMA_DIALECT.providerState, "stateless");
    assert.equal(OLLAMA_DIALECT.capabilities.previousResponseId, "cob-owned");
    assert.equal(OLLAMA_DIALECT.capabilities.conversation, "unsupported");
    assert.equal(OLLAMA_DIALECT.capabilities.chatCompletions, "unsupported");
    assert.equal(OLLAMA_DIALECT.capabilities.ollamaCompactEndpoint, "unsupported");
    assert.equal(OLLAMA_DIALECT.capabilities.usageEstimation, "unsupported");
    assert.equal(OLLAMA_DIALECT.response.usage, "optional-exact-never-fabricated");
    assert.equal(OLLAMA_DIALECT.response.toolNameSource, "final_outbound_tools");
    assert.equal(OLLAMA_DIALECT.response.sseDone, "optional-after-completed");
    assert.equal(OLLAMA_DIALECT.response.invalidResponse, "ollama_response_invalid");
    assert.deepEqual([...OLLAMA_CLIENT_EXECUTED_CALL_KINDS], ["function_call"]);
  });

  it("does not encode runtime provider discovery", () => {
    const serialized = JSON.stringify(OLLAMA_DIALECT);
    assert.equal(serialized.includes("/api/version"), false);
    assert.equal(serialized.includes("spawn"), false);
    assert.equal(typeof OLLAMA_DIALECT.version, "number");
  });
});
