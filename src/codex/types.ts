import type { JsonObject } from "../core/json.js";

export type CatalogFile = {
  models: JsonObject[];
};

export type ReasoningLevel = {
  effort: string;
  description: string;
};

export function asSlug(model: JsonObject): string {
  const slug = model.slug;
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error("catalog model is missing slug");
  }
  return slug;
}

export function asPriority(model: JsonObject): number {
  const priority = model.priority;
  return typeof priority === "number" && Number.isFinite(priority) ? priority : 99;
}

export function asVisibility(model: JsonObject): string {
  return typeof model.visibility === "string" ? model.visibility : "hide";
}
