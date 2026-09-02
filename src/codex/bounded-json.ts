import { isRecord } from "../core/json.js";

/**
 * CPU/heap safety bound for recursive walks over provider-derived JSON on the
 * Codex/Ollama surface. This is a safety bound, not a product capability
 * limit: byte limits do not bound nesting, and a pathological provider or
 * client body must fail closed before JavaScript stack exhaustion.
 */

export const OLLAMA_JSON_MAX_DEPTH = 128;
export const OLLAMA_JSON_MAX_NODES = 100_000;

export type OllamaJsonSide = "request" | "upstream";

export type OllamaJsonOverflowKind = "depth" | "nodes";

export type OllamaJsonOverflow = {
  code: "ollama_json_traversal_overflow";
  side: OllamaJsonSide;
  kind: OllamaJsonOverflowKind;
  observedDepth: number;
  observedNodes: number;
  maxDepth: number;
  maxNodes: number;
};

export class OllamaJsonOverflowError extends Error {
  constructor(readonly overflow: OllamaJsonOverflow) {
    super(
      `Ollama JSON traversal exceeded the ${overflow.kind} budget on the ${overflow.side} side`,
    );
    this.name = "OllamaJsonOverflowError";
  }
}

export type OllamaTraversalBudget = {
  side: OllamaJsonSide;
  maxDepth: number;
  maxNodes: number;
  nodes: number;
};

export function newOllamaTraversalBudget(side: OllamaJsonSide): OllamaTraversalBudget {
  return { side, maxDepth: OLLAMA_JSON_MAX_DEPTH, maxNodes: OLLAMA_JSON_MAX_NODES, nodes: 0 };
}

/**
 * Account one visited node at the given container depth (root depth is 1).
 * Scalars and containers both count toward the node ceiling; only container
 * nesting counts toward the depth ceiling. Throws before recursing deeper.
 */
export function checkOllamaJsonNode(
  budget: OllamaTraversalBudget,
  depth: number,
): void {
  budget.nodes += 1;
  if (budget.nodes > budget.maxNodes) {
    throw new OllamaJsonOverflowError({
      code: "ollama_json_traversal_overflow",
      side: budget.side,
      kind: "nodes",
      observedDepth: depth,
      observedNodes: budget.nodes - 1,
      maxDepth: budget.maxDepth,
      maxNodes: budget.maxNodes,
    });
  }
  if (depth > budget.maxDepth) {
    throw new OllamaJsonOverflowError({
      code: "ollama_json_traversal_overflow",
      side: budget.side,
      kind: "depth",
      observedDepth: depth,
      observedNodes: budget.nodes,
      maxDepth: budget.maxDepth,
      maxNodes: budget.maxNodes,
    });
  }
}

/**
 * Bounded full scan of one payload before any request-side rewrite. Itself
 * budgeted, so a pathological body cannot exhaust the stack while being
 * measured.
 */
export function scanOllamaJsonBudget(value: unknown, side: OllamaJsonSide): void {
  const budget = newOllamaTraversalBudget(side);
  const walk = (node: unknown, depth: number): void => {
    checkOllamaJsonNode(budget, depth);
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (isRecord(node)) {
      for (const nested of Object.values(node)) walk(nested, depth + 1);
    }
  };
  walk(value, 1);
}

/** Content-free diagnostics: code, side, kind, configured limits, counters. */
export function formatOllamaJsonOverflowLog(overflow: OllamaJsonOverflow): string {
  return [
    "[cob] ollama json overflow",
    `code=${overflow.code}`,
    `side=${overflow.side}`,
    `kind=${overflow.kind}`,
    `depth=${overflow.observedDepth}/${overflow.maxDepth}`,
    `nodes=${overflow.observedNodes}/${overflow.maxNodes}`,
  ].join(" ");
}
