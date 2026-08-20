import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  nativeSlugsFromCatalog,
  ollamaCatalogSlug,
  ollamaUpstreamModel,
  routeModel,
  stripOllamaPrefix,
} from "./route.js";

const native = new Set(["gpt-5.6-luna", "gpt-5.6-sol", "o3", "codex-mini"]);

describe("slug router", () => {
  it("keeps bundled native slugs on the native path, including non-gpt ids", () => {
    assert.equal(routeModel("gpt-5.6-luna", native), "native");
    assert.equal(routeModel("gpt-5.6-sol", native), "native");
    assert.equal(routeModel("o3", native), "native");
    assert.equal(routeModel("codex-mini", native), "native");
  });

  it("routes a single ollama/ prefix to Ollama", () => {
    assert.equal(routeModel("ollama/deepseek-v4-flash:cloud", native), "ollama");
    assert.equal(stripOllamaPrefix("ollama/deepseek-v4-flash:cloud"), "deepseek-v4-flash:cloud");
  });

  it("allows a colon in the Ollama id", () => {
    assert.equal(ollamaCatalogSlug("deepseek-v4-flash:cloud"), "ollama/deepseek-v4-flash:cloud");
  });

  it("encodes inner slashes instead of rejecting the whole catalog", () => {
    assert.equal(ollamaCatalogSlug("library/qwen2.5:7b"), "ollama/library%2Fqwen2.5:7b");
    assert.equal(ollamaUpstreamModel("ollama/library%2Fqwen2.5:7b"), "library/qwen2.5:7b");
  });

  it("does not default a missing model onto the native path", () => {
    assert.equal(routeModel(undefined, native), "unknown");
    assert.equal(routeModel("", native), "unknown");
    assert.equal(routeModel("ollama/", native), "unknown");
  });

  it("does not treat unknown slugs as native", () => {
    assert.equal(routeModel("gpt-5.6-luna", new Set()), "unknown");
    assert.equal(routeModel("mystery-model", native), "unknown");
  });

  it("collects native slugs from a mixed catalog", () => {
    const slugs = nativeSlugsFromCatalog({
      models: [
        { slug: "gpt-5.6-luna" },
        { slug: "o3" },
        { slug: "ollama/deepseek-v4-flash:cloud" },
        { slug: "" },
      ],
    });
    assert.deepEqual([...slugs].sort(), ["gpt-5.6-luna", "o3"]);
  });
});
