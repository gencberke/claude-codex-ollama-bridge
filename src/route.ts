import { OLLAMA_PREFIX } from "./constants.js";
import { decodeOllamaId, encodeOllamaId } from "./slug-codec.js";
import type { CatalogFile } from "./types.js";

export type RouteTarget = "native" | "ollama" | "unknown";

export function stripOllamaPrefix(model: string): string {
  return model.startsWith(OLLAMA_PREFIX) ? model.slice(OLLAMA_PREFIX.length) : model;
}

export function ollamaUpstreamModel(catalogSlug: string): string {
  return decodeOllamaId(stripOllamaPrefix(catalogSlug));
}

export function nativeSlugsFromCatalog(catalog?: CatalogFile): Set<string> {
  const slugs = new Set<string>();
  for (const model of catalog?.models ?? []) {
    if (typeof model.slug !== "string" || model.slug.length === 0) continue;
    if (model.slug.startsWith(OLLAMA_PREFIX)) continue;
    slugs.add(model.slug);
  }
  return slugs;
}

export function routeModel(model: string | undefined, nativeSlugs: ReadonlySet<string>): RouteTarget {
  if (!model || model.trim().length === 0) {
    return "unknown";
  }
  const trimmed = model.trim();
  if (trimmed.startsWith(OLLAMA_PREFIX) && trimmed.length > OLLAMA_PREFIX.length) {
    return "ollama";
  }
  if (nativeSlugs.has(trimmed)) {
    return "native";
  }
  return "unknown";
}

export function ollamaCatalogSlug(nativeId: string): string {
  return `${OLLAMA_PREFIX}${encodeOllamaId(nativeId)}`;
}
