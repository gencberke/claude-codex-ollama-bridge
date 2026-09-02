import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isOllamaReject, normalizeOllamaResponse, prepareOllamaWire, sanitizeOllamaPayload } from "./codex/ollama.js";
import {
  applyDeferredToolsToOllama,
  rewriteToolSearchFromOllama,
  rewriteToolSearchToOllama,
  TOOL_SEARCH_NAME,
} from "./codex/tool-search.js";
import { guardOllamaJsonResponse, collectOllamaWireToolNames } from "./codex/ollama-response-boundary.js";
import { OllamaJsonOverflowError } from "./codex/bounded-json.js";
import { sha256Hex8 } from "./codex/request-metrics.js";
import type { JsonObject } from "./core/json.js";

const SEARCH_TOOL = {
  type: "tool_search",
  execution: "client",
  description: "Search deferred tools.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

function spawnNamespace(extra: JsonObject = {}): JsonObject {
  return {
    type: "namespace",
    name: "multi_agent_v1",
    description: "Tools for spawning and managing sub-agents.",
    tools: [
      {
        type: "function",
        name: "spawn_agent",
        description: "Spawn a sub-agent.",
        parameters: {
          type: "object",
          properties: {
            task: { type: "string" },
            model: { type: "string" },
          },
          required: ["task"],
        },
        ...extra,
      },
    ],
  };
}

function githubNamespace(): JsonObject {
  return {
    type: "namespace",
    name: "mcp__codex_apps__github",
    description: "Access repositories, issues, and pull requests.",
    tools: [
      {
        type: "function",
        name: "_search_issues",
        description: "Search issues.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ],
  };
}

function completedSearch(callId: string): JsonObject {
  return {
    type: "tool_search_call",
    call_id: callId,
    execution: "client",
    arguments: { query: "spawn agent" },
  };
}

describe("tool_search wire shim", () => {
  it("turns Codex tool_search tool defs and history into Ollama function calls", () => {
    const payload = rewriteToolSearchToOllama({
      tools: [
        SEARCH_TOOL,
        { type: "function", name: "exec_command", parameters: { type: "object" } },
      ],
      input: [
        {
          type: "tool_search_call",
          call_id: "search-1",
          execution: "client",
          arguments: { query: "spawn agent", limit: 5 },
        },
        {
          type: "tool_search_output",
          call_id: "search-1",
          status: "completed",
          execution: "client",
          tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object" } }],
        },
      ],
    });
    const tools = payload.tools as JsonObject[];
    assert.equal(tools[0]?.name, "tool_search");
    assert.equal(tools[1]?.name, "exec_command");
    assert.equal(tools[2]?.name, "spawn_agent");
    assert.deepEqual(payload.input, [
      {
        type: "function_call",
        name: "tool_search",
        call_id: "search-1",
        arguments: JSON.stringify({ query: "spawn agent", limit: 5 }),
      },
      {
        type: "function_call_output",
        call_id: "search-1",
        output: JSON.stringify({ tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object" } }] }),
      },
    ]);
  });

  it("turns Ollama tool_search function_call into Codex tool_search_call with execution=client", () => {
    const rewritten = rewriteToolSearchFromOllama({
      object: "response",
      output: [
        {
          type: "function_call",
          name: "tool_search",
          call_id: "search-1",
          arguments: "{\"query\":\"spawn agent\",\"limit\":10}",
        },
        {
          type: "function_call",
          name: "exec_command",
          call_id: "cmd-1",
          arguments: "{\"cmd\":\"ls\"}",
        },
      ],
    });
    assert.deepEqual(rewritten, {
      object: "response",
      output: [
        {
          type: "tool_search_call",
          execution: "client",
          call_id: "search-1",
          arguments: { query: "spawn agent", limit: 10 },
        },
        {
          type: "function_call",
          name: "exec_command",
          call_id: "cmd-1",
          arguments: "{\"cmd\":\"ls\"}",
        },
      ],
    });
  });

  it("rewrites nested SSE output items without touching other function arguments", () => {
    const event = normalizeOllamaResponse(
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          name: "tool_search",
          call_id: "search-2",
          arguments: "{\"query\":\"github\"}",
        },
      },
      "ollama/deepseek-v4-flash:0731-cloud",
    );
    assert.deepEqual(event, {
      type: "response.output_item.done",
      item: {
        type: "tool_search_call",
        execution: "client",
        call_id: "search-2",
        arguments: { query: "github" },
      },
    });
  });

  it("runs on the Ollama sanitize path before the request is forwarded", () => {
    const sanitized = sanitizeOllamaPayload({
      model: "ollama/deepseek-v4-flash:0731-cloud",
      tools: [{ type: "tool_search", description: "Find tools." }],
      input: [
        {
          type: "tool_search_call",
          call_id: "search-1",
          execution: "client",
          arguments: { query: "js" },
        },
      ],
    });
    assert.equal(sanitized.model, "deepseek-v4-flash:0731-cloud");
    assert.deepEqual(sanitized.tools, [
      {
        type: "function",
        name: "tool_search",
        description: "Find tools.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query for deferred tools." },
            limit: { type: "number", description: "Maximum number of tools to return." },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    ]);
    const input = sanitized.input as { type: string; arguments: string }[];
    assert.equal(input[0]?.type, "function_call");
    assert.equal(input[0]?.arguments, "{\"query\":\"js\"}");
  });
});

describe("deferred tool promotion", () => {
  it("flattens the reserved functions namespace and restores its exact identity", () => {
    const payload: JsonObject = {
      model: "ollama/deepseek-v4-flash:0731-cloud",
      tools: [
        {
          type: "namespace",
          name: "functions",
          tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
        },
      ],
      input: [
        {
          type: "function_call",
          name: "exec_command",
          namespace: "functions",
          call_id: "history-1",
          arguments: "{}",
        },
      ],
    };
    const prepared = prepareOllamaWire(payload);
    assert.equal(isOllamaReject(prepared), false);
    if (isOllamaReject(prepared)) return;
    assert.deepEqual(prepared.payload.tools, [
      { type: "function", name: "exec_command", parameters: { type: "object" } },
    ]);
    assert.deepEqual(prepared.payload.input, [
      { type: "function_call", name: "exec_command", call_id: "history-1", arguments: "{}" },
    ]);
    assert.equal(prepared.bridge.aliases.get("exec_command")?.namespace, "functions");
    assert.equal(prepared.declaration.names.has("exec_command"), true);
    const response = {
      output: [{ type: "function_call", name: "exec_command", call_id: "call-1", arguments: "{}" }],
    };
    assert.equal(guardOllamaJsonResponse(response, prepared.declaration), undefined);
    assert.deepEqual(
      (normalizeOllamaResponse(response, "ollama/deepseek-v4-flash:0731-cloud", prepared.bridge) as JsonObject).output,
      [{ type: "function_call", name: "exec_command", namespace: "functions", call_id: "call-1", arguments: "{}" }],
    );
  });

  it("restores Ollama dot-qualified calls from direct namespace tools", () => {
    const payload: JsonObject = {
      tools: [githubNamespace(), spawnNamespace()],
      input: [
        {
          type: "function_call",
          name: "_search_issues",
          namespace: "mcp__codex_apps__github",
          call_id: "gh-history",
          arguments: JSON.stringify({ query: "repo:openai/codex" }),
        },
      ],
    };
    const bridge = applyDeferredToolsToOllama(payload);
    assert.deepEqual(payload.tools, [githubNamespace(), spawnNamespace()]);
    assert.equal((payload.input as JsonObject[])[0]?.name, "mcp__codex_apps__github._search_issues");
    assert.equal("namespace" in ((payload.input as JsonObject[])[0] ?? {}), false);
    assert.equal(bridge.aliasesAdded, 0);
    assert.equal(bridge.aliasSha, "-");
    assert.equal(bridge.usedAliasMissing, 0);

    const rewritten = rewriteToolSearchFromOllama(
      {
        output: [
          {
            type: "function_call",
            name: "mcp__codex_apps__github._search_issues",
            call_id: "gh-1",
            arguments: JSON.stringify({ query: "repo:openai/codex" }),
          },
          {
            type: "function_call",
            name: "multi_agent_v1.spawn_agent",
            call_id: "spawn-1",
            arguments: JSON.stringify({ task: "reply ok" }),
          },
        ],
      },
      bridge,
    );
    assert.deepEqual((rewritten as JsonObject).output, [
      {
        type: "function_call",
        name: "_search_issues",
        namespace: "mcp__codex_apps__github",
        call_id: "gh-1",
        arguments: JSON.stringify({ query: "repo:openai/codex" }),
      },
      {
        type: "function_call",
        name: "spawn_agent",
        namespace: "multi_agent_v1",
        call_id: "spawn-1",
        arguments: JSON.stringify({ task: "reply ok" }),
      },
    ]);
  });

  it("removes an ambiguous reserved alias from the final catalog", () => {
    const prepared = prepareOllamaWire({
      model: "ollama/deepseek-v4-flash:0731-cloud",
      tools: [
        { type: "function", name: "exec_command", parameters: { type: "object" } },
        {
          type: "namespace",
          name: "functions",
          tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
        },
      ],
      input: [],
    });
    assert.equal(isOllamaReject(prepared), false);
    if (isOllamaReject(prepared)) return;
    assert.equal(prepared.bridge.collisions, 1);
    assert.equal((prepared.payload.tools as JsonObject[]).some((tool) => tool.name === "exec_command"), false);
    assert.equal(
      guardOllamaJsonResponse(
        { output: [{ type: "function_call", name: "exec_command", call_id: "call-1", arguments: "{}" }] },
        prepared.declaration,
      )?.code,
      "ollama_undeclared_tool_call",
    );
  });

  it("keeps an undeclared near-miss rejected after reserved flattening", () => {
    const prepared = prepareOllamaWire({
      model: "ollama/deepseek-v4-flash:0731-cloud",
      tools: [{
        type: "namespace",
        name: "functions",
        tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
      }],
      input: [],
    });
    assert.equal(isOllamaReject(prepared), false);
    if (isOllamaReject(prepared)) return;
    assert.equal(
      guardOllamaJsonResponse(
        { output: [{ type: "function_call", name: "exec_comman", call_id: "call-1", arguments: "{}" }] },
        prepared.declaration,
      )?.code,
      "ollama_undeclared_tool_call",
    );
  });

  it("matches Ollama's recursive namespace prefixing when a leaf is already qualified", () => {
    const payload: JsonObject = {
      tools: [
        {
          type: "namespace",
          name: "outer",
          tools: [
            {
              type: "namespace",
              name: "inner",
              tools: [
                {
                  type: "function",
                  name: "inner.leaf",
                  parameters: { type: "object", properties: {} },
                },
              ],
            },
          ],
        },
      ],
      input: [],
    };
    const bridge = applyDeferredToolsToOllama(payload);
    const rewritten = rewriteToolSearchFromOllama(
      {
        output: [
          {
            type: "function_call",
            name: "outer.inner.leaf",
            call_id: "nested-1",
            arguments: "{}",
          },
        ],
      },
      bridge,
    );
    assert.deepEqual((rewritten as JsonObject).output, [
      {
        type: "function_call",
        name: "inner.leaf",
        namespace: "outer.inner",
        call_id: "nested-1",
        arguments: "{}",
      },
    ]);
  });

  it("promotes live-shaped spawn_agent as a namespace-aware alias and keeps the search output", () => {
    const payload: JsonObject = {
      tools: [SEARCH_TOOL, { type: "function", name: "exec_command", parameters: { type: "object" } }],
      input: [
        completedSearch("search-1"),
        {
          type: "tool_search_output",
          call_id: "search-1",
          status: "completed",
          execution: "client",
          tools: [spawnNamespace({ defer_loading: true })],
        },
      ],
    };
    const bridge = applyDeferredToolsToOllama(payload);
    const tools = payload.tools as JsonObject[];
    assert.equal(tools.some((tool) => tool.name === "multi_agent_v1__spawn_agent"), true);
    assert.equal(tools.some((tool) => tool.type === "namespace"), false);
    assert.equal(tools.some((tool) => tool.name === "spawn_agent"), false);
    const promoted = tools.find((tool) => tool.name === "multi_agent_v1__spawn_agent");
    assert.match(String(promoted?.description), /multi_agent_v1\.spawn_agent/);
    assert.equal("defer_loading" in (promoted ?? {}), false);
    assert.equal(bridge.promotedN, 1);
    assert.equal(bridge.aliases.get("multi_agent_v1__spawn_agent")?.namespace, "multi_agent_v1");
    const output = (payload.input as JsonObject[]).find((item) => item.type === "function_call_output");
    assert.match(String(output?.output), /spawn_agent/);
  });

  it("promotes GitHub _search_issues with the mcp namespace alias", () => {
    const payload: JsonObject = {
      tools: [SEARCH_TOOL],
      input: [
        {
          type: "tool_search_call",
          call_id: "search-gh",
          execution: "client",
          arguments: { query: "issues" },
        },
        {
          type: "tool_search_output",
          call_id: "search-gh",
          status: "completed",
          execution: "client",
          tools: [githubNamespace()],
        },
      ],
    };
    applyDeferredToolsToOllama(payload);
    const tools = payload.tools as JsonObject[];
    assert.equal(tools.some((tool) => tool.name === "mcp__codex_apps__github___search_issues"), true);
    assert.equal(tools.some((tool) => tool.name === "_search_issues"), false);
  });

  it("restores inbound aliases to separate name and namespace", () => {
    const payload: JsonObject = {
      tools: [SEARCH_TOOL],
      input: [
        completedSearch("search-1"),
        {
          type: "tool_search_output",
          call_id: "search-1",
          status: "completed",
          execution: "client",
          tools: [spawnNamespace(), githubNamespace()],
        },
      ],
    };
    const bridge = applyDeferredToolsToOllama(payload);
    const rewritten = rewriteToolSearchFromOllama(
      {
        output: [
          {
            type: "function_call",
            name: "multi_agent_v1__spawn_agent",
            call_id: "spawn-1",
            arguments: JSON.stringify({ task: "read README", model: "ollama/deepseek-v4-flash:0731-cloud" }),
          },
          {
            type: "function_call",
            name: "mcp__codex_apps__github___search_issues",
            call_id: "gh-1",
            arguments: JSON.stringify({ query: "repo:lidge-jun/opencodex" }),
          },
        ],
      },
      bridge,
    );
    assert.deepEqual((rewritten as JsonObject).output, [
      {
        type: "function_call",
        name: "spawn_agent",
        namespace: "multi_agent_v1",
        call_id: "spawn-1",
        arguments: JSON.stringify({ task: "read README", model: "ollama/deepseek-v4-flash:0731-cloud" }),
      },
      {
        type: "function_call",
        name: "_search_issues",
        namespace: "mcp__codex_apps__github",
        call_id: "gh-1",
        arguments: JSON.stringify({ query: "repo:lidge-jun/opencodex" }),
      },
    ]);
  });

  it("flattens replayed namespaced function_call history with the same alias", () => {
    const payload: JsonObject = {
      tools: [SEARCH_TOOL],
      input: [
        completedSearch("search-1"),
        {
          type: "tool_search_output",
          call_id: "search-1",
          status: "completed",
          execution: "client",
          tools: [spawnNamespace()],
        },
        {
          type: "function_call",
          name: "spawn_agent",
          namespace: "multi_agent_v1",
          call_id: "spawn-1",
          arguments: JSON.stringify({ task: "summarize README" }),
        },
      ],
    };
    applyDeferredToolsToOllama(payload);
    const replay = (payload.input as JsonObject[]).find((item) => item.call_id === "spawn-1");
    assert.equal(replay?.name, "multi_agent_v1__spawn_agent");
    assert.equal("namespace" in (replay ?? {}), false);
  });

  it("does not convert a namespaced leaf named tool_search into tool_search_call", () => {
    const rewritten = rewriteToolSearchFromOllama({
      output: [
        {
          type: "function_call",
          name: "tool_search",
          namespace: "mcp__codex_apps__plugin_management",
          call_id: "leaf-1",
          arguments: "{}",
        },
      ],
    });
    assert.deepEqual((rewritten as JsonObject).output, [
      {
        type: "function_call",
        name: "tool_search",
        namespace: "mcp__codex_apps__plugin_management",
        call_id: "leaf-1",
        arguments: "{}",
      },
    ]);
  });

  it("does not rewrite tool_search JSON buried in another function_call's arguments", () => {
    const rewritten = rewriteToolSearchFromOllama({
      output: [
        {
          type: "function_call",
          name: "exec_command",
          call_id: "cmd-1",
          arguments: JSON.stringify({
            cmd: "echo",
            nested: { type: "function_call", name: "tool_search", arguments: { query: "nope" } },
          }),
        },
      ],
    });
    const item = ((rewritten as JsonObject).output as JsonObject[])[0];
    assert.equal(item?.type, "function_call");
    assert.equal(item?.name, "exec_command");
    assert.match(String(item?.arguments), /tool_search/);
  });

  it("keeps the newest schema under count and byte caps", () => {
    const oldSpawn = spawnNamespace();
    (oldSpawn.tools as JsonObject[])[0]!.description = "old spawn";
    const newSpawn = spawnNamespace();
    (newSpawn.tools as JsonObject[])[0]!.description = "new spawn";
    const extra: JsonObject = {
      type: "namespace",
      name: "codex_app",
      tools: [
        {
          type: "function",
          name: "create_thread",
          description: "Create a thread.",
          parameters: { type: "object", properties: {} },
        },
      ],
    };
    const payload: JsonObject = {
      tools: [SEARCH_TOOL],
      input: [
        { type: "tool_search_call", call_id: "old", execution: "client", arguments: { query: "old" } },
        { type: "tool_search_output", call_id: "old", status: "completed", execution: "client", tools: [oldSpawn] },
        { type: "tool_search_call", call_id: "new", execution: "client", arguments: { query: "new" } },
        {
          type: "tool_search_output",
          call_id: "new",
          status: "completed",
          execution: "client",
          tools: [newSpawn, extra],
        },
      ],
    };
    const bridge = applyDeferredToolsToOllama(payload, { leafCap: 1 });
    const tools = payload.tools as JsonObject[];
    const promoted = tools.find((tool) => tool.name === "multi_agent_v1__spawn_agent");
    assert.match(String(promoted?.description), /new spawn/);
    assert.equal(tools.some((tool) => tool.name === "codex_app__create_thread"), false);
    assert.equal(bridge.promotedN, 1);
    assert.equal(bridge.skippedCap >= 1, true);
    assert.equal(bridge.aliasesAdded, 1);
    assert.equal(bridge.aliasSha, sha256Hex8(["multi_agent_v1__spawn_agent"]));
    assert.equal(bridge.aliasSha.includes("spawn"), false);
    assert.equal(bridge.usedAliasMissing, 0);
  });

  it("hashes only appended aliases in deterministic newest-first wire order", () => {
    const payload: JsonObject = {
      tools: [
        SEARCH_TOOL,
        { type: "function", name: "exec_command", parameters: { type: "object" } },
      ],
      input: [
        { type: "tool_search_call", call_id: "old", execution: "client", arguments: { query: "issues" } },
        {
          type: "tool_search_output",
          call_id: "old",
          status: "completed",
          execution: "client",
          tools: [githubNamespace()],
        },
        { type: "tool_search_call", call_id: "new", execution: "client", arguments: { query: "spawn" } },
        {
          type: "tool_search_output",
          call_id: "new",
          status: "completed",
          execution: "client",
          tools: [spawnNamespace()],
        },
      ],
    };
    const bridge = applyDeferredToolsToOllama(payload);
    const appendedAliases = [
      "multi_agent_v1__spawn_agent",
      "mcp__codex_apps__github___search_issues",
    ];
    assert.deepEqual(
      (payload.tools as JsonObject[]).slice(2).map((tool) => tool.name),
      appendedAliases,
    );
    assert.equal(bridge.aliasSha, sha256Hex8(appendedAliases));
    assert.notEqual(bridge.aliasSha, sha256Hex8([...appendedAliases].sort()));
    assert.notEqual(bridge.aliasSha, sha256Hex8(["exec_command", ...appendedAliases]));
    assert.equal(bridge.aliasesAdded, 2);
    assert.equal(bridge.aliasesRemoved, 0);
    assert.equal(bridge.aliasesReplaced, 0);
  });

  it("keeps turn-local replacement zero when discovered NEW collides and existing OLD remains", () => {
    const payload: JsonObject = {
      tools: [
        SEARCH_TOOL,
        {
          type: "function",
          name: "spawn_agent",
          description: "OLD",
          parameters: { type: "object", properties: { old: { type: "string" } } },
        },
      ],
      input: [
        completedSearch("search-1"),
        {
          type: "tool_search_output",
          call_id: "search-1",
          status: "completed",
          execution: "client",
          tools: [
            {
              type: "function",
              name: "spawn_agent",
              description: "NEW",
              parameters: { type: "object", properties: { fresh: { type: "boolean" } } },
            },
          ],
        },
      ],
    };
    const bridge = applyDeferredToolsToOllama(payload);
    const matching = (payload.tools as JsonObject[]).filter((tool) => tool.name === "spawn_agent");
    assert.equal(matching.length, 1);
    assert.equal(matching[0]?.description, "OLD");
    assert.equal(bridge.collisions, 1);
    assert.equal(bridge.promotedN, 0);
    assert.equal(bridge.aliasSha, "-");
    assert.equal(bridge.aliasesAdded, 0);
    assert.equal(bridge.aliasesRemoved, 0);
    assert.equal(bridge.aliasesReplaced, 0);
  });

  it("checks a cross-turn used promoted alias against final outbound tools, not the bridge map", () => {
    const priorTurnHistory: JsonObject[] = [
      completedSearch("search-1"),
      {
        type: "tool_search_output",
        call_id: "search-1",
        status: "completed",
        execution: "client",
        tools: [spawnNamespace()],
      },
      {
        type: "function_call",
        name: "spawn_agent",
        namespace: "multi_agent_v1",
        call_id: "spawn-1",
        arguments: JSON.stringify({ task: "read README" }),
      },
      { type: "function_call_output", call_id: "spawn-1", output: "done" },
    ];
    const availablePayload: JsonObject = {
      tools: [SEARCH_TOOL],
      input: structuredClone(priorTurnHistory),
    };
    const available = applyDeferredToolsToOllama(availablePayload, { leafCap: 1 });
    assert.equal(available.usedAliasMissing, 0);

    const missingPayload: JsonObject = {
      tools: [SEARCH_TOOL],
      input: structuredClone(priorTurnHistory),
    };
    const missing = applyDeferredToolsToOllama(missingPayload, { leafCap: 0 });
    assert.equal(missing.aliases.has("multi_agent_v1__spawn_agent"), true);
    assert.equal(
      (missingPayload.tools as JsonObject[]).some((tool) => tool.name === "multi_agent_v1__spawn_agent"),
      false,
    );
    assert.equal(missing.usedAliasMissing, 1);
    assert.equal(missing.aliasesAdded, 0);
    assert.equal(missing.aliasesRemoved, 0);
    assert.equal(missing.aliasesReplaced, 0);
  });

  it("skips invalid, incomplete, mismatched, duplicate, and colliding outputs", () => {
    const payload: JsonObject = {
      tools: [SEARCH_TOOL, { type: "function", name: "exec_command", parameters: { type: "object" } }],
      input: [
        { type: "tool_search_call", call_id: "ok", execution: "client", arguments: { query: "ok" } },
        {
          type: "tool_search_output",
          call_id: "ok",
          status: "in_progress",
          execution: "client",
          tools: [spawnNamespace()],
        },
        {
          type: "tool_search_output",
          call_id: "missing",
          status: "completed",
          execution: "client",
          tools: [spawnNamespace()],
        },
        {
          type: "tool_search_output",
          call_id: "ok",
          status: "completed",
          execution: "client",
          tools: [
            spawnNamespace(),
            spawnNamespace(),
            { type: "function", name: "exec_command", parameters: { type: "object" } },
            { type: "namespace", name: "empty", tools: [] },
          ],
        },
        {
          type: "function_call_output",
          call_id: "ok",
          output: "not-json",
        },
      ],
    };
    const bridge = applyDeferredToolsToOllama(payload);
    const tools = payload.tools as JsonObject[];
    assert.equal(tools.filter((tool) => tool.name === "multi_agent_v1__spawn_agent").length, 1);
    assert.equal(tools.filter((tool) => tool.name === "exec_command").length, 1);
    assert.equal(bridge.collisions >= 1, true);
    assert.equal(bridge.skippedInvalid >= 1, true);
  });

  it("restores aliases on JSON and SSE added/done/completed events", () => {
    const payload: JsonObject = {
      tools: [SEARCH_TOOL],
      input: [
        completedSearch("search-1"),
        {
          type: "tool_search_output",
          call_id: "search-1",
          status: "completed",
          execution: "client",
          tools: [spawnNamespace()],
        },
      ],
    };
    const prepared = prepareOllamaWire(payload);
    assert.equal(isOllamaReject(prepared), false);
    if (isOllamaReject(prepared)) return;
    const { payload: wire, bridge } = prepared;
    assert.equal((wire.tools as JsonObject[]).some((tool) => tool.name === "multi_agent_v1__spawn_agent"), true);
    const item = {
      type: "function_call",
      name: "multi_agent_v1__spawn_agent",
      call_id: "spawn-1",
      arguments: "{}",
    };
    for (const event of [
      { type: "response.output_item.added", item },
      { type: "response.output_item.done", item },
      { type: "response.completed", response: { output: [item] } },
    ]) {
      const rewritten = normalizeOllamaResponse(event, "ollama/deepseek-v4-flash:0731-cloud", bridge) as JsonObject;
      const found = JSON.stringify(rewritten);
      assert.match(found, /"name":"spawn_agent"/);
      assert.match(found, /"namespace":"multi_agent_v1"/);
      assert.equal(found.includes("multi_agent_v1__spawn_agent"), false);
    }
  });

  it("promotes from continuation-shaped merged input and not on the first turn", () => {
    const first: JsonObject = {
      tools: [SEARCH_TOOL],
      input: [{ type: "message", role: "user", content: "ping" }],
    };
    const firstBridge = applyDeferredToolsToOllama(first);
    assert.equal(firstBridge.promotedN, 0);
    assert.equal((first.tools as JsonObject[]).length, 1);

    const continuation: JsonObject = {
      tools: [SEARCH_TOOL],
      previous_response_id: "resp_should_not_reach_ollama",
      input: [
        { type: "message", role: "user", content: "ping" },
        completedSearch("search-1"),
        {
          type: "tool_search_output",
          call_id: "search-1",
          status: "completed",
          execution: "client",
          tools: [spawnNamespace()],
        },
      ],
    };
    const sanitized = sanitizeOllamaPayload(continuation);
    assert.equal("previous_response_id" in sanitized, false);
    assert.equal((sanitized.tools as JsonObject[]).some((tool) => tool.name === "multi_agent_v1__spawn_agent"), true);
  });

  it("does not promote when the current request has no tool_search definition", () => {
    const payload: JsonObject = {
      tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
      input: [
        completedSearch("search-1"),
        {
          type: "tool_search_output",
          call_id: "search-1",
          status: "completed",
          execution: "client",
          tools: [spawnNamespace()],
        },
      ],
    };
    const bridge = applyDeferredToolsToOllama(payload);
    assert.equal(bridge.promotedN, 0);
    assert.equal((payload.tools as JsonObject[]).some((tool) => String(tool.name).includes("spawn_agent")), false);
  });

  it("does not invent a ChatGPT request when spawn arguments name a native GPT model", () => {
    const payload: JsonObject = {
      tools: [SEARCH_TOOL],
      input: [
        completedSearch("search-1"),
        {
          type: "tool_search_output",
          call_id: "search-1",
          status: "completed",
          execution: "client",
          tools: [spawnNamespace()],
        },
      ],
    };
    const bridge = applyDeferredToolsToOllama(payload);
    const args = JSON.stringify({
      task: "pong",
      model: "gpt-5.6-sol",
    });
    const rewritten = rewriteToolSearchFromOllama(
      {
        object: "response",
        output: [
          {
            type: "function_call",
            name: "multi_agent_v1__spawn_agent",
            call_id: "spawn-gpt",
            arguments: args,
          },
        ],
      },
      bridge,
    ) as JsonObject;
    const item = (rewritten.output as JsonObject[])[0];
    assert.equal(item?.type, "function_call");
    assert.equal(item?.name, "spawn_agent");
    assert.equal(item?.namespace, "multi_agent_v1");
    assert.equal(item?.arguments, args);
    assert.equal(rewritten.object, "response");
    assert.equal("model" in rewritten, false);
  });

  it("enforces a byte budget independently of leaf count", () => {
    const fat = spawnNamespace();
    (fat.tools as JsonObject[])[0]!.description = "x".repeat(2000);
    const tiny: JsonObject = {
      type: "function",
      name: "close_agent",
      description: "ok",
      parameters: { type: "object", properties: {} },
    };
    const payload: JsonObject = {
      tools: [SEARCH_TOOL],
      input: [
        completedSearch("search-1"),
        {
          type: "tool_search_output",
          call_id: "search-1",
          status: "completed",
          execution: "client",
          tools: [fat, tiny],
        },
      ],
    };
    const bridge = applyDeferredToolsToOllama(payload, { bytesCap: 400 });
    const names = (payload.tools as JsonObject[]).map((tool) => tool.name);
    assert.equal(names.includes("close_agent"), true);
    assert.equal(names.includes("multi_agent_v1__spawn_agent"), false);
    assert.equal(bridge.promotedN, 1);
    assert.equal(bridge.skippedCap >= 1, true);
    assert.equal(bridge.promotedBytes <= 400, true);
  });

  it("does not treat a namespaced tool_search leaf as the search-tool gate", () => {
    const payload: JsonObject = {
      tools: [
        {
          type: "namespace",
          name: "mcp__other",
          tools: [{ type: "function", name: "tool_search", parameters: { type: "object", properties: {} } }],
        },
      ],
      input: [
        completedSearch("search-1"),
        {
          type: "tool_search_output",
          call_id: "search-1",
          status: "completed",
          execution: "client",
          tools: [spawnNamespace()],
        },
      ],
    };
    const bridge = applyDeferredToolsToOllama(payload);
    assert.equal(bridge.promotedN, 0);
  });

  it("does not fall back to an older schema when the newest exceeds the byte cap", () => {
    const newest = spawnNamespace();
    (newest.tools as JsonObject[])[0]!.description = "n".repeat(2000);
    const oldest = spawnNamespace();
    (oldest.tools as JsonObject[])[0]!.description = "old";
    const payload: JsonObject = {
      tools: [SEARCH_TOOL],
      input: [
        { type: "tool_search_call", call_id: "old", execution: "client", arguments: { query: "old" } },
        {
          type: "tool_search_output",
          call_id: "old",
          status: "completed",
          execution: "client",
          tools: [oldest],
        },
        { type: "tool_search_call", call_id: "new", execution: "client", arguments: { query: "new" } },
        {
          type: "tool_search_output",
          call_id: "new",
          status: "completed",
          execution: "client",
          tools: [newest],
        },
      ],
    };
    const bridge = applyDeferredToolsToOllama(payload, { bytesCap: 400 });
    assert.equal((payload.tools as JsonObject[]).some((tool) => String(tool.name).includes("spawn_agent")), false);
    assert.equal(bridge.promotedN, 0);
    assert.equal(bridge.skippedCap >= 1, true);
  });

  it("rejects custom, programmatic-only, and unnamed-namespace leaves", () => {
    const payload: JsonObject = {
      tools: [SEARCH_TOOL],
      input: [
        completedSearch("search-1"),
        {
          type: "tool_search_output",
          call_id: "search-1",
          status: "completed",
          execution: "client",
          tools: [
            { type: "custom", name: "dangerous_custom", parameters: { type: "object", properties: {} } },
            {
              type: "function",
              name: "hidden_fn",
              allowed_callers: ["programmatic"],
              parameters: { type: "object", properties: {} },
            },
            {
              type: "namespace",
              tools: [
                {
                  type: "function",
                  name: "bare_child",
                  parameters: { type: "object", properties: {} },
                },
              ],
            },
          ],
        },
      ],
    };
    const bridge = applyDeferredToolsToOllama(payload);
    const names = (payload.tools as JsonObject[]).map((tool) => tool.name);
    assert.equal(names.includes("dangerous_custom"), false);
    assert.equal(names.includes("hidden_fn"), false);
    assert.equal(names.includes("bare_child"), false);
    assert.equal(bridge.promotedN, 0);
    assert.equal(bridge.skippedUnsupported >= 1, true);
  });

  it("preserves outer segments for nested deferred namespaces in alias and restoration", () => {
    const nested: JsonObject = {
      type: "namespace",
      name: "outer",
      tools: [
        {
          type: "namespace",
          name: "inner",
          tools: [
            { type: "function", name: "leaf", parameters: { type: "object", properties: {} } },
          ],
        },
      ],
    };
    const payload: JsonObject = {
      tools: [SEARCH_TOOL],
      input: [
        completedSearch("search-1"),
        {
          type: "tool_search_output",
          call_id: "search-1",
          status: "completed",
          execution: "client",
          tools: [nested],
        },
      ],
    };
    const bridge = applyDeferredToolsToOllama(payload);
    assert.equal((payload.tools as JsonObject[]).some((tool) => tool.name === "outer__inner__leaf"), true);
    assert.deepEqual(bridge.aliases.get("outer__inner__leaf"), {
      name: "leaf",
      namespace: "outer.inner",
    });
    const restoredJson = rewriteToolSearchFromOllama(
      {
        output: [
          {
            type: "function_call",
            name: "outer__inner__leaf",
            call_id: "leaf-1",
            arguments: "{}",
          },
        ],
      },
      bridge,
    ) as JsonObject;
    assert.deepEqual(restoredJson.output, [
      {
        type: "function_call",
        name: "leaf",
        namespace: "outer.inner",
        call_id: "leaf-1",
        arguments: "{}",
      },
    ]);
    const restoredSse = normalizeOllamaResponse(
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          name: "outer__inner__leaf",
          call_id: "leaf-1",
          arguments: "{}",
        },
      },
      "ollama/deepseek-v4-flash:0731-cloud",
      bridge,
    ) as JsonObject;
    assert.deepEqual((restoredSse.item as JsonObject).name, "leaf");
    assert.deepEqual((restoredSse.item as JsonObject).namespace, "outer.inner");
  });

  it("keeps a nested deferred alias colliding with a declared tool fail-closed", () => {
    const payload: JsonObject = {
      tools: [
        SEARCH_TOOL,
        { type: "function", name: "outer__inner__leaf", parameters: { type: "object", properties: {} } },
      ],
      input: [
        completedSearch("search-1"),
        {
          type: "tool_search_output",
          call_id: "search-1",
          status: "completed",
          execution: "client",
          tools: [
            {
              type: "namespace",
              name: "outer",
              tools: [
                {
                  type: "namespace",
                  name: "inner",
                  tools: [
                    { type: "function", name: "leaf", parameters: { type: "object", properties: {} } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const bridge = applyDeferredToolsToOllama(payload);
    assert.equal(bridge.promotedN, 0);
    assert.equal(bridge.collisions, 1);
    const tools = payload.tools as JsonObject[];
    assert.equal(tools.filter((tool) => tool.name === "outer__inner__leaf").length, 1);
    assert.equal(bridge.aliases.has("outer__inner__leaf"), false);
    const restored = rewriteToolSearchFromOllama(
      {
        output: [
          {
            type: "function_call",
            name: "outer__inner__leaf",
            call_id: "leaf-1",
            arguments: "{}",
          },
        ],
      },
      bridge,
    ) as JsonObject;
    assert.deepEqual(restored.output, [
      {
        type: "function_call",
        name: "outer__inner__leaf",
        call_id: "leaf-1",
        arguments: "{}",
      },
    ]);
  });

  it("hashes unsafe or overlong aliases deterministically into 64 chars", () => {
    const payload: JsonObject = {
      tools: [SEARCH_TOOL],
      input: [
        completedSearch("search-1"),
        {
          type: "tool_search_output",
          call_id: "search-1",
          status: "completed",
          execution: "client",
          tools: [
            {
              type: "namespace",
              name: "server.name",
              tools: [
                {
                  type: "function",
                  name: "lookup",
                  parameters: { type: "object", properties: {} },
                },
              ],
            },
            {
              type: "namespace",
              name: `ns_${"a".repeat(80)}`,
              tools: [
                {
                  type: "function",
                  name: "fn",
                  parameters: { type: "object", properties: {} },
                },
              ],
            },
          ],
        },
      ],
    };
    applyDeferredToolsToOllama(payload);
    const promoted = (payload.tools as JsonObject[])
      .map((tool) => String(tool.name))
      .filter((name) => name !== "tool_search");
    assert.equal(promoted.length, 2);
    for (const name of promoted) {
      assert.match(name, /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
      assert.equal(name.length <= 64, true);
      assert.equal(name.includes("."), false);
    }
    const again: JsonObject = {
      tools: [SEARCH_TOOL],
      input: payload.input,
    };
    applyDeferredToolsToOllama(again);
    assert.deepEqual(
      (again.tools as JsonObject[]).map((tool) => tool.name).slice(1),
      promoted,
    );
  });
});

describe("bounded provider JSON traversal", () => {
  function deepNested(depth: number): unknown {
    let value: unknown = "leaf";
    for (let index = 0; index < depth; index += 1) value = [value];
    return value;
  }

  function wideNested(count: number): unknown {
    return { output: Array.from({ length: count }, (_unused, index) => ({ index })) };
  }

  it("keeps a normal 120-level fixture valid on the upstream rewrite path", () => {
    const value = deepNested(120);
    assert.deepEqual(rewriteToolSearchFromOllama(value), value);
  });

  it("fails a 200-level upstream rewrite with the stable code, never a RangeError", () => {
    assert.throws(() => rewriteToolSearchFromOllama(deepNested(200)), (error: unknown) => {
      assert.ok(error instanceof OllamaJsonOverflowError);
      const overflow = (error as OllamaJsonOverflowError).overflow;
      assert.equal(overflow.code, "ollama_json_traversal_overflow");
      assert.equal(overflow.side, "upstream");
      assert.equal(overflow.kind, "depth");
      return true;
    });
  });

  it("fails a 50,000-level upstream rewrite without stack exhaustion", () => {
    assert.throws(() => rewriteToolSearchFromOllama(deepNested(50_000)), OllamaJsonOverflowError);
  });

  it("stops a wide upstream structure at the node ceiling", () => {
    assert.throws(() => rewriteToolSearchFromOllama(wideNested(100_001)), (error: unknown) => {
      assert.ok(error instanceof OllamaJsonOverflowError);
      assert.equal((error as OllamaJsonOverflowError).overflow.kind, "nodes");
      return true;
    });
  });

  it("fails a deep encrypted-field response content-safely through the JSON normalize path", () => {
    const deep: unknown = { response: { output: deepNested(200) } };
    assert.throws(() => normalizeOllamaResponse(deep, "ollama/m"), OllamaJsonOverflowError);
  });

  it("bounds direct request-side namespace traversals with the stable overflow code", () => {
    let deep: unknown = { type: "function", name: "leaf", parameters: { type: "object" } };
    for (let index = 0; index < 200; index += 1) {
      deep = { type: "namespace", name: `ns${index}`, tools: [deep] };
    }
    const tools = [deep as JsonObject];
    assert.throws(() => rewriteToolSearchToOllama({ tools }), OllamaJsonOverflowError);
    assert.throws(() => collectOllamaWireToolNames(tools), OllamaJsonOverflowError);
  });

  it("bounds decoded function_call_output tool-search JSON before promotion", () => {
    const payload: JsonObject = {
      tools: [SEARCH_TOOL],
      input: [
        completedSearch("search-1"),
        {
          type: "function_call_output",
          call_id: "search-1",
          output: JSON.stringify({ tools: [deepNested(200)] }),
        },
      ],
    };
    assert.throws(() => rewriteToolSearchToOllama(payload), OllamaJsonOverflowError);
  });

  it("bounds a promoted parameter shape decoded from a function_call_output string", () => {
    let deepParameters: unknown = { type: "string" };
    for (let index = 0; index < 10_000; index += 1) {
      deepParameters = { type: "object", properties: { a: deepParameters } };
    }
    const payload: JsonObject = {
      tools: [SEARCH_TOOL],
      input: [
        completedSearch("search-1"),
        {
          type: "function_call_output",
          call_id: "search-1",
          output: JSON.stringify({
            tools: [{ type: "function", name: "spawn_agent", parameters: deepParameters }],
          }),
        },
      ],
    };
    assert.throws(() => rewriteToolSearchToOllama(payload), (error: unknown) => {
      assert.ok(error instanceof OllamaJsonOverflowError);
      assert.equal((error as OllamaJsonOverflowError).overflow.side, "request");
      return true;
    });
  });

  it("keeps namespace restoration and alias-collision protections green on ordinary payloads", () => {
    const payload: JsonObject = {
      tools: [
        {
          type: "namespace",
          name: "multi_agent_v1",
          tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object" } }],
        },
      ],
      input: [
        {
          type: "function_call",
          name: "multi_agent_v1.spawn_agent",
          call_id: "c1",
          arguments: "{}",
        },
      ],
    };
    const bridge = applyDeferredToolsToOllama(payload);
    assert.equal(bridge.collisions, 0);
    const response = {
      output: [
        { type: "function_call", name: "multi_agent_v1.spawn_agent", call_id: "c1", arguments: "{}" },
      ],
    };
    const restored = normalizeOllamaResponse(response, "ollama/m", bridge) as JsonObject;
    const item = (restored.output as JsonObject[])[0]!;
    assert.equal(item.namespace, "multi_agent_v1");
    assert.equal(item.name, "spawn_agent");
  });
});

describe("exact hosted-tool filter", () => {
  it("drops hosted web_search with no alias collision and preserves tool_search plus ordinary function", () => {
    const payload: JsonObject = {
      tools: [
        { type: "web_search" },
        SEARCH_TOOL,
        { type: "function", name: "exec_command", parameters: { type: "object" } },
      ],
    };
    const bridge = applyDeferredToolsToOllama(payload);
    assert.equal(bridge.hostedToolsDroppedN, 1);
    assert.equal(Array.isArray(payload.tools), true);
    const tools = payload.tools as JsonObject[];
    assert.equal(tools.length, 2);
    assert.equal(tools.some((t) => t.type === "web_search"), false);
    assert.equal(tools[0]!.type, "function");
    assert.equal(tools[0]!.name, TOOL_SEARCH_NAME);
    assert.equal(tools[1]!.type, "function");
    assert.equal(tools[1]!.name, "exec_command");
  });

  it("drops hosted web_search inside a namespace while preserving the function child and namespace structure", () => {
    const payload: JsonObject = {
      tools: [
        {
          type: "namespace",
          name: "custom_ns",
          tools: [
            { type: "web_search" },
            { type: "function", name: "custom_func", parameters: { type: "object" } },
          ],
        },
      ],
    };
    const bridge = applyDeferredToolsToOllama(payload);
    assert.equal(bridge.hostedToolsDroppedN, 1);
    assert.equal(Array.isArray(payload.tools), true);
    const tools = payload.tools as JsonObject[];
    assert.equal(tools.length, 1);
    const ns = tools[0]!;
    assert.equal(ns.type, "namespace");
    assert.equal(ns.name, "custom_ns");
    assert.equal(Array.isArray(ns.tools), true);
    const nsChildren = ns.tools as JsonObject[];
    assert.equal(nsChildren.length, 1);
    assert.equal(nsChildren[0]!.type, "function");
    assert.equal(nsChildren[0]!.name, "custom_func");
  });

  it("preserves a function tool whose name is web_search", () => {
    const payload: JsonObject = {
      tools: [
        {
          type: "function",
          name: "web_search",
          description: "custom search function",
          parameters: { type: "object" },
        },
      ],
    };
    const bridge = applyDeferredToolsToOllama(payload);
    assert.equal(bridge.hostedToolsDroppedN, 0);
    assert.equal(Array.isArray(payload.tools), true);
    const tools = payload.tools as JsonObject[];
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.type, "function");
    assert.equal(tools[0]!.name, "web_search");
    assert.equal(tools[0]!.description, "custom search function");
  });

  it("preserves namespaced function flattening and declaration integrity when hosted web_search is dropped", () => {
    const payload: JsonObject = {
      model: "ollama/deepseek-v4-flash:0731-cloud",
      tools: [
        {
          type: "namespace",
          name: "functions",
          tools: [
            { type: "web_search" },
            { type: "function", name: "my_tool", parameters: { type: "object" } },
          ],
        },
      ],
    };
    const wire = prepareOllamaWire(payload);
    assert.equal(isOllamaReject(wire), false);
    if (isOllamaReject(wire)) return;
    assert.equal(wire.bridge.hostedToolsDroppedN, 1);
    const wireTools = wire.payload.tools as JsonObject[];
    assert.equal(wireTools.length, 1);
    assert.equal(wireTools[0]!.type, "function");
    assert.equal(wireTools[0]!.name, "my_tool");
    assert.equal(wireTools[0]!.namespace, undefined);
    assert.equal(wire.declaration.count, 1);
    assert.equal(wire.declaration.names.has("my_tool"), true);
    assert.equal(wire.declaration.names.has("web_search"), false);
  });
});
