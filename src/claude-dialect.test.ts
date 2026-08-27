import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLAUDE_DIALECT,
  estimateOllamaCountTokens,
  isAnthropicClaudeModel,
  routeClaudeRequestModel,
  stripOllamaPrefix,
} from "./claude/dialect.js";

describe("cob claude dialect", () => {
  it("keeps native Claude ids on Anthropic and never rewrites them", () => {
    assert.equal(CLAUDE_DIALECT.capabilities.nativeAlias, "unsupported");
    assert.equal(CLAUDE_DIALECT.capabilities.cobRoute, "system-marker");
    assert.equal(CLAUDE_DIALECT.capabilities.claudeDesktopThirdParty, "overlay-opt-in");
    assert.equal(CLAUDE_DIALECT.capabilities.userClaudeHomeWrites, "agents-overlay-opt-in");
    assert.equal(CLAUDE_DIALECT.capabilities.settingsJsonWrites, "unsupported");
    assert.deepEqual(routeClaudeRequestModel("opus"), { backend: "anthropic", upstreamModel: "opus" });
    assert.deepEqual(routeClaudeRequestModel("claude-sonnet-5"), {
      backend: "anthropic",
      upstreamModel: "claude-sonnet-5",
    });
    assert.equal(isAnthropicClaudeModel("deepseek-v4-flash:0731-cloud"), false);
  });

  it("routes Ollama tags and ollama/ prefixes to Ollama without stealing Claude ids", () => {
    assert.deepEqual(routeClaudeRequestModel("deepseek-v4-flash:0731-cloud"), {
      backend: "ollama",
      upstreamModel: "deepseek-v4-flash:0731-cloud",
    });
    assert.deepEqual(routeClaudeRequestModel("ollama/kimi-k3:cloud"), {
      backend: "ollama",
      upstreamModel: "kimi-k3:cloud",
    });
    assert.equal(stripOllamaPrefix("opus"), "opus");
  });

  it("estimates Ollama count_tokens locally and never returns zero", () => {
    const counted = estimateOllamaCountTokens({ model: "deepseek-v4-flash:0731-cloud", messages: [] });
    assert.equal(counted.input_tokens >= 1, true);
    assert.equal(estimateOllamaCountTokens({}).input_tokens, 1);
  });
});
