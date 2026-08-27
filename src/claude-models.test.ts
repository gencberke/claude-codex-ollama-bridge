import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLAUDE_DESKTOP_NATIVE_MODELS, buildClaudeModelsResponse } from "./claude-models.js";

describe("cob claude models catalog", () => {
  it("lists real Claude ids and Ollama tags without remapping Claude onto Ollama", () => {
    const listed = buildClaudeModelsResponse([
      { name: "deepseek-v4-flash:0731-cloud", capabilities: ["completion", "tools", "thinking"] },
    ]);
    const opus = listed.data.find((entry) => entry.id === "claude-opus-5");
    const child = listed.data.find((entry) => entry.id === "deepseek-v4-flash:0731-cloud");
    assert.equal(opus?.capabilities.thinking.supported, true);
    assert.equal(opus?.capabilities.effort.supported, true);
    assert.equal(child?.capabilities.thinking.supported, true);
    assert.equal(child?.capabilities.effort.medium.supported, false);
    assert.equal(child?.capabilities.effort.high.supported, true);
    assert.equal("anthropic_family_tier" in (child ?? {}), false);
    assert.equal(
      CLAUDE_DESKTOP_NATIVE_MODELS.some((entry) => entry.id === "deepseek-v4-flash:0731-cloud"),
      false,
    );
    assert.equal(
      listed.data.some((entry) => entry.id === "claude-opus-4-6" || entry.id === "claude-sonnet-4-6"),
      false,
    );
    assert.equal(
      listed.data.some((entry) => entry.id.startsWith("claude") && entry.display_name.includes("DeepSeek")),
      false,
    );
  });

  it("does not guess an effort ladder for non-thinking Ollama tags", () => {
    const listed = buildClaudeModelsResponse([{ name: "kimi-k3:cloud", capabilities: ["completion"] }]);
    const kimi = listed.data.find((entry) => entry.id === "kimi-k3:cloud");
    assert.equal(kimi?.capabilities.thinking.supported, false);
    assert.equal(kimi?.capabilities.effort.supported, false);
    assert.equal(kimi?.max_tokens, null);
  });
});
