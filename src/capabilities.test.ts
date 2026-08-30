import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  nativeRowAdvertisesAutoCompactTokenLimit,
  ollamaChildCatalogFields,
  ollamaChildProfile,
  evidenceFromOllamaTag,
} from "./codex/capabilities.js";

describe("ollama child capability profile", () => {
  it("infers shell and function tools only from the exact lowercase tools tag", () => {
    const evidence = evidenceFromOllamaTag({
      name: "deepseek-v4-flash:cloud",
      capabilities: ["completion", "tools", "thinking", "vision"],
    });
    const profile = ollamaChildProfile(evidence);
    assert.equal(profile.transport, "responses");
    assert.equal(profile.subagentRole, "child-only");
    assert.equal(profile.multiAgentVersion, "v1");
    assert.equal(profile.supportsFunctionTools, true);
    assert.equal(profile.supportsParallelToolCalls, false);
    assert.equal(profile.supportsApplyPatch, false);
    assert.equal(profile.supportsShell, true);
    assert.equal(profile.supportsSearch, false);
    assert.equal(profile.previousResponseState, "unsupported");
    assert.equal(profile.supportsReasoning, true);
    assert.equal(profile.supportsVision, true);
  });

  it("advertises DeepSeek thinking efforts when thinking is present", () => {
    const fields = ollamaChildCatalogFields({
      evidence: { tools: true, thinking: true, vision: false },
      skeleton: {
        supported_reasoning_levels: [
          { effort: "low", description: "low" },
          { effort: "medium", description: "medium" },
          { effort: "high", description: "high" },
          { effort: "xhigh", description: "xhigh" },
        ],
        effective_context_window_percent: 95,
      },
      contextWindow: 1024,
    });
    const efforts = (fields.supported_reasoning_levels as { effort: string }[]).map((level) => level.effort);
    assert.deepEqual(efforts, ["none", "low", "high", "max"]);
    assert.equal(fields.default_reasoning_level, "high");
    assert.equal(fields.supports_parallel_tool_calls, false);
    assert.equal(fields.supports_search_tool, false);
    assert.equal(fields.support_verbosity, false);
    assert.equal(fields.shell_type, "unified_exec");
    assert.equal("apply_patch_tool_type" in fields, false);
    assert.equal("tool_mode" in fields, false);
  });

  it("does not advertise reasoning when thinking is absent", () => {
    const evidence = evidenceFromOllamaTag({
      name: "qwen2.5:7b",
      capabilities: ["completion"],
    });
    assert.equal(evidence.thinking, false);
    const profile = ollamaChildProfile(evidence);
    assert.equal(profile.supportsReasoning, false);
    const fields = ollamaChildCatalogFields({
      evidence,
      skeleton: {
        supported_reasoning_levels: [
          { effort: "low", description: "low" },
          { effort: "medium", description: "medium" },
          { effort: "high", description: "high" },
        ],
        effective_context_window_percent: 95,
      },
      contextWindow: 32768,
    });
    assert.deepEqual(fields.supported_reasoning_levels, []);
    assert.equal("default_reasoning_level" in fields, false);
  });

  it("does not copy xhigh or medium from the native skeleton", () => {
    const fields = ollamaChildCatalogFields({
      evidence: { tools: true, thinking: true, vision: false },
      skeleton: {
        supported_reasoning_levels: [{ effort: "high", description: "high" }],
      },
      contextWindow: 1024,
    });
    const efforts = (fields.supported_reasoning_levels as { effort: string }[]).map((level) => level.effort);
    assert.deepEqual(efforts, ["none", "low", "high", "max"]);
    assert.equal(fields.default_reasoning_level, "high");
  });

  it("advertises the always-on GLM-5.3 Flash ladder with max as default", () => {
    const fields = ollamaChildCatalogFields({
      evidence: { tools: true, thinking: true, vision: true },
      skeleton: {
        supported_reasoning_levels: [
          { effort: "low", description: "low" },
          { effort: "medium", description: "medium" },
          { effort: "high", description: "high" },
          { effort: "xhigh", description: "xhigh" },
          { effort: "max", description: "max" },
        ],
      },
      contextWindow: 256000,
      model: "ollama/glm-5.3-flash:cloud",
    });
    assert.deepEqual(
      (fields.supported_reasoning_levels as { effort: string }[]).map((level) => level.effort),
      ["low", "high", "max"],
    );
    assert.equal(fields.default_reasoning_level, "max");
    assert.equal(fields.input_modalities instanceof Array && fields.input_modalities.includes("image"), true);
  });

  it("does not select the GLM ladder from an unrelated substring", () => {
    const fields = ollamaChildCatalogFields({
      evidence: { tools: true, thinking: true, vision: false },
      skeleton: {},
      contextWindow: 256000,
      model: "ollama/not-glm-5.3-flash:cloud",
    });
    assert.equal(fields.default_reasoning_level, "high");
    assert.equal(
      (fields.supported_reasoning_levels as { effort: string }[])[0]?.effort,
      "none",
    );
  });

  it("can advertise search on the catalog row when opted in", () => {
    const fields = ollamaChildCatalogFields({
      evidence: { tools: true, thinking: true, vision: false },
      skeleton: {},
      contextWindow: 1024,
      supportsSearchTool: true,
    });
    assert.equal(fields.supports_search_tool, true);
  });

  it("advertises only cob-owned freeform apply_patch when explicitly enabled", () => {
    const off = ollamaChildCatalogFields({
      evidence: { tools: true, thinking: true, vision: false },
      skeleton: {},
      contextWindow: 1024,
    });
    assert.equal("apply_patch_tool_type" in off, false);
    const on = ollamaChildCatalogFields({
      evidence: { tools: true, thinking: true, vision: false },
      skeleton: {},
      contextWindow: 1024,
      applyPatch: true,
    });
    assert.equal(on.apply_patch_tool_type, "freeform");
    assert.equal(on.shell_type, "unified_exec");
    assert.equal(on.multi_agent_version, "v1");
    assert.equal("tool_mode" in on, false);
    assert.equal(ollamaChildProfile({ tools: true, thinking: true, vision: false }, { supportsApplyPatch: true }).supportsApplyPatch, true);
  });

  it("splits max from active and omits auto_compact_token_limit unless the skeleton already has it", () => {
    const without = ollamaChildCatalogFields({
      evidence: { tools: true, thinking: true, vision: false },
      skeleton: {},
      contextWindow: 256000,
      maxContextWindow: 1048576,
      autoCompactTokenLimit: 230400,
    });
    assert.equal(without.context_window, 256000);
    assert.equal(without.max_context_window, 1048576);
    assert.equal("auto_compact_token_limit" in without, false);
    assert.equal(nativeRowAdvertisesAutoCompactTokenLimit({}), false);
    assert.equal(nativeRowAdvertisesAutoCompactTokenLimit({ auto_compact_token_limit: 180000 }), true);
    const withField = ollamaChildCatalogFields({
      evidence: { tools: true, thinking: true, vision: false },
      skeleton: { auto_compact_token_limit: 180000 },
      contextWindow: 256000,
      autoCompactTokenLimit: 230400,
    });
    assert.equal(withField.auto_compact_token_limit, 230400);
  });
});
