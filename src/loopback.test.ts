import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertLoopbackHttpUrl, parseLoopbackHttpUrl } from "./core/loopback.js";
import { parseLoopbackBaseUrl } from "./codex/root-config.js";

describe("loopback url normalization", () => {
  it("accepts 127.0.0.1, localhost in any case, and bracketed [::1]", () => {
    const plain = parseLoopbackHttpUrl("http://127.0.0.1:18790/v1", "url");
    assert.equal(plain.ok, true);
    if (plain.ok) {
      assert.equal(plain.port, 18790);
      assert.equal(plain.host, "127.0.0.1");
    }
    const local = parseLoopbackHttpUrl("http://LocalHost:18790", "url");
    assert.equal(local.ok, true);
    if (local.ok) assert.equal(local.port, 18790);
    const six = parseLoopbackHttpUrl("http://[::1]:18791/v1", "url");
    assert.equal(six.ok, true);
    if (six.ok) {
      assert.equal(six.host, "[::1]");
      assert.equal(six.port, 18791);
    }
  });

  it("rejects credentials without echoing the password", () => {
    const secret = "hunter2supersecret";
    const url = `http://user:${secret}@127.0.0.1:18790/v1`;
    const parsed = parseLoopbackHttpUrl(url, "Ollama URL");
    assert.equal(parsed.ok, false);
    const message = parsed.ok ? "" : parsed.reason;
    assert.match(message, /credentials/);
    assert.ok(!message.includes(secret), "failure reason must not leak the password");
    assert.ok(!message.includes(url), "failure reason must not echo the raw URL");
    assert.throws(() => assertLoopbackHttpUrl(url, "Ollama URL"), /credentials/);
  });

  it("rejects empty-style and non-loopback hosts", () => {
    assert.equal(parseLoopbackHttpUrl("http://chatgpt.com/v1", "url").ok, false);
    assert.equal(parseLoopbackHttpUrl("http://[::2]:1", "url").ok, false);
    assert.equal(parseLoopbackHttpUrl("ftp://127.0.0.1", "url").ok, false);
  });

  it("does not echo the raw URL when it is unparseable", () => {
    const withSecret = "not|a|url:18790";
    const parsed = parseLoopbackHttpUrl(withSecret, "Ollama URL");
    assert.equal(parsed.ok, false);
    const message = parsed.ok ? "" : parsed.reason;
    assert.ok(!message.includes(withSecret), "failure reason must not echo the raw URL");
  });

  it("rejects credentialled openai_base_url through the root helper", () => {
    const parsed = parseLoopbackBaseUrl("http://user:pw@127.0.0.1:18790/v1");
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.match(parsed.reason, /credentials/);
  });

  it("delegates root port parsing to the shared helper", () => {
    const parsed = parseLoopbackBaseUrl("http://[::1]:9999/v1");
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.port, 9999);
  });
});