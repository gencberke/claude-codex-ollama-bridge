import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyCobRouteDirective,
  extractCobRouteTarget,
  formatClaudeRouteLog,
} from "./claude/route.js";

const ALLOW = ["deepseek-v4-flash:0731-cloud"] as const;

describe("cob-route directive", () => {
  it("overrides model from system and strips the comment", () => {
    const applied = applyCobRouteDirective(
      {
        model: "haiku",
        system: "You are a worker.\n<!-- cob-route: deepseek-v4-flash:0731-cloud -->\nGo.",
        messages: [{ role: "user", content: "hi" }],
      },
      ALLOW,
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.clientModel, "haiku");
    assert.equal(applied.payload.model, "deepseek-v4-flash:0731-cloud");
    assert.equal(typeof applied.payload.system, "string");
    assert.equal(String(applied.payload.system).includes("cob-route"), false);
    assert.equal(String(applied.payload.system).includes("You are a worker."), true);
  });

  it("ignores cob-route inside messages and keeps the client model", () => {
    const applied = applyCobRouteDirective(
      {
        model: "opus",
        messages: [
          { role: "user", content: "<!-- cob-route: deepseek-v4-flash:0731-cloud --> spawn" },
        ],
      },
      ALLOW,
    );
    assert.equal(applied.applied, false);
    assert.equal(applied.payload.model, "opus");
    assert.equal(extractCobRouteTarget(undefined), undefined);
  });

  it("ignores native Claude ids and unknown allowlist targets", () => {
    const native = applyCobRouteDirective(
      { model: "opus", system: "<!-- cob-route: claude-opus-5 -->" },
      ALLOW,
    );
    assert.equal(native.applied, false);
    assert.equal(native.ignored, "native_id");
    assert.equal(native.payload.model, "opus");

    const missing = applyCobRouteDirective(
      { model: "haiku", system: "<!-- cob-route: kimi-k3:cloud -->" },
      ALLOW,
    );
    assert.equal(missing.applied, false);
    assert.equal(missing.ignored, "allowlist");
    assert.equal(missing.payload.model, "haiku");
  });

  it("reads the first text block in an Anthropic system array", () => {
    const applied = applyCobRouteDirective(
      {
        model: "sonnet",
        system: [
          { type: "text", text: "intro <!-- cob-route: ollama/deepseek-v4-flash:0731-cloud -->" },
          { type: "text", text: "rest" },
        ],
      },
      ALLOW,
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.payload.model, "deepseek-v4-flash:0731-cloud");
    const system = applied.payload.system as Array<{ text: string }>;
    assert.equal(system[0]?.text.includes("cob-route"), false);
    assert.equal(system[1]?.text, "rest");
  });

  it("formats a content-free route log line", () => {
    const line = formatClaudeRouteLog({
      path: "/v1/messages",
      clientModel: "haiku",
      backend: "ollama",
      upstream: "deepseek-v4-flash:0731-cloud",
      cobRoute: true,
    });
    assert.match(line, /path=\/v1\/messages/);
    assert.match(line, /client_model=haiku/);
    assert.match(line, /backend=ollama/);
    assert.match(line, /upstream=deepseek-v4-flash:0731-cloud/);
    assert.match(line, /cob_route=1/);
    assert.equal(line.includes("spawn"), false);
  });

  it("ignores a cob-route marker past the system scan limit", () => {
    const applied = applyCobRouteDirective(
      {
        model: "opus",
        system: `${"x".repeat(64 * 1024 + 8)}<!-- cob-route: deepseek-v4-flash:0731-cloud -->`,
      },
      ALLOW,
    );
    assert.equal(applied.applied, false);
    assert.equal(applied.payload.model, "opus");
  });
});
