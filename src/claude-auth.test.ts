import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  authorizationFromToken,
  isDesktopGatewayCredential,
  parseClaudeCodeCredentialBlob,
  readClaudeCodeAuth,
  resolveAnthropicUpstreamHeaders,
  type ClaudeUpstreamAuth,
} from "./claude/auth.js";

const DESKTOP_TOKEN = "a".repeat(64);

function readerSpy(calls: { count: number }, result?: ClaudeUpstreamAuth) {
  return (): ClaudeUpstreamAuth | undefined => {
    calls.count += 1;
    return result ?? { authorization: "Bearer injected-oauth", "anthropic-beta": "oauth-2025-04-20" };
  };
}

describe("cob claude anthropic auth", () => {
  it("rejects missing auth without calling the credential reader", () => {
    const calls = { count: 0 };
    assert.throws(
      () =>
        resolveAnthropicUpstreamHeaders(
          { "content-type": "application/json" },
          { desktopToken: DESKTOP_TOKEN, reader: readerSpy(calls) },
        ),
      (error: unknown) => error instanceof Error,
    );
    assert.equal(calls.count, 0);
    assert.throws(
      () =>
        resolveAnthropicUpstreamHeaders(
          { authorization: "Bearer " },
          { desktopToken: DESKTOP_TOKEN, reader: readerSpy(calls) },
        ),
      (error: unknown) => error instanceof Error,
    );
    assert.equal(calls.count, 0);
  });

  it("rejects legacy cob and ollama placeholders without calling the reader", () => {
    const calls = { count: 0 };
    for (const credential of ["cob", "ollama", "COB"]) {
      assert.throws(
        () =>
          resolveAnthropicUpstreamHeaders(
            { authorization: `Bearer ${credential}` },
            { desktopToken: DESKTOP_TOKEN, reader: readerSpy(calls) },
          ),
        (error: unknown) => error instanceof Error,
      );
    }
    assert.equal(calls.count, 0);
  });

  it("rejects a stale desktop-shaped token without calling the reader", () => {
    const calls = { count: 0 };
    assert.throws(
      () =>
        resolveAnthropicUpstreamHeaders(
          { authorization: `Bearer ${"f".repeat(64)}` },
          { desktopToken: DESKTOP_TOKEN, reader: readerSpy(calls) },
        ),
      (error: unknown) => error instanceof Error,
    );
    assert.equal(calls.count, 0);
  });

  it("injects Claude Code credentials only for the exact desktop token", () => {
    const calls = { count: 0 };
    const injected = resolveAnthropicUpstreamHeaders(
      { authorization: `Bearer ${DESKTOP_TOKEN}` },
      { desktopToken: DESKTOP_TOKEN, reader: readerSpy(calls) },
    );
    assert.equal(calls.count, 1);
    assert.equal(injected.authorization, "Bearer injected-oauth");
    assert.equal(injected["anthropic-beta"], "oauth-2025-04-20");
    assert.equal(injected["x-api-key"], undefined);
  });

  it("passes real Claude OAuth through byte-faithfully and never runs the reader", () => {
    const calls = { count: 0 };
    const incoming = {
      authorization: "Bearer sk-ant-oat01-example",
      "anthropic-version": "2023-06-01",
      "x-api-key": "",
    };
    const forwarded = resolveAnthropicUpstreamHeaders(incoming, {
      desktopToken: DESKTOP_TOKEN,
      reader: readerSpy(calls),
    });
    assert.equal(calls.count, 0);
    assert.equal(forwarded.authorization, "Bearer sk-ant-oat01-example");
    assert.equal(forwarded["anthropic-version"], "2023-06-01");
  });

  it("compares desktop tokens with a timing-safe match", () => {
    assert.equal(isDesktopGatewayCredential(DESKTOP_TOKEN, DESKTOP_TOKEN), true);
    assert.equal(isDesktopGatewayCredential(`${DESKTOP_TOKEN}0`, DESKTOP_TOKEN), false);
    assert.equal(isDesktopGatewayCredential("", DESKTOP_TOKEN), false);
    assert.equal(isDesktopGatewayCredential(DESKTOP_TOKEN, undefined), false);
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
      resolveAnthropicUpstreamHeaders(
        { authorization: `Bearer ${"b".repeat(64)}` },
        { desktopToken: DESKTOP_TOKEN, reader: () => undefined },
      );
      assert.fail("expected auth error");
    } catch (error) {
      assert.equal(error instanceof Error, true);
      assert.equal((error as Error).message.includes("oauth-from-keychain"), false);
    }
  });
});
