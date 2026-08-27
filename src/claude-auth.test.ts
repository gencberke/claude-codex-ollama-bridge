import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  authorizationFromToken,
  isPlaceholderGatewayCredential,
  parseClaudeCodeCredentialBlob,
  readClaudeCodeAuth,
  resolveAnthropicUpstreamHeaders,
} from "./claude-auth.js";

describe("cob claude anthropic auth", () => {
  it("forwards real OAuth and replaces the cob Desktop placeholder", () => {
    assert.equal(isPlaceholderGatewayCredential("cob"), true);
    assert.equal(isPlaceholderGatewayCredential("ollama"), true);
    assert.equal(isPlaceholderGatewayCredential("sk-ant-live"), false);

    const forwarded = resolveAnthropicUpstreamHeaders(
      { authorization: "Bearer oauth-token", "anthropic-version": "2023-06-01" },
      () => {
        throw new Error("reader must not run for real credentials");
      },
    );
    assert.equal(forwarded.authorization, "Bearer oauth-token");

    const injected = resolveAnthropicUpstreamHeaders({ authorization: "Bearer cob" }, () => ({
      authorization: "Bearer injected-oauth",
      "anthropic-beta": "oauth-2025-04-20",
    }));
    assert.equal(injected.authorization, "Bearer injected-oauth");
    assert.equal(injected["anthropic-beta"], "oauth-2025-04-20");
  });

  it("prefers Claude Code keychain over an inherited ANTHROPIC_API_KEY", () => {
    const auth = readClaudeCodeAuth({ ANTHROPIC_API_KEY: "sk-ant-env" }, () => ({
      authorization: "Bearer oauth-from-keychain",
    }));
    assert.equal(auth?.authorization, "Bearer oauth-from-keychain");
    assert.equal(auth?.["x-api-key"], undefined);
  });

  it("sends Claude Code oat tokens as Bearer OAuth, not x-api-key", () => {
    const oat = authorizationFromToken("sk-ant-oat01-example");
    assert.equal(oat.authorization, "Bearer sk-ant-oat01-example");
    assert.equal(oat["x-api-key"], undefined);
    const api = authorizationFromToken("sk-ant-api03-example");
    assert.equal(api["x-api-key"], "sk-ant-api03-example");
    assert.equal(api.authorization, undefined);
  });

  it("parses Claude Code keychain JSON without exposing the token in thrown errors", () => {
    const auth = parseClaudeCodeCredentialBlob(
      JSON.stringify({ claudeAiOauth: { accessToken: "oauth-from-keychain" } }),
    );
    assert.equal(auth?.authorization, "Bearer oauth-from-keychain");
    try {
      resolveAnthropicUpstreamHeaders({ authorization: "Bearer cob" }, () => undefined);
      assert.fail("expected auth error");
    } catch (error) {
      assert.equal(error instanceof Error, true);
      assert.equal((error as Error).message.includes("oauth-from-keychain"), false);
      assert.match((error as Error).message, /placeholder/);
    }
  });
});
