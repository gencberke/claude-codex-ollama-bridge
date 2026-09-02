import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "./core/json.js";

/**
 * Exact Codex contract-diff sentinel (pack-excluded eval fixture).
 *
 * Given two explicit Codex binary paths, generate the experimental app-server
 * JSON schema for each into a private temp dir, hash the raw schemas
 * unambiguously (per-file digests with file names), build a deterministic
 * normalized contract limited to the explicitly cob-consumed schema types,
 * and classify the difference as identical | additive | breaking. Writes a
 * content-free JSON receipt; never touches a home sidecar, root config, or
 * feature flag. A missing consumed type, a removed or shape-changed consumed
 * field, or a changed required set is breaking; unrelated new surfaces are
 * additive. Absence of public `agentControl/*` preserves the current Gate 6
 * external blocker.
 */

export const CODEX_CONTRACT_SCHEMA_VERSION = 1;

export const REQUIRED_CLIENT_REQUEST_METHODS = [
  "model/list",
  "modelProvider/capabilities/read",
  "experimentalFeature/list",
  "thread/compact/start",
] as const;

/** Gate 6 external blocker: agentControl/* presence is a research trigger only. */
export const AGENT_CONTROL_PREFIX = "agentControl/";

/** The exact schema files cob consumes; every other generated file is additive. */
export const CONSUMED_SCHEMA_FILES = [
  "ClientRequest.json",
  "ModelListResponse.json",
  "ModelProviderCapabilitiesResponse.json",
  "ExperimentalFeatureListResponse.json",
  "ThreadCompactStartResponse.json",
] as const;

export type CodexContractClassification = "identical" | "additive" | "breaking";

export type SchemaShape =
  | { kind: "any" }
  | { kind: "type"; types: string[] }
  | { kind: "const"; value: string }
  | { kind: "enum"; values: string[] }
  | { kind: "ref"; name: string }
  | { kind: "array"; items: SchemaShape }
  | { kind: "oneOf"; variants: SchemaShape[] }
  | { kind: "object"; fields: Record<string, SchemaShape>; required: string[] };

export type ConsumedTypeContract = {
  required: string[];
  fields: Record<string, SchemaShape>;
};

export type NormalizedCodexContract = {
  methods: string[];
  types: Record<string, ConsumedTypeContract>;
};

export type ContractDiff = {
  classification: CodexContractClassification;
  reason_codes: string[];
  added_methods: string[];
  removed_methods: string[];
  added_fields: Record<string, string[]>;
  removed_fields: Record<string, string[]>;
  changed_fields: Record<string, string[]>;
  agent_control_present: boolean;
};

export type CodexContractReceipt = {
  schema_version: typeof CODEX_CONTRACT_SCHEMA_VERSION;
  producer: CodexContractSide;
  validator: CodexContractSide;
  comparison: ContractDiff;
};

export type CodexContractSide = {
  binary_sha256: string;
  version: string;
  raw_schema_sha256: string;
  normalized_sha256: string;
};

const SCHEMA_WALK_MAX_DEPTH = 128;
const SHAPE_MAX_DEPTH = 32;
const CLIENT_REQUEST_FILE = "ClientRequest.json";

/** Bounded recursive extraction of method names from ClientRequest.json. */
export function extractClientRequestMethods(schema: unknown): string[] {
  const out = new Set<string>();
  walk(schema, 0, out);
  return [...out].sort();
}

function walk(node: unknown, depth: number, out: Set<string>): void {
  if (depth > SCHEMA_WALK_MAX_DEPTH) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, depth + 1, out);
    return;
  }
  if (!isRecord(node)) return;
  const props = node.properties;
  if (isRecord(props) && isRecord(props.method)) {
    if (typeof props.method.const === "string") out.add(props.method.const);
    if (Array.isArray(props.method.enum)) {
      for (const value of props.method.enum) {
        if (typeof value === "string") out.add(value);
      }
    }
  }
  for (const value of Object.values(node)) walk(value, depth + 1, out);
}

