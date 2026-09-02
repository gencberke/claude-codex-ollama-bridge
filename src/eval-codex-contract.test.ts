import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  classifyContracts,
  CONSUMED_SCHEMA_FILES,
  evaluateCodexContract,
  extractClientRequestMethods,
  normalizeContract,
  normalizedContractSha256,
  rawSchemaSha256,
  REQUIRED_CLIENT_REQUEST_METHODS,
} from "./eval-codex-contract.js";

const here = dirname(fileURLToPath(import.meta.url));
const evalScript = join(here, "eval-codex-contract.js");

function clientRequestSchema(methods: string[]): unknown {
  return {
    oneOf: methods.map((method) => ({
      type: "object",
      properties: { method: { const: method } },
    })),
  };
}

function consumedSchemas(opts: { methods?: string[]; omit?: string[] } = {}): Record<string, unknown> {
  const methods = opts.methods ?? [...REQUIRED_CLIENT_REQUEST_METHODS, "thread/read"];
  const files: Record<string, unknown> = {
    "ClientRequest.json": clientRequestSchema(methods),
    "ModelListResponse.json": {
      properties: { models: { type: "array", items: { type: "string" } }, etag: { type: "string" } },
      required: ["models"],
    },
    "ModelProviderCapabilitiesResponse.json": {
      properties: { capabilities: { type: "array", items: { type: "string" } } },
      required: ["capabilities"],
    },
    "ExperimentalFeatureListResponse.json": {
      properties: { features: { type: "array", items: { type: "string" } } },
      required: ["features"],
    },
    "ThreadCompactStartResponse.json": {
      properties: { threadId: { type: "string" } },
      required: ["threadId"],
    },
  };
  for (const name of opts.omit ?? []) delete files[name];
  return files;
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

describe("Codex contract-diff sentinel", () => {
  it("extracts methods deterministically and sorts them", () => {
    const methods = extractClientRequestMethods(
      clientRequestSchema(["model/list", "thread/compact/start", "experimentalFeature/list"]),
    );
    assert.deepEqual(methods, ["experimentalFeature/list", "model/list", "thread/compact/start"]);
  });

  it("classifies identical and additive fixtures deterministically", () => {
    const baseline = normalizeContract(consumedSchemas());
    // Identical.
    assert.equal(classifyContracts(baseline, baseline).classification, "identical");
    assert.deepEqual(classifyContracts(baseline, baseline).reason_codes, []);
    assert.equal(
      normalizedContractSha256(baseline),
      normalizedContractSha256(normalizeContract(consumedSchemas())),
    );

    // Additive: a new unrelated method, a new field on a consumed type, and a
    // whole new unconsumed file stay additive.
    const additiveFiles = consumedSchemas();
    (additiveFiles["ClientRequest.json"] as { oneOf: unknown[] }).oneOf.push({
      type: "object",
      properties: { method: { const: "future/thing" } },
    });
    (additiveFiles["ModelListResponse.json"] as { properties: Record<string, unknown> }).properties.new_field = {};
    additiveFiles["FutureThing.json"] = { properties: { later: {} } };
    const additiveDiff = classifyContracts(baseline, normalizeContract(additiveFiles));
    assert.equal(additiveDiff.classification, "additive");
    assert.deepEqual(additiveDiff.added_methods, ["future/thing"]);
    assert.deepEqual(additiveDiff.added_fields, { "ModelListResponse.json": ["new_field"] });
    assert.deepEqual(additiveDiff.reason_codes, []);
  });

  it("classifies a missing required method and a removed consumed field as breaking", () => {
    const baseline = normalizeContract(consumedSchemas());
    const missing = normalizeContract(
      consumedSchemas({
        methods: REQUIRED_CLIENT_REQUEST_METHODS.filter((method) => method !== "thread/compact/start"),
      }),
    );
    const missingDiff = classifyContracts(baseline, missing);
    assert.equal(missingDiff.classification, "breaking");
    assert.ok(missingDiff.reason_codes.includes("required_method_missing:thread/compact/start"));

    const driftedFiles = consumedSchemas();
    delete (driftedFiles["ModelListResponse.json"] as { properties: Record<string, unknown> }).properties.etag;
    const driftedDiff = classifyContracts(baseline, normalizeContract(driftedFiles));
    assert.equal(driftedDiff.classification, "breaking");
    assert.ok(driftedDiff.reason_codes.includes("consumed_field_removed:ModelListResponse.json:etag"));
  });

  it("fails closed on a missing consumed type and on consumed-field shape drift", () => {
    const baseline = normalizeContract(consumedSchemas());

    const missingType = normalizeContract(consumedSchemas({ omit: ["ThreadCompactStartResponse.json"] }));
    const missingDiff = classifyContracts(baseline, missingType);
    assert.equal(missingDiff.classification, "breaking");
    assert.deepEqual(missingDiff.reason_codes, ["consumed_type_missing:ThreadCompactStartResponse.json"]);

    const shapeDrift = normalizeContract(
      (() => {
        const files = consumedSchemas();
        (files["ModelListResponse.json"] as { properties: Record<string, unknown> }).properties.models = {
          type: "string",
        };
        return files;
      })(),
    );
    const driftDiff = classifyContracts(baseline, shapeDrift);
    assert.equal(driftDiff.classification, "breaking");
    assert.deepEqual(driftDiff.reason_codes, [
      "consumed_field_shape_changed:ModelListResponse.json:models",
    ]);
    assert.deepEqual(driftDiff.changed_fields, { "ModelListResponse.json": ["models"] });

    const requiredDrift = normalizeContract(
      (() => {
        const files = consumedSchemas();
        delete (files["ThreadCompactStartResponse.json"] as { required?: string[] }).required;
        return files;
      })(),
    );
    const requiredDiff = classifyContracts(baseline, requiredDrift);
    assert.equal(requiredDiff.classification, "breaking");
    assert.ok(requiredDiff.reason_codes.includes("consumed_required_removed:ThreadCompactStartResponse.json:threadId"));
  });

  it("records the documented agentControl/ spelling and ignores the dot spelling", () => {
    const withoutControl = normalizeContract(consumedSchemas({ methods: [...REQUIRED_CLIENT_REQUEST_METHODS] }));
    const withSlash = normalizeContract(
      consumedSchemas({ methods: [...REQUIRED_CLIENT_REQUEST_METHODS, "agentControl/spawn"] }),
    );
    const withDot = normalizeContract(
      consumedSchemas({ methods: [...REQUIRED_CLIENT_REQUEST_METHODS, "agentControl.spawn"] }),
    );
    assert.equal(classifyContracts(withoutControl, withSlash).agent_control_present, true);
    assert.equal(classifyContracts(withoutControl, withDot).agent_control_present, false);
    assert.equal(classifyContracts(withoutControl, withoutControl).agent_control_present, false);
  });

  it("normalizes recursively so nested consumed shapes classify", () => {
    const baseline = normalizeContract(consumedSchemas());
    assert.deepEqual(Object.keys(baseline.types).sort(), [...CONSUMED_SCHEMA_FILES].sort());
    assert.deepEqual(baseline.types["ModelListResponse.json"]!.required, ["models"]);
    assert.deepEqual(baseline.types["ModelListResponse.json"]!.fields.models, {
      kind: "array",
      items: { kind: "type", types: ["string"] },
    });
    const nestedDrift = normalizeContract(
      (() => {
        const files = consumedSchemas();
        (files["ModelProviderCapabilitiesResponse.json"] as { properties: Record<string, unknown> }).properties =
          { capabilities: { type: "array", items: { type: "number" } } };
        return files;
      })(),
    );
    const diff = classifyContracts(baseline, nestedDrift);
    assert.equal(diff.classification, "breaking");
    assert.ok(diff.reason_codes.includes("consumed_field_shape_changed:ModelProviderCapabilitiesResponse.json:capabilities"));
  });

  it("hashes raw schemas unambiguously across file splits", () => {
    const merged = rawSchemaSha256([["a.json", '{"a":1}{"b":2}']]);
    const split = rawSchemaSha256([
      ["a.json", '{"a":1}'],
      ["b.json", '{"b":2}'],
    ]);
    assert.notEqual(merged, split);
    assert.equal(split, rawSchemaSha256([["b.json", '{"b":2}'], ["a.json", '{"a":1}']]));
  });

  it("runs a fake codex binary end to end and cleans temp output on success and failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-contract-test-"));
    const tmpRoot = mkdtempSync(join(tmpdir(), "cob-contract-tmp-"));
    const receiptPath = join(dir, "receipt.json");
    const fakeProducer = join(dir, "codex-producer");
    const fakeValidator = join(dir, "codex-validator-broken");
    const files = consumedSchemas();
    const lines = [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then printf \'codex-cli 0.149.0\\n\'; exit 0; fi',
      'out=""',
      'while [ $# -gt 0 ]; do if [ "$1" = "--out" ]; then out="$2"; break; fi; shift 1; done',
      '[ -n "$out" ] || exit 1',
    ];
    let index = 0;
    for (const [name, schema] of Object.entries(files)) {
      index += 1;
      lines.push(`schema_${index}=${shQuote(JSON.stringify(schema))}`);
      lines.push(`printf '%s' "$schema_${index}" > "$out/${name}"`);
    }
    lines.push("exit 0");
    writeFileSync(fakeProducer, `${lines.join("\n")}\n`);
    writeFileSync(fakeValidator, "#!/bin/sh\nexit 3\n");
    chmodSync(fakeProducer, 0o755);
    chmodSync(fakeValidator, 0o755);

    // Producer-only capture succeeds and cleans the temp dir.
    const side = await evaluateCodexContract(fakeProducer, fakeProducer, { tmpRoot });
    assert.equal(side.producer.version, "codex-cli 0.149.0");
    assert.match(side.producer.binary_sha256, /^[0-9a-f]{64}$/);
    assert.equal(
      side.producer.binary_sha256,
      createHash("sha256").update(readFileSync(fakeProducer)).digest("hex"),
    );
    assert.match(side.producer.raw_schema_sha256, /^[0-9a-f]{64}$/);
    assert.equal(side.comparison.classification, "identical");

    // A failing validator is rejected and still cleans its temp output.
    await assert.rejects(() => evaluateCodexContract(fakeProducer, fakeValidator, { tmpRoot }), /exited 3/);
    assert.deepEqual(readdirSync(tmpRoot), []);

    // Receipt content is content-free and complete.
    const result = spawnSync(process.execPath, [evalScript, fakeProducer, fakeProducer, "--out", receiptPath], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as { schema_version: number; comparison: { classification: string; reason_codes: string[] } };
    assert.equal(receipt.schema_version, 1);
    assert.equal(receipt.comparison.classification, "identical");
    assert.deepEqual(receipt.comparison.reason_codes, []);
  });

  it("ignores schema-generator output and bounds oversized version output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-contract-noise-"));
    const tmpRoot = mkdtempSync(join(tmpdir(), "cob-contract-tmp-"));
    const noisy = join(dir, "codex-noisy");
    // The fake writes well past any pipe buffer on both streams during schema
    // generation (ignored stdio, so it can never block the evaluator) and
    // emits a megabyte of version output (bounded read, so it settles with
    // the stable unavailable version representation instead of unbounded
    // accumulation).
    writeFileSync(
      noisy,
      "#!/bin/sh\n" +
        'if [ "$1" = "--version" ]; then\n' +
        '  yes "version filler line" | head -c 1000000\n' +
        "  exit 0\n" +
        "fi\n" +
        'out=""\n' +
        'while [ $# -gt 0 ]; do if [ "$1" = "--out" ]; then out="$2"; break; fi; shift 1; done\n' +
        '[ -n "$out" ] || exit 1\n' +
        'yes "stdout filler" | head -c 1000000\n' +
        'yes "stderr filler" | head -c 1000000 >&2\n' +
        'printf \'{}\' > "$out/ClientRequest.json"\n' +
        "exit 0\n",
    );
    chmodSync(noisy, 0o755);
    const side = await evaluateCodexContract(noisy, noisy, { tmpRoot });
    assert.equal(side.producer.version, "");
    assert.equal(side.validator.version, "");
    assert.match(side.producer.binary_sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(readdirSync(tmpRoot), []);

    // An infinite version writer locks the real 4096-byte bound: the bounded
    // read kills the child and settles immediately. Without the enforced
    // bound this run would wait for the 30-second timeout.
    const endless = join(dir, "codex-noisy-endless-version");
    writeFileSync(
      endless,
      "#!/bin/sh\n" +
        'if [ "$1" = "--version" ]; then\n' +
        '  yes "version filler line"\n' +
        "  exit 0\n" +
        "fi\n" +
        'out=""\n' +
        'while [ $# -gt 0 ]; do if [ "$1" = "--out" ]; then out="$2"; break; fi; shift 1; done\n' +
        '[ -n "$out" ] || exit 1\n' +
        'yes "stdout filler" | head -c 1000000\n' +
        'yes "stderr filler" | head -c 1000000 >&2\n' +
        'printf \'{}\' > "$out/ClientRequest.json"\n' +
        "exit 0\n",
    );
    chmodSync(endless, 0o755);
    const started = Date.now();
    const endlessSide = await evaluateCodexContract(endless, endless, { tmpRoot });
    assert.equal(endlessSide.producer.version, "");
    assert.equal(endlessSide.validator.version, "");
    assert.ok(
      Date.now() - started < 10_000,
      `endless version writer must be killed at the 4096-byte bound, took ${Date.now() - started}ms`,
    );
    assert.deepEqual(readdirSync(tmpRoot), []);
  });
});
