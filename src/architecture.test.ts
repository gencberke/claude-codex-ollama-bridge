import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * Static dependency-direction gate for the cob architecture:
 *
 *   root/entrypoint -> codex -> core
 *   root/entrypoint -> claude -> core
 *
 * core must not import any surface, and the two surfaces must never import
 * each other. Checked on plain source text: static imports, re-exports, and
 * dynamic import() specifiers. No dependency framework. Runs against src
 * sources in the workspace and compiled dist output after compilation.
 */

const rootDir = dirname(fileURLToPath(import.meta.url));
const AREAS = ["core", "codex", "claude"] as const;
type Area = (typeof AREAS)[number];

function listModules(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listModules(path));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) out.push(path);
  }
  return out;
}

function areaOf(baseDir: string, file: string): Area | undefined {
  const rel = relative(baseDir, file);
  for (const area of AREAS) {
    if (rel === area || rel.startsWith(`${area}/`)) return area;
  }
  return undefined;
}

function importSpecifiers(text: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s*["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function targetArea(baseDir: string, fromFile: string, specifier: string): Area | undefined {
  if (!specifier.startsWith(".")) return undefined;
  return areaOf(baseDir, resolve(dirname(fromFile), specifier));
}

function forbidden(from: Area, to: Area): boolean {
  if (from === "core" && (to === "codex" || to === "claude")) return true;
  if (from === "codex" && to === "claude") return true;
  if (from === "claude" && to === "codex") return true;
  return false;
}

function collectViolations(baseDir: string, label: string, violations: string[]): void {
  for (const area of AREAS) {
    const areaDir = join(baseDir, area);
    if (!existsSync(areaDir)) continue;
    for (const file of listModules(areaDir)) {
      const from = areaOf(baseDir, file);
      if (!from) continue;
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        const to = targetArea(baseDir, file, specifier);
        if (to && forbidden(from, to)) {
          violations.push(`${label}/${relative(baseDir, file)} -> ${specifier}`);
        }
      }
    }
  }
}

describe("architecture dependency direction", () => {
  it("keeps core self-contained and the two surfaces isolated", () => {
    const violations: string[] = [];
    const distCore = join(rootDir, "core");
    if (existsSync(distCore)) {
      collectViolations(rootDir, "dist", violations);
      // The compiled tree alone cannot see type-only imports (erased at emit),
      // so audit the TypeScript sources too when they sit next to dist.
      const srcDir = join(rootDir, "..", "src");
      if (existsSync(join(srcDir, "core"))) {
        collectViolations(srcDir, "src", violations);
      }
    } else {
      collectViolations(rootDir, "src", violations);
    }
    assert.deepEqual(violations, []);
  });

  it("flags a forbidden type-only cross-surface import in scanned sources", () => {
    const fixture = mkdtempSync(join(tmpdir(), "cob-arch-fixture-"));
    try {
      mkdirSync(join(fixture, "claude"), { recursive: true });
      mkdirSync(join(fixture, "codex"), { recursive: true });
      writeFileSync(join(fixture, "codex", "target.ts"), "export type Secret = 1;\n");
      writeFileSync(
        join(fixture, "claude", "bad.ts"),
        'import type { Secret } from "../codex/target.js";\nexport const use = (): unknown => null;\n',
      );
      const violations: string[] = [];
      collectViolations(fixture, "fixture", violations);
      assert.equal(violations.length, 1);
      assert.match(violations[0]!, /fixture\/claude\/bad\.ts -> \.\.\/codex\/target\.js/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