/**
 * Deterministic recursive shape descriptor for a JSON-schema node: consts,
 * enums, refs, variants, arrays, object field names, nested shapes, and the
 * required set. Unrecognized nodes normalize to `any` so malformed input
 * still yields a stable, comparable value.
 */
export function schemaShape(schema: unknown, depth = 0): SchemaShape {
  if (depth > SHAPE_MAX_DEPTH || !isRecord(schema)) return { kind: "any" };
  if (typeof schema.const === "string") return { kind: "const", value: schema.const };
  if (Array.isArray(schema.enum)) {
    return { kind: "enum", values: schema.enum.filter((value): value is string => typeof value === "string").sort() };
  }
  if (typeof schema.$ref === "string") return { kind: "ref", name: schema.$ref };
  if (Array.isArray(schema.oneOf)) {
    return { kind: "oneOf", variants: schema.oneOf.map((variant) => schemaShape(variant, depth + 1)) };
  }
  if (Array.isArray(schema.anyOf)) {
    return { kind: "oneOf", variants: schema.anyOf.map((variant) => schemaShape(variant, depth + 1)) };
  }
  if (isRecord(schema.items)) {
    return { kind: "array", items: schemaShape(schema.items, depth + 1) };
  }
  if (isRecord(schema.properties) || Array.isArray(schema.required)) {
    const fields: Record<string, SchemaShape> = {};
    if (isRecord(schema.properties)) {
      for (const key of Object.keys(schema.properties).sort()) {
        fields[key] = schemaShape(schema.properties[key], depth + 1);
      }
    }
    const required = Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === "string").sort()
      : [];
    return { kind: "object", fields, required };
  }
  if (typeof schema.type === "string") return { kind: "type", types: [schema.type] };
  if (Array.isArray(schema.type)) {
    return { kind: "type", types: schema.type.filter((value): value is string => typeof value === "string").sort() };
  }
  return { kind: "any" };
}

function shapeKey(shape: SchemaShape): string {
  switch (shape.kind) {
    case "any":
      return "any";
    case "type":
      return `type(${shape.types.join("|")})`;
    case "const":
      return `const(${shape.value})`;
    case "enum":
      return `enum(${shape.values.join("|")})`;
    case "ref":
      return `ref(${shape.name})`;
    case "array":
      return `array(${shapeKey(shape.items)})`;
    case "oneOf":
      return `oneOf(${shape.variants.map(shapeKey).join("|")})`;
    case "object":
      return `object{${Object.keys(shape.fields)
        .sort()
        .map((key) => `${key}=${shapeKey(shape.fields[key]!)}`)
        .join(",")}}req(${shape.required.join("|")})`;
  }
}

export function shapeEqual(a: SchemaShape, b: SchemaShape): boolean {
  return shapeKey(a) === shapeKey(b);
}

/**
 * Deterministic normalized contract: sorted ClientRequest methods plus, for
 * every explicitly consumed schema file, its required set and recursive
 * field shapes. Unconsumed files are deliberately not normalized; they are
 * additive surface.
 */
export function normalizeContract(files: Record<string, unknown>): NormalizedCodexContract {
  const clientRequest = files[CLIENT_REQUEST_FILE];
  const methods = clientRequest === undefined ? [] : extractClientRequestMethods(clientRequest);
  const types: Record<string, ConsumedTypeContract> = {};
  for (const name of CONSUMED_SCHEMA_FILES) {
    const schema = files[name];
    if (!isRecord(schema)) continue;
    const shape = schemaShape(schema);
    types[name] =
      shape.kind === "object"
        ? { required: shape.required, fields: shape.fields }
        : { required: [], fields: {} };
  }
  return { methods, types };
}

/**
 * Unambiguous raw-schema digest: per-file SHA-256 keyed by file name, so two
 * different file splits that concatenate to the same bytes hash differently.
 */
export function rawSchemaSha256(files: ReadonlyArray<readonly [string, string | Buffer]>): string {
  const digests = files
    .map(([name, bytes]) => [name, createHash("sha256").update(bytes).digest("hex")] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(digests)).digest("hex");
}

