export const COB_SURFACES = ["codex", "claude"] as const;
export type CobSurface = (typeof COB_SURFACES)[number];
export const DEFAULT_SURFACE: CobSurface = "codex";

export function isCobSurface(value: string): value is CobSurface {
  return (COB_SURFACES as readonly string[]).includes(value);
}
