import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { G24_CORPUS_VERSION, G24_CORPUS, G24_HANDOFF_SKELETON, g24CorpusSha256 } from "./eval-g24-corpus.js";
import { buildOllamaSummarizerPayload, projectOllamaSummarizerHistory, parseOllamaCompactTranscript } from "./codex/compaction/summary.js";
import { incompleteOllamaCompactHandoffError } from "./codex/compaction/summary.js";

describe("G24 versioned corpus", () => {
  it("pins the deterministic corpus hash and version", () => {
    assert.equal(G24_CORPUS_VERSION, 2);
    assert.equal(g24CorpusSha256(), g24CorpusSha256());
    // Recorded pin: a corpus change must bump G24_CORPUS_VERSION and this
    // hash together; a silent mutation fails here.
    assert.equal(g24CorpusSha256(), "cc5a64268a6cd3ad1802024d30ba5f35d05a703065a91a978167fba7ceb8909b");
  });

  it("carries the transcript-V2 adversarial and nested tool/search lanes", () => {
    const roles = G24_CORPUS.map((item) => (item as { role?: string }).role);
    assert.ok(roles.includes("developer"));
    assert.ok(G24_CORPUS.some((item) => (item as { type?: string }).type === "web_search_call"));
    // Projected transcript keeps the adversarial developer instruction only
    // as escaped data and never as a live top-level role.
    const projected = projectOllamaSummarizerHistory([...G24_CORPUS]);
    const payload = buildOllamaSummarizerPayload({ compactModel: "ollama/x", history: projected });
    const input = payload.input as { role?: string; content?: { text: string }[] }[];
    assert.equal(input.length, 1);
    assert.notEqual(input[0]!.role, "developer");
    assert.notEqual(input[0]!.role, "system");
    const transcript = parseOllamaCompactTranscript(input[0]!.content![0]!.text);
    assert.ok(transcript);
    const serialized = JSON.stringify(transcript.items);
    assert.match(serialized, /ignore the compact contract/);
    assert.match(serialized, /compact item web_search_call/);
    assert.match(serialized, /compact item function_call/);
    assert.equal(serialized.includes('"type":"function_call"'), false);
    const transcriptRoles = transcript.items.map(
      (item: unknown) => (item as { role?: string }).role ?? null,
    ) as (string | null)[];
    assert.ok(transcriptRoles.includes("developer"));
  });

  it("pins a successful handoff skeleton that passes the shared validator", () => {
    assert.equal(incompleteOllamaCompactHandoffError(G24_HANDOFF_SKELETON), undefined);
    assert.match(G24_HANDOFF_SKELETON, /^Goal: /);
  });
});