export function normalizedContractSha256(contract: NormalizedCodexContract): string {
  return createHash("sha256").update(JSON.stringify(contract)).digest("hex");
}

export function classifyContracts(baseline: NormalizedCodexContract, candidate: NormalizedCodexContract): ContractDiff {
  const reasonCodes: string[] = [];
  const baselineMethods = new Set(baseline.methods);
  const candidateMethods = new Set(candidate.methods);
  const addedMethods = candidate.methods.filter((method) => !baselineMethods.has(method));
  const removedMethods = baseline.methods.filter((method) => !candidateMethods.has(method));

  for (const required of REQUIRED_CLIENT_REQUEST_METHODS) {
    if (!candidateMethods.has(required)) {
      reasonCodes.push(`required_method_missing:${required}`);
    }
  }
  for (const method of removedMethods) {
    if (!REQUIRED_CLIENT_REQUEST_METHODS.includes(method as (typeof REQUIRED_CLIENT_REQUEST_METHODS)[number])) {
      reasonCodes.push(`method_removed:${method}`);
    }
  }

  const addedFields: Record<string, string[]> = {};
  const removedFields: Record<string, string[]> = {};
  const changedFields: Record<string, string[]> = {};
  for (const typeName of CONSUMED_SCHEMA_FILES) {
    const before = baseline.types[typeName];
    const after = candidate.types[typeName];
    if (after === undefined) {
      // A consumed type vanished from the generated schema: fail closed.
      reasonCodes.push(`consumed_type_missing:${typeName}`);
      continue;
    }
    if (before === undefined) continue;
    const beforeFields = new Set(Object.keys(before.fields));
    const afterFields = new Set(Object.keys(after.fields));
    const added = [...afterFields].filter((field) => !beforeFields.has(field)).sort();
    const removed = [...beforeFields].filter((field) => !afterFields.has(field)).sort();
    const changed = [...afterFields]
      .filter((field) => beforeFields.has(field) && !shapeEqual(before.fields[field]!, after.fields[field]!))
      .sort();
    if (added.length > 0) addedFields[typeName] = added;
    if (removed.length > 0) {
      removedFields[typeName] = removed;
      reasonCodes.push(`consumed_field_removed:${typeName}:${removed.join(",")}`);
    }
    if (changed.length > 0) {
      changedFields[typeName] = changed;
      reasonCodes.push(`consumed_field_shape_changed:${typeName}:${changed.join(",")}`);
    }
    const requiredAdded = after.required.filter((field) => !before.required.includes(field)).sort();
    const requiredRemoved = before.required.filter((field) => !after.required.includes(field)).sort();
    if (requiredAdded.length > 0) {
      reasonCodes.push(`consumed_required_added:${typeName}:${requiredAdded.join(",")}`);
    }
    if (requiredRemoved.length > 0) {
      reasonCodes.push(`consumed_required_removed:${typeName}:${requiredRemoved.join(",")}`);
    }
  }

  const breaking = reasonCodes.length > 0;
  const identical =
    !breaking &&
    addedMethods.length === 0 &&
    removedMethods.length === 0 &&
    Object.keys(addedFields).length === 0 &&
    Object.keys(changedFields).length === 0;
  return {
    classification: breaking ? "breaking" : identical ? "identical" : "additive",
    reason_codes: reasonCodes,
    added_methods: addedMethods,
    removed_methods: removedMethods,
    added_fields: addedFields,
    removed_fields: removedFields,
    changed_fields: changedFields,
    agent_control_present: [...candidateMethods].some((method) => method.startsWith(AGENT_CONTROL_PREFIX)),
  };
}

