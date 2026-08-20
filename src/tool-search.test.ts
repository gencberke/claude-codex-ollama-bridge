import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeOllamaResponse, prepareOllamaWire, sanitizeOllamaPayload } from "./ollama.js";
import {
  applyDeferredToolsToOllama,
  rewriteToolSearchFromOllama,
  rewriteToolSearchToOllama,
} from "./tool-search.js";
import type { JsonObject } from "./types.js";

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
    const { payload: wire, bridge } = prepareOllamaWire(payload);
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