export async function evaluateCodexContract(
  producerBin: string,
  validatorBin: string,
  opts: { tmpRoot?: string } = {},
): Promise<CodexContractReceipt> {
  const producer = await captureContractSide(producerBin, opts.tmpRoot);
  const validator = await captureContractSide(validatorBin, opts.tmpRoot);
  const baseline = normalizeContract(producer.files);
  const candidate = normalizeContract(validator.files);
  return {
    schema_version: CODEX_CONTRACT_SCHEMA_VERSION,
    producer: {
      binary_sha256: producer.binarySha256,
      version: producer.version,
      raw_schema_sha256: producer.rawSchemaSha256,
      normalized_sha256: normalizedContractSha256(baseline),
    },
    validator: {
      binary_sha256: validator.binarySha256,
      version: validator.version,
      raw_schema_sha256: validator.rawSchemaSha256,
      normalized_sha256: normalizedContractSha256(candidate),
    },
    comparison: classifyContracts(baseline, candidate),
  };
}

type CapturedSide = {
  version: string;
  binarySha256: string;
  rawSchemaSha256: string;
  files: Record<string, unknown>;
};

async function captureContractSide(bin: string, tmpRoot?: string): Promise<CapturedSide> {
  const outDir = mkdtempSync(join(tmpRoot ?? tmpdir(), "cob-contract-"));
  try {
    await runSchemaGeneration(bin, outDir);
    const files: Record<string, unknown> = {};
    const entries: Array<[string, Buffer]> = [];
    for (const name of readdirSync(outDir).sort()) {
      if (!name.endsWith(".json")) continue;
      const bytes = readFileSync(join(outDir, name));
      entries.push([name, bytes]);
      try {
        files[name] = JSON.parse(bytes.toString("utf8"));
      } catch {
        files[name] = { parse_error: true };
      }
    }
    if (files[CLIENT_REQUEST_FILE] === undefined) {
      throw new Error(`generated schema is missing ${CLIENT_REQUEST_FILE}`);
    }
    return {
      version: await readVersion(bin),
      binarySha256: sha256File(bin),
      rawSchemaSha256: rawSchemaSha256(entries),
      files,
    };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

function runSchemaGeneration(bin: string, outDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // The evaluator never consumes the schema generator's stdout or stderr:
    // both streams are ignored so a noisy binary cannot fill a pipe and
    // block the evaluator.
    const child = spawn(bin, ["app-server", "generate-json-schema", "--experimental", "--out", outDir], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("codex schema generation timed out"));
    }, 120_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`codex schema generation exited ${code}`));
    });
  });
}

/** Version output is bounded so a noisy binary cannot exhaust memory or hang the evaluator. */
const MAX_VERSION_STDOUT_BYTES = 4096;

async function readVersion(bin: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let stdoutBytes = 0;
    let settled = false;
    const settle = (value: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle("");
    }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      const nextBytes = stdoutBytes + chunk.byteLength;
      if (nextBytes > MAX_VERSION_STDOUT_BYTES) {
        // Enforce the exact byte bound before appending: stop consuming the
        // stream, terminate the child, and settle with the stable unknown
        // representation. Nothing after settlement is appended.
        child.stdout.destroy();
        child.kill("SIGKILL");
        settle("");
        return;
      }
      stdoutBytes = nextBytes;
      stdout += chunk.toString("utf8");
    });
    child.once("error", () => {
      settle("");
    });
    child.once("close", () => {
      settle(stdout.trim().split(/\r?\n/)[0] ?? "");
    });
  });
}

function sha256File(path: string): string {
  const stat = statSync(path);
  void stat;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const producerBin = args[0];
  const validatorBin = args[1];
  const outArgIndex = args.indexOf("--out");
  const outPath = outArgIndex >= 0 ? args[outArgIndex + 1] : undefined;
  if (!producerBin || !validatorBin || !outPath) {
    console.error("usage: node dist/eval-codex-contract.js <producer-codex-bin> <validator-codex-bin> --out <receipt.json>");
    process.exit(2);
  }
  const receipt = await evaluateCodexContract(producerBin, validatorBin);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  console.log(
    `codex contract: classification=${receipt.comparison.classification} agent_control_present=${receipt.comparison.agent_control_present} receipt=${outPath}`,
  );
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
