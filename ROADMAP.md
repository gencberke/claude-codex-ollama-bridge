# Roadmap — implemented plan and live disposition

**Date:** 2026-08-24
**Status:** WP1–WP8 are implemented; exact global 0.1.13 is live (pid 35004); G11, G12, G14, G17, G18, and G19 are closed at their documented evidence scope
**Next:** retain the stable defaults; treat `ollama_effort = "none"` as an isolated opt-in candidate only, keep G13 local/G15/G16 limitations explicit, and revalidate after the next Desktop/Codex update

This document records the implemented contract and live-proof disposition.
It replaces the earlier proposal list with decisions verified against
the current code, the current Codex Desktop/CLI installation, upstream
documentation, and the 0.1.9 live cut.

`README.md` remains the product contract. `STATUS.md` records live evidence,
`LIVE-TESTING.md` defines the gold gates, and `RELEASE.md` defines the only
supported global-install path. If this file conflicts with one of those
contracts, stop and reconcile the documents before changing behavior.

## Outcome

Improve durability, long-turn reliability, and token efficiency without changing
the product boundary:

- Native GPT rows continue to use the native OpenAI route.
- `ollama/...` rows continue through cob to Ollama's OpenAI-compatible
  `/v1/responses` endpoint.
- Ollama threads keep `model_provider = "openai"` with a loopback
  `openai_base_url`.
- cob owns only its overlay, generated catalog, private state, and logs. The root
  Codex config remains user-owned.
- The working Desktop picker and V1 Ollama-child path are protected before any
  optimization is attempted.

The roadmap optimizes the bridge around that architecture. It does not replace
the architecture.

## Verified baseline

The following baseline was refreshed read-only on 2026-08-23 evening. Root
`config.toml` SHA-256 was `1c4bacffddc1679d11f1c8b8c3623f0876eb1dd577936f1517f7a9ce6c809839`
and cob did not write it. A later read-only check the same evening saw SHA
`996771deaf2f8aa28ce8c24ff505ed72d70ea53f0c9e2b978fa8e49c3f93147c` after the
0731 auto-compact stall; that is a Desktop/user rewrite, not a cob write.

- ChatGPT Desktop: `26.818.41509` (bundle `6962`).
- Desktop-bundled Codex: `0.149.0-alpha.4.1` at
  `/Applications/ChatGPT.app/Contents/Resources/codex`
  (`sha256=09db9560…`, inode `3913629`).
- PATH Codex: `0.147.0` at `/opt/homebrew/bin/codex`.
- Historical pre-roadmap snapshot: globally installed cob `0.1.6` at `/opt/homebrew/bin/cob`; gateway pid
  `39122` on `127.0.0.1:18790` reported health `ok`.
- Ollama client: `0.32.15`; daemon answered `ollama ps` with an empty table.
- Historical live `cob-catalog.json` SHA-256
  `07c189597516dec8ec8fa7e04c6a7179a0a460f8935f056db44710188731b016`
  (mtime 17:35, before the 18:22 Desktop binary). At that snapshot there was no
  `cob-catalog.meta.json` sidecar, so provenance was unknown before WP1.
- Historical `cob status` first line was `cob: ok` (installed 0.1.6 cannot emit
  `stale` / `unknown`). Overlay still `ok`. Isolated `--dev` home was absent.
- Isolated merge gate after WP1–WP6, the G8 flatten lock, and WP7 Stages
  2–4 fixtures: `npx tsc --noEmit` and `npm test` (292 passed, 0 failed,
  6 skipped).
- Live G8 compact shrink passed on cob **0.1.7** at **2026-08-23 20:29**
  after the 20:15 0.1.6 extract failure. Flatten summarizer
  `wire_bytes=266304` `tools_n=0`; first continuation `b_input=32885` /
  `input_n=7`; `replay_ratio ≈ 0.029`. Upstream exact tokens were omitted.
  Isolated L5 and G11–G17 remain open. cob **0.1.8** packs WP7 Stages
  2–4. Stage 3/4 defaults stay on the G8 path: summarizer effort omitted
  (wire `high`), active catalog cap 256k, no cloud max advertisement, no
  `auto_compact_token_limit`.

Current live release update (2026-08-23 22:44–22:50 local):

- Packed tarball `codex-ollama-bridge-0.1.9.tgz` SHA-256 is
  `90682ad1d9924140ad82df7bec402223868d8498383198a706bc5a794f016f99`;
  it contains 41 production/package files, no test harness, and remains
  `private: true` (no npm publish).
- Final merge gate: `npx tsc --noEmit` passed; `npm test` reported 316 tests,
  313 passed, 3 intentional skips, and 0 failures.
- Global `/opt/homebrew/bin/cob` reports **0.1.9**. The live gateway is pid
  **86967** on `127.0.0.1:18790`; health and Desktop overlay are `ok`.
- `cob status` is fail-closed `unknown` (exit 1), not a gateway outage. Schema-v2
  provenance retained the last-good catalog (`07c189597516…`) and recorded
  that PATH Codex 0.147 rejected the Desktop 0.149 candidate near
  `supports_parallel_tool_calls`. Native catalog rows were not repaired.
- G18 passed: real `web__run` returned a usable official OpenAI docs result via
  the exact native-search route; all three neighboring paths returned 404 and
  produced no upstream search hit. Global `cob smoke --live` also passed.
- Root `config.toml` SHA-256 was
  `6ae7ff46867ae81073af18106b49a82f3d19aafc642e80eb263764dd03a9b418`
  before and after install, G18, and smoke. cob did not write it.

Current packed candidate update (2026-08-24):

- cob **0.1.10** was packed for the first isolated G19 run and rejected because
  ordinary ingress/wire diagnostics still disclosed tool names. It was never
  installed globally and must not be shipped or repacked under the same
  version.
- cob **0.1.11** removes clear tool names from standard logs while preserving
  aggregate counts/SHA and sorted tool-definition byte sizes. The merge gate
  passed: `npx tsc --noEmit`; `npm test` reported 337 tests, 334 passed, 3
  intentional skips, and 0 failures.
- The inspected 43-file `codex-ollama-bridge-0.1.11.tgz` SHA-256 is
  `71b4e3f1963182d73097e5bac0e3ac67cd536e9f7ad5f4301dbca510fdc458db`.
  It contains production/package documentation only, not tests, source, or the
  G19 harness.
- Packed isolated G19 passed **25/25**: 21 protocol-conformance lanes, 3
  packed live-route lanes, and 1 real Codex task-effectiveness lane. Rejected
  turns created no checkpoint; direct, deferred search, V1, and MCP aliases
  continued; valid SSE published state before success `[DONE]`; logs stayed
  content-free. The root config SHA above was unchanged and port 18791 was
  stopped. Exact 0.1.11 was subsequently installed globally; live gateway is
  pid **7869** on `:18790` with health `ok`.
- The first G11–G17 execution found a real 0.1.11 stream defect: Ollama 0.32.15
  emits `response.completed` and may close without `[DONE]`, but cob required
  both and appended `upstream_stream_error` without a checkpoint. After fixing
  that, a real follow-up exposed a second dialect boundary: a first-turn string
  is valid as the whole `input`, but must become a typed item when replayed
  inside `input[]`.
- Packed cob **0.1.12** owns only those compatibility fixes. Its merge gate is
  `npx tsc --noEmit` plus 340 tests (337 pass, 3 intentional skips, 0 fail).
  The inspected 43-file tarball SHA-256 is
  `684db47f34cdafd246699639d1996c79b91a5fd8b048833b7aaa9d15f507dbb6`.
  Exact packed runtime against real Ollama completed the DONE-less stream,
  published before one client `[DONE]`, promoted string history, and completed
  the HTTP-200 continuation; Ollama access-log delta 2, checkpoints 1→2.
  The same artifact was then installed globally and passed the authorized
  two-turn smoke; host-network health remains `ok` after consumer alignment.

Post-release review and recovery audit (2026-08-24):

- Git checkpoint `e932eb19c551fbda96dc83fe7fe34840afff2371` preserves the
  complete 0.1.12 TypeScript, tests, and documentation. Its rebuilt production
  JS matched tarball `684db47f…` byte-for-byte. Exact 0.1.9, rejected 0.1.10,
  0.1.11, and 0.1.12 tarballs remain local. No tag, push, publish, or repack.
- A read-only parser experiment confirmed the schema diagnosis behind live
  `cob status`: Desktop 0.149 emits native rows without
  `supports_parallel_tool_calls`, PATH 0.147 requires that field, and adding
  either boolean value makes both parsers accept the candidate. This proves a
  syntactic superset is possible, not that cob knows the correct per-model
  value. Native-row backfill therefore remains rejected; align the consumers
  instead. `unknown` remains exit 1 by design because catalog readiness is a
  different signal from `/health` and overlay readiness.
- PATH Codex was aligned to 0.149.0. Global sync regenerated the original
  Desktop-produced candidate unchanged; both Desktop 0.149 alpha and PATH
  0.149 validate it, provenance is fresh, and no native-row backfill was used.
  After full Desktop quit/reopen the picker lists native and Ollama rows.
  Host-network status is `ok`. The install-time root baseline was `70b10957…`;
  later Desktop/user activity established current baseline `d24f79f…`; cob did
  not make either rewrite during the closeout.
- G11 then passed current native/Ollama wires and isolated validator-identity
  stale/no-spawn proof. G12 default-on passed live 0.1.12. Its false rollback
  exposed Ollama's namespace-qualified call identity; 0.1.13 fixes that exact
  dialect edge and passed the real isolated MCP + V1 rollback. Merge gate is
  344 tests (341 pass, 3 skip, 0 fail). Exact tarball SHA-256
  `81a99bad0f645bffcb0bb2551dae3a86dc5cb4dd8869d8a713fe210823fd1c72` is now
  live global pid **35004**. The affected G12 rollback retrace later passed on
  that exact global artifact with zero promotions or aliases.

The resolved version skew was not proof of a picker failure. Live 0.1.12 made
the producer/validator rejection explicit, then accepted the same unchanged
candidate after PATH aligned to 0.149. Future skew is still reported rather
than silently repaired.

## Code evidence map

Isolated WP1–WP7 were packed in cob **0.1.8**; 0.1.9 added the audit fixes and
0.1.11 added WP8. Global 0.1.12 is installed and healthy; source checkpoint
`e932eb1` preserves it. Gate disposition is evidence-specific:

- Catalog producer/sidecar/status kinds are implemented (`catalog-provenance.ts`).
  Failed candidates are recorded redacted in the same versioned sidecar,
  missing catalogs are non-ready, and every recorded validator identity is
  checked without spawning Codex.
  Live `cob status` can emit `stale` / `unknown`. Successful regeneration now
  passes with PATH 0.149 and Desktop 0.149. G11 passed current native/Ollama
  wires plus isolated identity-only stale/no-spawn proof.
- Search defaults on; newest-first promotion is unchanged and turn-local alias
  metrics now describe actual outbound mutations. The default-on live G12
  sequence passed. Its explicit-false rollback exposed Ollama's dot-qualified
  namespace wire identity; live 0.1.13 now guards that exact name and
  restores Codex namespace identity. Isolated and exact-global real MCP + V1
  rollback traces passed.
- Standalone `web.run` now has one exact native-only `/v1/alpha/search`
  compatibility route. This is not `supports_search_tool`; G18 passed on the
  packed global 0.1.9 build.
- Ollama allowlist is pinned to 0.32.15 `ResponsesRequest` fields;
  correctness-affecting `tool_choice` values fail closed. G13 cloud
  low/high/max and deterministic error-boundary lanes passed; its local-model
  lane is unavailable because only cloud tags are installed.
- Headers/idle/backpressure controlled lanes passed. G14 found the 0.1.11
  DONE-less stream defect; exact packed 0.1.12 fixed it, and global 0.1.13
  completed the long cloud stream, continuation, and abort/no-checkpoint lane.
- Catalog file-identity cache, one-stringify metrics, and SSE reference-equality
  passthrough are isolated-only. G15 measured WP5A as a repeatable win; WP5B
  was slower and WP5C equal, so there is no blanket performance pass.
- Checkpoint identity is recomputed on read and repeated-ID replay matches the
  reference merge rule. G16 passed its isolated tamper/restore matrix.
- G8 passed on installed 0.1.7 (2026-08-23 20:29). WP7 Stages 2–4 are
  packed in cob **0.1.8**; 0.1.9 strictly validates the required handoff
  skeleton. G17 same-corpus acceptance passed: `low` regressed, `none` was the
  isolated winner, cloud max was cross-client accepted with active 256k, and
  auto-limit remained correctly omitted by native-skeleton capability guard.
  No shipped default changed.
- The Ollama response path restores known deferred-tool aliases and now
  rejects an unknown `function_call.name` against the exact final outbound
  `tools[]` before alias restoration or checkpoint publication. Non-stream
  JSON validates first; SSE trips permanently on the first invalid client
  tool. WP8 first shipped globally in 0.1.11 and isolated G19 passed; 0.1.12
  preserves that guard while fixing the two real Ollama continuation dialect gaps.

## Upstream facts that constrain the plan

Only primary sources are normative for upstream behavior.

- Codex supports pointing the built-in OpenAI provider at a proxy with
  `openai_base_url`; `openai`, `ollama`, and `lmstudio` are reserved provider
  IDs. `model_catalog_json` is loaded at startup, and the documented provider
  stream idle default is 300 seconds.
  ([Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference),
  [advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced))
- Ollama's `/v1/responses` compatibility is non-stateful; it does not implement
  `previous_response_id` or `conversation`. cob therefore must retain its own
  continuation/checkpoint layer.
  ([Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility))
- Ollama cloud context can be much larger than cob's current 256k advertised
  window, but cloud usage is token-metered and concurrency can queue. A larger
  advertised limit is therefore not automatically a better default.
  ([context length](https://docs.ollama.com/context-length),
  [pricing and limits](https://ollama.com/pricing))
- Ollama documents 429 as a rate-limit/quota response. Retrying inside cob would
  stack with Codex's provider retry policy and can duplicate expensive requests.
  ([Ollama API errors](https://docs.ollama.com/api/errors))
- Ollama 0.32.15 accepts a finite Responses request surface and emits complete
  core usage counts. The bridge should version-test and normalize this contract,
  not forward arbitrary future Codex fields or fabricate token estimates.
  ([Ollama 0.32.15 Responses source](https://github.com/ollama/ollama/blob/v0.32.15/openai/responses.go))
- Codex models `response.completed.usage` as optional: an absent or top-level
  `null` usage is accepted, while a present but incomplete nested usage object
  can fail parsing. Ollama 0.32.15 constructs a complete integer-valued usage
  object. The current exact-or-omit policy is therefore correct; a speculative
  top-level-null rewrite is not justified by the pinned dialect.
  ([Codex Responses SSE parser](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/sse/responses.rs),
  [Ollama 0.32.15 Responses source](https://github.com/ollama/ollama/blob/v0.32.15/openai/responses.go))
- Ollama's Responses translator accepts `text.format.type = "json_schema"`,
  but Ollama's current documentation says Cloud does not support structured
  outputs. `structuredTextJsonSchema` is therefore translator-level evidence,
  not a Cloud capability claim. cob must not silently downgrade the request;
  any future Cloud-specific preflight needs its own pinned contract and tests.
  ([Ollama 0.32.15 Responses source](https://github.com/ollama/ollama/blob/v0.32.15/openai/responses.go),
  [Ollama structured outputs](https://github.com/ollama/ollama/blob/main/docs/capabilities/structured-outputs.mdx))
- OpenAI Responses treats `tools` as the set of tools the model may call,
  exposes ordered response output items, and uses `previous_response_id` for
  multi-turn state. Stateless reasoning replay can include
  `reasoning.encrypted_content`. cob therefore must validate provider output
  before it becomes Codex-visible continuation state; switching the Ollama path
  to Chat Completions would discard the product's native protocol boundary.
  ([OpenAI Responses API reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create))

OpenCodex was reviewed only as non-normative comparative evidence at commit
[`6ae83b1f`](https://github.com/lidge-jun/opencodex/tree/6ae83b1f189c353935d4977bb01227484fbdb52b).
Its transferable ideas are exact wire capability scoping, response-side
undeclared-tool rejection, deterministic negative controls, and separation of
protocol conformance from live-route and task-effectiveness evidence. Its broad
provider registry, Chat-default Ollama route, account pooling, sidecars,
autostart, native impersonation, and opaque-state degradation are not cob
product requirements and must not be copied.

## Non-negotiable guardrails

Every work package must preserve these rules:

1. Do not write `~/.codex/config.toml` from cob or its tests.
2. Use `cob start --dev` and the isolated development home for workspace trials.
   Live-home work requires the user's explicit request and follows
   `RELEASE.md`.
3. Do not add a custom provider, steal native GPT IDs, implement `nativeAlias`,
   patch the Desktop app, or make picker success depend on impersonation.
4. Never send ChatGPT headers, `x-codex-*`, Fernet, cob envelopes, or private
   checkpoint material to Ollama.
5. Do not call an Ollama `/compact` endpoint. Ollama-thread compaction remains a
   cob-owned summary protocol.
6. Keep Ollama collaboration on V1. Do not advertise Multi-Agent V2 or send V2
   collaboration payloads to Ollama.
7. Do not add `tool_mode`. Search support remains the existing
   `tool_search_call` to function-call translation with promoted leaf tools.
8. Do not install launchd, Login Items, or another supervisor. Recovery remains
   `cob start`.
9. Never release a stateful stream's `[DONE]` before its checkpoint publication
   succeeds.
10. Do not raise the catalog cap, compact threshold, or reasoning cost merely
    because an upstream maximum is larger.
11. Treat Ollama output as untrusted provider data. A client-executed tool call
    must match the exact final tool catalog sent on that request before alias
    restoration or checkpoint publication.

## Decision register

| Proposal | Decision | Reason |
| --- | --- | --- |
| Keep the loopback dual route | **Keep** | It is the working, Codex-native boundary. |
| Generate the live catalog with Desktop's bundled Codex | **Do first** | Desktop consumes the file and can run a newer schema than PATH Codex. |
| Persist catalog provenance and detect staleness | **Do first** | Current `status` cannot explain producer/version skew. |
| Default search support to true | **Do after current-build live proof** | It reduces tool-schema input cost and the shim already exists. |
| Make promoted tools chronological/first-come | **Reject as written** | It can pin stale schemas and starve newer relevant tools. Measure before redesigning order. |
| Raise all Ollama rows to a 1M active context | **Reject as default** | It increases paid input and delays lossy compaction without proven quality gain. |
| Expose a verified cloud maximum separately | **Opt-in proven; default off** | Desktop/PATH accepted active 256k + max 1,048,576 and G17 retained quality; it does not reduce compact cost by itself. |
| Split headers/TTFB and stream-idle timeouts | **Do** | The current 30-second “connect” timer actually covers the entire fetch-to-headers phase. |
| Estimate missing usage tokens | **Reject** | Invented counts can corrupt Codex context decisions and billing diagnostics. |
| Map `xhigh` to `max` | **Reject** | Inherited native settings would unexpectedly turn into the slowest/costliest Ollama mode. |
| Retry 429 inside cob | **Reject by default** | Codex already has retry semantics; double retry risks duplicate cost and work. |
| Add an Ollama request allowlist | **Do** | The Ollama compatibility surface is finite and version-specific. |
| Cache catalog by file identity | **Do after provenance** | Atomic catalog replacement gives a safe invalidation key. |
| Recompute checkpoint identity on read | **Do before faster equality** | Current validation trusts stored identity and cannot safely use identity-only comparison yet. |
| Release `[DONE]` before state publication | **Reject** | A visible completed response must already be continuable. |
| Persist a cross-request checkpoint cache | **Defer** | It can hide external tampering; reuse within one operation first. |
| Copy-on-write SSE rewriting | **Do after protocol tests** | It removes serialization work only when strict no-op equivalence is proven. |
| Rewrite compaction immediately | **G8 passed; Stage 2+** | Unchanged-path shrink is recorded. Later stages stay separate toggles. |
| Switch Ollama to Chat Completions by default | **Reject** | It adds a lossy Responses↔Chat translation layer and breaks the Codex-native state/tool/compact contract. |
| Add a multi-provider adapter registry | **Reject** | cob has one reviewed third-party destination; a general registry adds unused policy surface. |
| Version the Ollama Responses dialect | **Do narrowly in WP8A** | Request, response, terminal, usage, and state assumptions are version-specific and should have one testable authority. |
| Reject undeclared Ollama client tools | **Do before remaining live gates** | Unknown model-generated tool names must not reach Codex or continuation state. |
| Add provider terminal/item-ID repair | **Conditional** | Only a named live Ollama trace may justify a model/version-scoped repair; no speculative heuristics. |
| Add a runtime `allow_undeclared_tools` escape hatch | **Reject** | The guard is a safety boundary; rollback is a versioned code revert, not a silent unsafe mode. |

## Delivery rules

Each work package is independently reviewable and reversible. A package is done
only when all of the following are true:

- its implementation and negative tests are complete;
- `npx tsc --noEmit` and `npm test` pass;
- affected documentation is updated in the same package;
- no unrelated user changes are overwritten;
- any claimed Desktop/Ollama behavior has a named live trace in
  `LIVE-TESTING.md` and recorded evidence in `STATUS.md`;
- the globally installed tarball, not the workspace `dist/cli.js`, is used for a
  release decision.

Mock-only packages can merge locally, but they cannot be described as shipped or
live-proven until their live gates pass.

## WP0 — Refresh the current-build evidence

- **Type:** read-only/live baseline
- **Blocks:** release claims; it does not block writing isolated unit tests
- **Code changes:** none

### Goal

Replace the dated version observations above with one controlled current-build
matrix before changing catalog or compact behavior.

### Procedure

1. Record SHA-256 of the user-owned root config before any live-home experiment.
2. Record ChatGPT version, bundled Codex path/version/file identity, PATH Codex
   path/version/file identity, globally installed cob version/path, Ollama
   client/daemon version, and catalog SHA/mtime.
3. Run `cob status` without changing live state and capture its first line plus
   catalog/gateway diagnostics.
4. When the user authorizes cloud use, run the existing G1–G10 subset needed to
   establish picker, native routing, Ollama routing, tool search, V1 child, MCP,
   and G8 compact behavior on the same build.
5. Store redacted traces under the existing `.live/` convention; never record
   credentials, bearer tokens, prompt bodies, summaries, or user-owned
   configuration contents. Aggregate token counts are allowed.

### Exit criteria

- The matrix identifies one exact Desktop consumer and one exact CLI consumer.
- G8 either passes with measured before/after input shrink and continuation, or
  remains an explicit blocker with the failure stage identified. Current
  blocker: summarizer extract (`compaction_summary_invalid` after a no-tools
  request on a long tool-pair history). Follow-up shrink was not reached.
- Root-config SHA is unchanged.

## WP1 — Consumer-aware catalog generation and provenance

- **Priority:** first implementation package
- **Risk:** medium; picker/catalog durability
- **Depends on:** none for isolated implementation, WP0 for live release
- **Live gate:** reserve G11

### Goal

Generate native rows with the Codex binary that will consume them, prove that all
known consumers can parse the result, and make stale provenance visible without
launching Codex from `cob status`.

### Scope

Primary files:

- `src/catalog.ts`
- `src/paths.ts`
- `src/lifecycle.ts`
- `src/cli.ts`
- the status/rendering module reached from `cob status`
- `src/catalog.test.ts`, `src/lifecycle.test.ts`, and install/CLI tests
- `STATUS.md`, `LIVE-TESTING.md`, `README.md`, `RELEASE.md`, `CHANGELOG.md`

A small `catalog-provenance.ts` module is preferred if keeping discovery,
metadata validation, and status policy in `catalog.ts` would make it harder to
test. Do not split modules only for line-count cosmetics.

### Source selection contract

Resolve the catalog producer in this order:

1. An explicit `COB_CODEX_BIN` executable. This is an operator override and its
   use must be recorded in metadata and surfaced by `status`.
2. For the live Codex home on macOS, the executable in the standard Desktop
   bundle at `/Applications/ChatGPT.app/Contents/Resources/codex`, then the
   equivalent user Applications bundle if present.
3. The PATH `codex` executable.

Development homes continue to prefer the explicit override and then PATH unless
the caller explicitly chooses the Desktop binary. Tests inject discovery and do
not depend on `/Applications`.

Build the validator set from the selected producer plus every distinct detected
consumer relevant to that home: Desktop's bundled binary and PATH Codex. Dedup by
resolved file identity, not by the original path string.

### Metadata contract

Add a cob-owned sidecar, for example `cob-catalog.meta.json`, to `CobPaths`. Use
a versioned shape with no user data:

```json
{
  "schema_version": 1,
  "generated_at": "2026-08-23T00:00:00.000Z",
  "catalog_sha256": "...",
  "producer": {
    "kind": "desktop|path|override",
    "path": "/absolute/path/to/codex",
    "version": "codex-cli ...",
    "file": { "dev": "...", "ino": "...", "size": 0, "mtime_ms": 0 }
  },
  "validators": [
    {
      "kind": "desktop|path|override",
      "path": "/absolute/path/to/codex",
      "version": "codex-cli ...",
      "file": { "dev": "...", "ino": "...", "size": 0, "mtime_ms": 0 }
    }
  ]
}
```

Serialize potentially wide inode/device values as strings. Write the sidecar
atomically with owner-only permissions. Write the catalog first, then compute its
SHA and publish the sidecar. A crash between the two files intentionally leaves a
detectable SHA mismatch rather than false freshness.

`restore` removes the sidecar with the other cob-owned artifacts. It still does
not modify the root config.

### Generation and compatibility contract

1. Generate native rows with the selected producer.
2. Merge the Ollama rows using the existing cap, picker ordering, and schema
   allowlist. Do not “repair” native rows by copying fields from another Codex
   version.
3. Validate the candidate with every detected consumer in an isolated temporary
   Codex home. Never validate by editing the real root config.
4. If producer and consumer schemas are incompatible, abort the write and print a
   diagnostic naming both paths/versions and the failing field or command. Keep
   the last known-good catalog and sidecar intact.
5. Atomically install the new catalog and sidecar only after all validation
   succeeds.

### Status contract

`cob status` must not spawn Codex. It reads the catalog, sidecar, and current
binary stat records.

It reports the catalog as stale when any of these are true:

- the sidecar is missing for an existing live catalog;
- the catalog SHA does not match the sidecar;
- the selected producer path or file identity changed;
- a detected Desktop consumer changed after generation;
- the catalog cannot be parsed or its required picker rows are absent.

A stale live catalog forces the first status line to an actionable non-ready
state and a non-zero exit code, even if the gateway is healthy. The diagnostic
must say whether `cob sync` or `cob start` will regenerate it. A legacy catalog
without metadata is “provenance unknown”, not “fresh”.

Do not scan Desktop processes, signal the app, mutate a private model cache, or
claim that a running Desktop instance reloaded the file. After a successful live
catalog write, print one unconditional message that Desktop must be fully quit
and reopened before picker changes can be judged.

Also report V1 child roster capacity. The first-five discovery contract means
three featured GPT rows leave two Ollama child slots. A fifth total row is valid
but has zero roster headroom; overflow is a warning with the omitted configured
slugs named in configured order.

### Automated tests

- Source precedence: override, live Desktop, PATH fallback, development-home
  behavior.
- Dedup of the same binary reached through symlinks/different paths.
- Producer/validator version and stat capture.
- Candidate accepted by both consumers.
- Second consumer rejection preserves the previous catalog and metadata.
- Atomic write and simulated catalog/sidecar interruption.
- SHA mismatch, missing sidecar, changed inode/mtime/size, moved binary, malformed
  metadata, and unknown schema version.
- `status` never invokes the Codex subprocess.
- Stale provenance changes the first line and exit code.
- Restart hint is printed only after an actual live catalog replacement.
- Roster warning at zero headroom and deterministic overflow reporting.
- Restore removes only cob-owned catalog metadata.

### G11 — live acceptance

1. Install a packed global tarball following `RELEASE.md`.
2. Run global `cob start`/`sync` only after live-home authorization.
3. Prove the sidecar names the bundled Desktop producer and both detected
   validators.
4. Fully restart Desktop and prove picker, native GPT routing, and Ollama routing.
5. In an isolated copy, mutate only the recorded consumer identity and prove
   `status` becomes non-ready without spawning Codex.
6. Regenerate and prove status returns to ready.
7. Verify root-config SHA is unchanged.

### Rollback

Revert producer selection and sidecar/status enforcement together. Do not leave a
sidecar that claims freshness for a catalog generated by the old implicit source.
Candidate validation failure must leave the old pair intact. A crash between the
two final renames may leave a detectable mismatch; rerunning `sync` repairs it
from the same validated inputs.

## WP2 — Make deferred tool discovery the safe default

- **Priority:** second behavior package
- **Risk:** medium; tool availability and prompt cost
- **Depends on:** WP0 current-build tool traces and WP1's durable catalog baseline
- **Live gate:** reserve G12

### Goal

Default new/missing catalog configuration to `supports_search_tool = true` so
Codex can defer large tool schemas, while preserving an explicit false escape
hatch and the existing namespace-aware promotion protocol.

Primary files: `src/cob-config.ts`, `src/cli.ts`, `src/catalog.ts`,
`src/tool-search.ts`, `src/request-metrics.ts`, and their existing tests.

### Configuration and migration contract

- Change the compiled/default policy to true.
- Render true in newly created `cob.toml` files.
- A present explicit false from file/config remains false and wins over the
  default.
- Do not silently rewrite an existing false file: old generated false and a user
  choice are indistinguishable today. Document the one-line opt-in migration for
  existing installs. A future config schema may make provenance distinguishable.
- The current machine already has the flag enabled; that is evidence, not a
  migration mechanism.

### Protocol contract

Keep the current translation:

1. Advertise search support only when the effective policy is true.
2. Translate `tool_search_call` to an Ollama-compatible function call.
3. Translate its result back and promote discovered leaf tools on the next turn
   through namespace-aware aliases.
4. Preserve the catalog cap and the existing newest-schema behavior for now.

Do **not** implement the earlier “chronological first-come” proposal. It can pin
an obsolete schema and allow an early irrelevant tool to consume the cap. First
instrument, without logging schemas or arguments:

- ordered alias-list hash per turn;
- promoted alias count and total serialized bytes;
- aliases added, removed, and replaced;
- whether a used alias was still available on the next turn.

After at least three live turns across MCP and collaboration tool use, decide
whether there is a real ordering problem. A later design must prioritize used
aliases, keep the freshest schema, and remain deterministic; it is not a
prerequisite for default-on search.

### Automated tests

- Missing config defaults true; explicit true and false are honored.
- Existing false config is not rewritten during sync.
- False rows omit search capability and bypass translation.
- True rows advertise search, translate both directions, and promote leaf tools
  exactly once under stable aliases.
- MCP namespaced collisions remain isolated.
- V1 `spawn_agent` remains callable; no V2 payload or `followup_task` appears.
- Catalog cap and request-size limits still fail safely.
- Metrics contain counts/hashes only, never schemas, arguments, or outputs.

### G12 — live acceptance

On the same installed build, prove a three-turn sequence containing one deferred
MCP leaf and one V1 collaboration leaf. Record input/tool bytes by turn, alias
hashes, correct function execution, and continuation. Compare against explicit
false as the rollback control. Picker visibility alone does not pass G12.

### Rollback

Set `catalog.supports_search_tool = false`; no catalog hand-editing and no
`tool_mode` fallback.

### Compatibility addendum — standalone hosted web search

This is a different Codex protocol from WP2. `supports_search_tool` controls
deferred MCP/collaboration schemas (`tool_search_call`); Codex `web.run` sends
an independent `POST /v1/alpha/search` request because the built-in OpenAI
provider base URL points at cob.

Live 0.1.9 allowlists that one exact method/path and forwards
it only to `https://chatgpt.com/backend-api/codex/alpha/search`. The request
body is not rewritten, ChatGPT auth and turn headers use the existing native
allowlist, and the native response status/headers/body pass through. Search is
never sent to Ollama and no generic `/v1/*` proxy exists. This contract follows
Codex's [`codex-api` `SearchClient`](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/search.rs)
(`alpha/search`) and the built-in
[`CHATGPT_CODEX_BASE_URL`](https://github.com/openai/codex/blob/main/codex-rs/model-provider-info/src/lib.rs).
The official [web-search](https://learn.chatgpt.com/docs/web-search) and
[advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced)
pages confirm that standalone search is a hosted provider capability and that
`openai_base_url` replaces the built-in provider base. G18 passed on
2026-08-23: a real docs search was usable, the log stayed content-free, the
three neighboring paths failed closed without an upstream hit, and root-config
SHA was unchanged.
Unit coverage proves zstd body handling, header filtering/log redaction, error
transfer, Ollama non-use, and fail-closed neighboring paths.

## WP3 — Enforce the Ollama request/response boundary

- **Priority:** third behavior package
- **Risk:** medium; compatibility with current and future Ollama versions
- **Depends on:** WP0 and WP1's durable catalog baseline
- **Live gate:** reserve G13

### Goal

Send Ollama only the reviewed Responses surface, keep reasoning behavior
predictable, and make quota/usage failures explicit without duplicate retries or
invented token accounting.

Primary files: `src/ollama.ts`, `src/gateway.ts`,
`src/request-metrics.ts`, `src/acceptance.test.ts`, and their focused unit
tests.

### Request allowlist

For Ollama 0.32.15, version-test this candidate top-level set:

`model`, `input`, `instructions`, `max_output_tokens`, `reasoning`,
`temperature`, `text`, `top_p`, `truncation`, `tools`, and `stream`.

Before shipping, derive fixtures from the pinned upstream `ResponsesRequest`
type and prove each retained field is actually accepted by the local and cloud
paths used in G13. Apply these rules:

- Rewrite stateful Codex fields into cob's private continuation before the
  allowlist. Never forward `previous_response_id`, `conversation`, encrypted
  native state, or cob envelopes.
- Reject unsupported semantics that affect output correctness, such as an
  unimplemented structured `text.format`, with a precise 400-series cob error.
  Do not silently downgrade structured output to plain text.
- Drop only reviewed advisory fields that Ollama safely ignores. Emit a redacted
  field-name diagnostic in debug mode.
- Reject unknown fields by default on the Ollama route until they are reviewed;
  native requests remain byte-preserving.
- Continue stripping authorization and native-only headers at the Ollama
  boundary.

### Reasoning contract

Use one normalization function for catalog/default/top-level/nested reasoning:

| Incoming effort | Ollama effort |
| --- | --- |
| explicit `none` on a reasoning-capable row | `none` |
| `low` | `low` |
| `high` | `high` |
| explicit `max` | `max` |
| `medium`, `xhigh`, `minimal`, missing, or unknown on a reasoning-capable row | catalog/default `high` |

Explicit `max` remains available. `xhigh` does not imply `max`, because it is
commonly inherited from native Codex configuration. No unsupported effort string
may reach Ollama. For a row that does not advertise reasoning, remove an
inherited effort instead of injecting `high`.

### Usage contract

- Validate exact `input_tokens`, `output_tokens`, and `total_tokens` when
  present.
- If Ollama supplies exact `prompt_eval_count`/`eval_count` on another
  compatible shape, map them deterministically and test the fixture.
- Populate detail zeros only when upstream semantics prove they are exact zeros.
- Never estimate missing counts from bytes, characters, or a tokenizer for a
  different model.
- If core counts are absent on a successful response, preserve response content,
  log a redacted compatibility warning, and omit untrusted usage fields rather
  than inventing them. Confirm current Codex tolerates this in isolation before
  release.

### 429/error contract

- Never retry after response headers or mid-SSE.
- Do not add an automatic gateway retry in this package.
- Preserve status meaning and `Retry-After` when present.
- Normalize Ollama's error body into the existing cob error shape and distinguish
  concurrency/rate limiting from exhausted quota when upstream provides enough
  information.
- Tell the operator to retry later, reduce concurrency, or replenish quota; do
  not imply that `cob start` fixes quota.

### Automated tests

- Snapshot the exact outbound key set for ordinary, tools, compact, and continued
  Ollama requests.
- Unknown/advisory/correctness-affecting fields take their documented paths.
- Native route remains unchanged byte-for-byte except existing header policy.
- Reasoning mapping covers every table row and nested/top-level precedence.
- Explicit max survives; inherited xhigh becomes high.
- Complete, alternate exact, and missing usage fixtures.
- 429 with/without `Retry-After`, quota wording, non-JSON body, pre-stream and
  mid-stream failures; assert one upstream attempt.

### G13 — live acceptance

Capture redacted outbound key names and response usage keys for one local model
and one cloud model, plus low/high/max reasoning. Force or fixture a 429 at the
gateway boundary and prove one upstream attempt and preserved retry metadata.
Verify no user text, tool arguments, auth, or private state is logged.

### Rollback

The allowlist can revert as one boundary module. Keep the existing private-state
stripping even during rollback; never restore blind forwarding of sensitive
fields.

## WP4 — Long-turn timeout and backpressure correctness

- **Priority:** fourth behavior package
- **Risk:** high; streaming and cancellation
- **Depends on:** WP3 request/error boundary
- **Live gate:** reserve G14

### Goal

Allow legitimate slow Ollama reasoning without permitting unbounded hangs or
falsely timing out a healthy upstream while the Codex client is applying
backpressure.

### Timeout contract

Rename the current concept in code and errors: `fetch()` resolves at response
headers, so `CONNECT_TIMEOUT_MS` is a headers/TTFB deadline, not a TCP-connect
timer.

Primary files: `src/limits.ts`, `src/timeouts.ts`, `src/relay.ts`,
`src/native.ts`, `src/ollama.ts`, `src/gateway.ts`, and the timeout,
gateway, stream-crash, and acceptance tests.

Initial route defaults:

- native headers deadline: 30 seconds;
- Ollama headers deadline: 240 seconds;
- upstream body/stream idle deadline: 300 seconds, matching Codex's documented
  provider default;
- catalog, health, and `/api/tags` deadlines remain separate short operations.

Rename `ConnectTimeoutError` to describe the headers phase and return the
cob-owned code `upstream_headers_timeout` with HTTP 504. Update all tests and
diagnostics together; no routing or retry decision may depend on the old
`connect_timeout` string.

Keep dependency-injected timeout options for tests. Do not add public knobs until
the live trace shows a real need; if public configuration is later added, use
route-specific names and retain one-release compatibility for any existing
internal option.

### Backpressure contract

The idle clock measures time waiting for upstream bytes, not time blocked on the
downstream socket.

- When `res.write()` returns false, pause the upstream-idle deadline while the
  pipeline is backpressured.
- Resume/re-arm it on downstream `drain` before upstream reading continues.
- Continue to enforce client cancellation and overall body-size limits while
  paused.
- A received upstream chunk resets the clock. Do not claim access to raw socket
  activity that Node `fetch` does not expose.
- Do not invent `response.heartbeat` events. A standard SSE comment heartbeat
  may be evaluated only in an isolated compatibility experiment and is not
  required for this package.

### Automated tests

- Headers arrive just before/after native and Ollama deadlines.
- Local connection refusal fails immediately rather than waiting 240 seconds.
- Slow headers followed by active streaming succeeds.
- Idle before first byte and idle between chunks produce `idle_timeout`.
- A downstream socket held past 300 seconds does not create a false upstream idle
  timeout; after drain, a truly silent upstream does.
- Client abort cancels fetch/reader and releases timers/listeners.
- Non-stream response reading uses the same idle semantics.
- Pre-header failures return JSON; post-header SSE failures emit one error
  terminal followed by one `[DONE]`.

Use fake timers and controlled streams for deterministic unit tests; add one real
loopback integration test for Node stream pause/drain behavior.

### G14 — live acceptance

Use a controlled loopback upstream to delay response headers past 30 seconds,
then run a long cloud reasoning turn and a stream with a deliberate quiet
interval. Record response-header latency separately from first-event latency,
maximum inter-event gap, completion state, timer category, and continuation
success. Also disconnect one client and prove upstream cancellation without a
gateway crash.

### Rollback

Route-specific constants and the backpressure-aware watcher revert together.
Never roll back to an unbounded timeout.

## WP5 — Safe hot-path reductions

- **Priority:** after reliability packages
- **Risk:** low to medium
- **Depends on:** WP1 for catalog identity; WP4 for relay instrumentation
- **Live gate:** reserve G15 only if a measurable claim is made

This package contains three independent commits. They may be split further if
review shows file overlap.

Primary files: `src/catalog.ts`, `src/gateway.ts`,
`src/request-metrics.ts`, `src/ollama.ts`, `src/sse.ts`, `src/relay.ts`,
and their focused tests/benchmark fixtures.

### WP5A — Catalog cache by file identity

Cache parsed catalog data by `(dev, ino, size, mtimeMs)` and invalidate on any
change. Atomic sync replacement changes identity naturally. Preserve the current
fallback when the catalog is missing/malformed and retain the gateway hot-reload
test where a new model becomes routable without restart.

Tests cover cache hit, atomic rename, in-place rewrite with changed mtime/size,
malformed replacement, deletion, and restoration. Cache data is process-local
and never treated as catalog provenance; WP1's sidecar remains authoritative for
status.

### WP5B — Compute request diagnostics once

Keep inbound metrics and post-rewrite Ollama wire metrics as two distinct
snapshots; they measure different payloads. Within each snapshot, serialize each
field once and reuse the bytes for its count/hash/detail calculations. Pass the
snapshot to log formatters. Keep per-tool accounting internally to diagnose
schema bloat, but standard logs expose only aggregate counts/hashes and sorted
top definition byte sizes, never tool names. This preserves size diagnostics
without conflicting with G19 redaction.

Add a microbenchmark fixture with a large tool list. Ship only if it reduces
serialization/hash work without changing log output or logging sensitive values.

### WP5C — Copy-on-write SSE rewriting

The observer still parses every relevant event needed for state and metrics. The
rewriter returns the original parsed object only when no field, item, ID, or
usage value changes. Only that strict reference-equality fast path may forward
the original `data:` payload without `JSON.stringify`.

Tests compare byte output and observer state for unchanged events, rewritten IDs,
usage normalization, tool calls, error events, chunk boundaries, CRLF, and
multi-line SSE data. Property/fuzz tests should assert that optimized and
reference rewriters are semantically identical.

### Exit criteria

- Benchmark fixtures and methodology are checked in or reproducible.
- No optimization changes routing, state publication order, size limits, error
  terminals, or redaction.
- Remove an optimization if the gain is noise relative to Ollama inference time.

### G15 — performance acceptance

For each retained optimization, run at least 30 warm-up and 100 measured
iterations of the fixed large-catalog/tool/SSE fixture on the same Node version.
Record median and p95 wall time, CPU time where available, allocation/heap delta,
output hash, and fast-path hit rate. Keep the change only if it has identical
output and a repeatable improvement outside run-to-run noise. A live trace may
record hit counts and timings, never event or tool contents. If there is no
measurable claim, remove the optimization and mark G15 not applicable rather
than declaring a no-op pass.

### Rollback

Revert WP5A, WP5B, and WP5C independently. None may introduce a persisted format,
so rollback must not require state or catalog migration.

## WP6 — Checkpoint integrity before state performance

- **Priority:** correctness before optimization
- **Risk:** high; continuation durability
- **Depends on:** stable G8/G14 traces
- **Live gate:** reserve G16

### Goal

Make stored identity trustworthy, remove avoidable repeated work within one
operation, and only then optimize equality/merge costs.

Primary files: `src/conversation-state.ts`,
`src/conversation-state.test.ts`, `src/state-gateway.test.ts`, and the narrow
publication call sites in `src/gateway.ts`.

### WP6A — Validate identity from content

On checkpoint read, recompute each history item's identity from its value and
provenance using the canonical algorithm. Reject the checkpoint if the stored
identity differs. This migration is fail-closed: do not silently rewrite a
tampered checkpoint during a request.

Only after that validation may `sameHistory` compare ordered identity sequences
instead of serializing entire histories. Equality still includes length and
order; duplicate identities remain invalid at checkpoint validation.

Tests cover changed value with old identity, changed provenance, reordered items,
duplicates, legacy valid checkpoints, malformed identity, and collision-test
injection where practical.

### WP6B — Linearize merge membership

Replace repeated scans with maps/sets keyed by the validated item identity and
the existing provenance/item key. Preserve ordering and the exact conflict rules.
Use corpus tests that compare the old reference algorithm and the new algorithm
across generated histories before deleting the reference fixture.

### WP6C — Reuse reads inside one operation

When publish and orphan cleanup need the same checkpoint listing, pass the
already-read result through the call chain. Do not add a persistent cross-request
memory cache. External edits, crash recovery, and tamper detection must remain
visible on the next operation.

### WP6D — Audit cloning

Identify each clone's mutation boundary before removing it. Remove only clones
whose downstream consumers are proven read-only by types and tests. Benchmark
large-history continuation before and after; no blanket “avoid clone” rewrite.

### Publication invariant

Retain the current order for both normal and compact responses:

1. finish and validate the upstream response;
2. atomically publish the continuation checkpoint;
3. expose the terminal completed response/`[DONE]` to Codex.

If publication fails, fail the response. A successful-looking turn that cannot
continue is worse than a visible failure.

### Deferred state ideas

- Persistent checkpoint cache.
- Delta/schema-v2 checkpoint storage.
- Shorter lock polling or a new lock backend.
- Broad async-`fs` conversion.

Each needs a separate measurement and crash/tamper design.

### G16 — state-integrity acceptance

In the isolated development home, run a normal three-turn continuation and a
compact continuation, then tamper separately with stored value, provenance, and
identity. Each tampered checkpoint must fail closed with the documented
full-context recovery instruction and must not publish a new checkpoint. Restore
the valid fixture and prove continuation still succeeds. Record checkpoint IDs,
hashes, state transitions, and timing only; do not record conversation content.
Repeat the untampered normal/compact path with the packed global build before
release.

### Rollback

Revert performance slices WP6B–WP6D independently. If WP6A reveals previously
accepted corrupt checkpoints, retain the fail-closed validator unless it rejects
a checkpoint proven to have been produced by the current canonical writer. Any
compatibility migration requires a versioned reader and its own fixtures; do not
weaken identity validation ad hoc.

## WP7 — Compaction quality and context policy

- **Priority:** only after unchanged-path G8 passes
- **Risk:** high; lossy history transformation and paid input
- **Depends on:** WP0/G8, WP3 usage evidence, WP4 long-turn reliability, WP6 integrity
- **Live gate:** reserve G17

### Stage 1 — Prove the current algorithm unchanged

Primary files after the baseline passes: `src/compaction.ts`,
`src/gateway.ts`, `src/compaction.test.ts`, `src/state-gateway.test.ts`,
`COMPACTION.md`, and the G8/G17 sections of `LIVE-TESTING.md`.

Unchanged-path G8 passed (2026-08-23 20:29, live cob 0.1.7 flatten handoff
after the 20:15 0.1.6 extract failure). Recorded bytes: pre-compact
`b_input=1121805` / last-turn wire `1167851`; compact request
`wire_bytes=266304`; first continuation `b_input=32885` / next Ollama wire
`48206`; checkpoint `cob_cmp_6bebd81b54f9377ddb3de5bcac3647ff` with `cob1.`
and `provenance.source=ollama-summary`. Upstream tokens omitted.
Continuation resumed tool calls. Isolated L5 still unrun.

G8 must record:

- pre-compact history/input bytes and exact tokens when upstream supplies them;
- compact request bytes/tokens;
- summary response bytes/tokens;
- first continuation request bytes/tokens;
- successful retention of constraints, decisions, pending work, and tool state;
- absence of private/native ciphertext on the Ollama boundary.

Do not change the prompt, effort, context limit, or threshold before this
baseline.

### Stage 2 — Remove duplicate instructions

The current summarizer instruction is represented both at top level and as a
developer message. Test three fixtures and keep exactly one authoritative copy
if quality is equal or better. The retained instruction must require these
sections, with `None` allowed rather than omission:

- Goal
- Constraints
- Completed
- Pending
- Decisions
- Tool state
- Verification/evidence

Log only latency, byte/token counts, section-presence flags, and error codes. Do
not log summary text.

### Stage 3 — Effort experiment

Compare supported `none` (if the pinned model/version truly supports it) and
`low` against the current behavior. Isolated: `compaction.ollama_effort`
accepts `none` / `low` / `high` / `max`. Omit the key to keep the current G8
wire (`high` after `prepareOllamaWire`). G17 rejected `low` (slower and roughly
double output tokens) and identified `none` as the isolated same-corpus winner.
`none` remains explicit opt-in until a broader quality corpus justifies a
separate default-changing release. A malformed or incomplete
skeleton fails closed with `compaction_summary_incomplete` /
`requires_full_context`; cob does not automatically resend the full history
because that doubles the most expensive input.

### Stage 4 — Separate maximum from active threshold

Keep the default active context at 256k during the experiment.

- For verified cloud tags (`:cloud` / `-cloud` / `remote_host`),
  `catalog.advertise_cloud_max_context = true` exposes tag
  `max_context_window` without raising `context_window`. Default is off.
- Local rows stay conservative (`max` equals active) even when the tag
  reports 1M.
- Desktop and PATH bundled rows currently omit `auto_compact_token_limit`.
  cob emits that field only when the native skeleton already has it and
  `catalog.auto_compact_token_limit` is set. Isolated experiment value is
  `230400` (90% of 256k).
- `catalog.active_context_window` can raise the active cap; never infer it
  from `max_context_window`.
- Larger active contexts are opt-in until G17 shows lower total cost or materially
  better task success. Never infer benefit from maximum context alone.

### G17 — live acceptance

Use the same long task corpus for baseline and candidate. Compare task success,
constraint retention, compact latency, total input/output tokens, first
continuation size, and a second continuation. Pass only if the candidate
preserves or improves task quality and does not create an unexplained cost
regression.

**Result (2026-08-24): PASS, no default change.** Fixed corpus SHA
`554c6ece…` retained both quality checks and all section flags in baseline,
`low`, `none`, and cloud-max lanes. Baseline compact was 3297ms / 561 output
tokens; `low` regressed to 4703ms / 1131; `none` improved to 1488ms / 225.
Cloud max was accepted by Desktop and PATH with active 256k. Auto-limit was
not eligible because current native skeletons omit the field, and cob correctly
did not emit it. Full metrics are in `LIVE-TESTING.md`.

### Rollback

Prompt, effort, maximum advertisement, and active threshold are separate toggles.
Revert the failing dimension only; retain the proven current G8 path.

## WP8 — Ollama response integrity and dialect conformance

- **Priority:** implementation/G19 complete and live in 0.1.11; install the
  separately packed 0.1.12 compatibility fix, then rerun affected live lanes
- **Risk:** high; streaming terminal semantics, tool dispatch, and checkpoint
  publication
- **Depends on:** WP2 alias mapping, WP3 request boundary, WP4 streaming
  behavior, and WP6 state integrity
- **Live gate:** G19 passed on packed isolated 0.1.11
- **Release:** original WP8 artifact was live as 0.1.11 before 0.1.12
  superseded it, tarball SHA-256
  `71b4e3f1963182d73097e5bac0e3ac67cd536e9f7ad5f4301dbca510fdc458db`;
  compatibility successor is packed 0.1.12, SHA-256
  `684db47f34cdafd246699639d1996c79b91a5fd8b048833b7aaa9d15f507dbb6`;
  do not repack either version

### Goal

Treat Ollama Responses as one versioned provider dialect and refuse any
client-executed tool call that was not present in the exact final `tools[]`
catalog sent for that request. A refused or malformed provider turn must never
become a checkpoint, a valid `previous_response_id`, or a successful-looking
terminal.

This package hardens the existing Responses-only path. It does not add Chat
Completions, another provider, a generic adapter registry, terminal repair,
item-ID invention, retries, or a user-facing compatibility toggle.

Primary files:

- new `src/ollama-dialect.ts`;
- new `src/ollama-response-boundary.ts`;
- `src/ollama-boundary.ts`, `src/ollama.ts`, `src/gateway.ts`, and only if the
  chosen SSE design requires it, `src/sse.ts`;
- focused `ollama-dialect`, response-boundary, gateway, state, SSE, and
  acceptance tests;
- `README.md`, `STATUS.md`, `LIVE-TESTING.md`, `CHANGELOG.md`, and this file.
  Isolated implementation, packing, and G19 are complete; global installation
  remains a separate authorization.

Do not split `gateway.ts` merely for line count. New modules must own a distinct
contract that can be tested without starting the gateway.

### WP8A — One machine-readable Ollama dialect authority

Create a small immutable contract and make existing boundary constants consume
it rather than duplicating lists. At minimum it records:

- reviewed upstream: Ollama `0.32.15`, source path
  `openai/responses.go`, endpoint `/v1/responses`;
- provider state: stateless; cob owns `previous_response_id` expansion and
  checkpoint persistence;
- accepted, advisory-dropped, and correctness-rejected request fields;
- successful JSON envelope and SSE terminal expectations;
- `usage` optionality — absence is never fabricated into zero;
- reviewed client-executed output call kinds and the rule that their names must
  come from the final outbound catalog;
- exact capabilities that remain unknown or unsupported.

The contract is a source/test authority, not runtime provider discovery. Normal
requests and `cob status` must not call `/api/version`, spawn `ollama`, or block
traffic merely because the installed version string differs. G19 records the
observed version and classifies a mismatch as `dialect_untested`; promoting new
behavior requires a new source review plus fixtures.

Exit criteria:

- request-field lists have one owner;
- every contract row has at least one positive or negative test;
- no production dependency or runtime JSON manifest is added;
- no current accepted request changes behavior in WP8A alone.

### WP8B — Capture the exact request-visible wire tool catalog

Derive the declared-name set from `prepareOllamaWire`'s final bounded payload,
after `tool_search` conversion, newest-first leaf promotion, namespace aliasing,
collision handling, model-prefix removal, and request allowlisting. Never infer
authorization from the original Codex body or from historical state.

Contract:

- only names actually present in final outbound `tools[]` are declared;
- promoted aliases such as `multi_agent_v1__spawn_agent` are declared under the
  wire alias and may later be restored through the request-local bridge;
- a skipped/colliding/over-cap leaf is not declared;
- `tool_search` is declared only when its converted function definition reached
  Ollama;
- an empty outbound catalog authorizes no client-executed function call;
- tool schemas, descriptions, arguments, outputs, and user text are never kept
  in the guard state or diagnostic log.

Extend the Ollama forward result with an immutable request-local declaration
snapshot. It may include a deterministic SHA-8/count for diagnostics, but not
the tool bodies. Keep the current alias bridge separate: authorization answers
“may this wire name be called?” while the bridge answers “how is an authorized
alias restored for Codex?”.

WP8B must not introduce recursive rejection of all non-function tool
definitions yet. First lock the actual G12 corpus. A new request tool-type
allowlist is a separate future change unless the pinned Ollama source and live
wire both establish it without breaking Codex tools.

### WP8C — Non-stream JSON response guard

Validate a successful Ollama JSON response before normalization, usage logging,
checkpoint publication, or client relay.

Rules:

1. Inspect response `output[]` for client-executed call items. At minimum,
   `function_call` is guarded. Any additional call kind must be present in the
   dialect contract before it is accepted.
2. A non-empty call name must match the exact final wire declaration set.
3. A missing, empty, non-string, or unreviewed call name/type is a provider
   compatibility failure, not a message and not a repair opportunity.
4. Validate the upstream wire name before namespace/alias restoration.
5. On failure return HTTP 502 with type `upstream_error` and stable code
   `ollama_undeclared_tool_call` or `ollama_tool_call_invalid`. The client-facing
   diagnostic may contain a safely JSON-escaped, 100-character maximum tool
   name; logs contain only failure kind, bounded length, and SHA-8 — never the
   name, arguments, body, or response text.
6. Do not publish a checkpoint. If the request used a valid
   `previous_response_id`, that prior checkpoint remains valid and can be used
   to retry the turn.

Validation must move ahead of the current non-stream checkpoint write. A guard
failure must not fall through to the raw-body compatibility catch or be relayed
with upstream status 200.

### WP8D — Sticky SSE response guard and state ordering

Guard these output-bearing shapes on the Ollama wire:

- `response.output_item.added`;
- `response.output_item.done`;
- terminal `response.completed` and `response.incomplete` snapshots when they
  carry `response.output`.

The first invalid client tool trips the turn permanently:

- relay no offending event and no later delta, item, completed, or upstream
  `[DONE]`;
- emit exactly one Codex-facing `response.failed` with the same stable guard
  code, then exactly one `[DONE]`;
- do not publish a normal or compact checkpoint;
- do not let a later empty terminal snapshot clear the rejection;
- cancel or drain the upstream only through the existing bounded relay policy;
  do not leave the gateway or client waiting;
- preserve byte-identical output for valid events unless existing alias/model
  normalization already requires a rewrite.

The raw provider event must be authorized before alias restoration. The
checkpoint capture may retain valid provider-wire history as today, but it must
share a request-local rejection verdict with the client relay so observer order
cannot publish a response the client was refused. Do not release a success
`[DONE]` until a valid completed candidate is durably published. A guard failure
does not need a checkpoint and may close with its failure `[DONE]` immediately.

Prefer a narrow Ollama response transform. Change the generic SSE utility only
if focused tests prove a reusable drop/replace primitive preserves all existing
CRLF, comments, malformed-line, line-budget, backpressure, and reference-
equality behavior.

### WP8E — Deterministic conformance and negative controls

Add a compact table-driven suite; do not copy OpenCodex's multi-provider lab.
Classify every case as one of:

- `protocol_conformance`: deterministic fixture against the pinned dialect;
- `live_route_compatibility`: packed gateway against controlled/real upstream;
- `task_effectiveness`: real Codex tool dispatch and continuation.

Required positive fixtures:

- JSON message response with and without exact usage;
- SSE created/delta/item/completed/`[DONE]` sequence;
- declared direct function call;
- declared `tool_search` call;
- promoted V1 and MCP namespace aliases restored to their Codex identities;
- declared tool call checkpoint followed by matching
  `function_call_output` continuation;
- valid stream remains byte-identical outside existing rewrites.

Required negative controls:

- undeclared function call in JSON output;
- undeclared call in `output_item.added`, `output_item.done`, and a
  terminal-only snapshot;
- invalid/empty/non-string call name;
- empty outbound tool catalog followed by a client function call;
- name declared in the original request but removed by final wire collision,
  cap, or filtering;
- invalid event followed by an empty `response.completed` and upstream
  `[DONE]`;
- missing, malformed, duplicate, or contradictory terminal/`[DONE]` shapes;
- `response.failed` and `response.incomplete` handling;
- oversized/control-character tool name and argument-shaped secret markers to
  prove logs remain content-free;
- rejected JSON and SSE turns create no checkpoint and do not change the parent
  checkpoint;
- failure stream contains one `response.failed` and one `[DONE]` only.

Each deliberately broken fixture must fail for the intended stable code, not
merely throw. Fixture digests are optional; add them only if fixtures move to
external files and silent mutation becomes a real review problem.

### WP8F — Performance and compatibility budget

The valid hot path already parses response JSON/SSE for model rewriting,
capture, and alias restoration. Reuse that parse; do not add a second full-body
parse or a second streaming buffer.

Acceptance:

- non-stream response is parsed once and serialized once after validation;
- SSE guard is request-local and bounded by the existing line/body limits;
- declaration storage is `O(number of final tool names)` with no schemas;
- the existing WP5 large SSE fixture has identical output hash;
- G15 measures the guard-on valid path on the same Node/build. A measurable
  regression requires profiling and simplification, not disabling the guard.

### G19 — packed response-integrity acceptance

Run only after isolated typecheck/tests pass and a tarball is packed. Use the
packed CLI in the development home first; global installation and Desktop
reopen remain separately authorized release actions.

Controlled live-route matrix:

1. JSON upstream returns an undeclared function: 502 stable code, zero new
   checkpoint.
2. SSE upstream announces an undeclared function then later completes: client
   sees one failed terminal and one `[DONE]`, no completed event, zero new
   checkpoint.
3. Terminal-only SSE snapshot contains an undeclared function: same failure.
4. Empty tool catalog plus function call and malformed tool names fail closed.
5. A declared direct function, `tool_search`, one promoted V1 alias, and one MCP
   alias pass; restored identities are correct and a second-turn
   `function_call_output` continues from the published checkpoint.
6. Logs contain route/status/code, declaration count/SHA, and rejected-name SHA
   only. Injected newlines, arguments, secret markers, schemas, and response text
   are absent.

The declared positive lane may reuse the same packed-build G12 trace if it
records the new guard/declaration evidence. Negative lanes use a controlled
loopback upstream because asking a model to hallucinate an undeclared tool is
not deterministic. Record the packed cob version, reviewed/observed Ollama
version for each lane, dialect authority version, state-directory before/after
hashes, and root-config SHA when a live-home cut is authorized.

G19 passes only when protocol, live-route, and task-effectiveness layers are
reported separately. A green mock suite is not a live-route pass; a real model
calling a declared tool is not proof that negative controls reject undeclared
ones.

### Rollback and release discipline

- There is no unsafe runtime opt-out.
- If a valid wire alias is falsely rejected, fix the final-catalog collector or
  alias mapping with a reproducing fixture; do not broadly allow unknown names.
- If the SSE implementation regresses framing/backpressure, revert WP8D alone
  while keeping WP8A/B/C fixtures and the non-stream guard when safe.
- No checkpoint schema migration is expected because rejected turns write
  nothing and valid checkpoint values remain unchanged.
- After a fix, rerun typecheck, all tests, pack-manifest checks, G19, and only
  the affected G12/G13/G15/G16 evidence.
- A shipped rollback is another patch version. Do not overwrite or repack the
  same version.
- No npm publish (`private: true`), tag, push, root-config write, or live global
  install is implied by implementation readiness.

## Documentation and release integration

Every behavior package updates the relevant documents in the same change:

- `README.md`: stable user contract and configuration defaults.
- `STATUS.md`: current version matrix, proven gates, and remaining live gaps.
- `LIVE-TESTING.md`: exact G11–G19 procedures, trace fields, redaction, and pass
  criteria.
- `RELEASE.md`: pack/global-install/restart workflow and rollback.
- `CHANGELOG.md`: user-visible changes only after implementation.
- `COMPACTION.md`: only WP7 compaction protocol changes.

The Desktop restart message must say “fully quit and reopen ChatGPT Desktop”; it
must not imply app-server hot reload. `cob status` must distinguish at least:
gateway down, catalog stale, catalog provenance unknown, Ollama unavailable, and
roster overflow.

## Explicitly deferred until measured

These ideas are plausible but are not implementation tasks in this cycle:

- broad async conversion of the filesystem state layer;
- lock-acquire/backoff changes;
- splitting `gateway.ts` solely for structure;
- optimizing Ollama non-stream double serialization;
- persistent cross-request checkpoint caching;
- checkpoint schema v2/delta storage;
- automatic provider retries;
- promoted-tool ordering redesign;
- SSE comment heartbeats;
- public timeout configuration;
- app-process detection or automatic Desktop restart.

Promote one only with a reproducible profile, failure trace, or upstream contract
change and add it to this roadmap before coding.

## Permanently out of scope for this product direction

- OpenCodex `nativeAlias`, `ocx1`, Fernet, or native-model impersonation.
- Root `~/.codex/config.toml` writes from cob.
- Custom model providers for Ollama threads.
- Switching the bridge to Chat Completions or Ollama `/api/chat`.
- Forwarding native encrypted state to Ollama.
- Ollama server-side conversation state.
- Ollama parent spawning GPT children.
- Multi-Agent V2 for Ollama rows.
- `tool_mode: "code_mode_only"` in shipped rows.
- launchd/Login Item/autostart installation.
- Desktop binary patching or private model-cache mutation.

An upstream change may trigger a new research item, but it does not silently
remove these boundaries.

## Execution disposition

WP1–WP8 implementation and the packed isolated G19 gate are complete. Exact
0.1.12 is globally installed after fixing the two Ollama continuation gaps
exposed by the first G11–G17 execution; its listener must be recovered before
more live gates. The graph retains ownership and prevents the fix from being
mistaken for every remaining gate.

```text
WP0 current-build evidence
  ├──> unchanged G8 proof ────────────────────────────────────────┐
  └──> WP1 catalog producer + provenance                         │
         ├──> WP2 search default                                 │
         └──> WP3 Ollama request boundary ──> WP4 timeouts       │
                                                   │              │
                                                   └──> WP5 hot path
                                                          │       │
                                                          └──> WP6 state
                                                                 │
                                                                 ├──> WP7 compact/context
                                                                 └──> WP8 response integrity
                                                                        │
                                     packed 0.1.11 / G19 <─────────────┘
                                               │
                                     live 0.1.11 gate cut
                                               │
                            DONE-less SSE + string replay failures
                                               │
                              packed 0.1.12 real-Ollama PASS
                                               │
                               authorized install + affected reruns
```

Historical review/release units, retained for rollback ownership:

1. WP1 only: catalog provenance and status, with G11.
2. WP2 only: search default and instrumentation, with G12.
3. WP3 only: request allowlist/reasoning/usage/errors, with G13.
4. WP4 only: timeout/backpressure behavior, with G14.
5. WP5A/B/C as separate performance commits; keep only measured G15 wins.
6. WP6A before WP6B/C/D; integrity must precede identity-based speedups; run G16.
7. WP7 stages separately after the unchanged G8 trace, with G17.
8. WP8A dialect authority, then WP8B final tool declarations, WP8C JSON guard,
   WP8D SSE guard, WP8E conformance, and WP8F performance verification. Do not
   start with stream rewriting before the authorization and state-order tests
   exist.

Next execution units:

1. **0.1.11 release/G19 — complete:** exact artifact was installed globally and
   later superseded by 0.1.12; G19 passed 25/25 before installation. No npm
   publish, tag, push, or implicit G11–G17 credit.
2. **First G11–G17 cut — complete as diagnosis:** G11/G12 blocked, G13 partial,
   G14 found the release defect, G15 partial, G16 isolated-pass, G17 not run.
   Exact disposition and evidence live in `LIVE-TESTING.md` and `STATUS.md`.
3. **0.1.12 compatibility candidate — complete:** 43-file SHA-verified tarball,
   340-test merge gate, exact packed runtime real-Ollama stream + continuation
   PASS.
4. **Authorized 0.1.12 global install — complete:** exact artifact was live on
   `:18790` during the cut; health/overlay/root SHA verified; live two-turn
   Ollama smoke passed. The listener was later found down. Desktop was not
   quit/reopened. Remaining G11–G17 were not closed.
5. **Source/catalog/Desktop recovery — complete:** checkpoint `e932eb1`, PATH
   0.149.0, fresh catalog `9748309e…`, full Desktop reopen, picker confirmed,
   host-network `cob: ok`; no native-row repair or release mutation.
6. **G11/G12 evidence closeout — complete:** G11 passed. G12 default-on
   passed live 0.1.12; the false rollback failed there, produced the scoped
   0.1.13 namespace fix, passed on the isolated workspace candidate, and then
   passed against the exact global 0.1.13 artifact.
7. **Authorized 0.1.13 global install — complete:** exact
   tarball `81a99bad…` is live pid **35004**; health/overlay/provenance `ok`;
   install-time root `70b10957…` and catalog `9748309e…` were unchanged.
8. **G14/G17 live closeout — complete:** long cloud stream + continuation +
   abort passed; the fixed 134-item compact corpus passed baseline, `low`,
   `none`, and cloud-max lanes with the disposition above. Current root
   `d24f79f…` and catalog `9748309e…` stayed unchanged; all dev listeners were
   stopped. G13 local remains unavailable; retain G15 WP5A-only and G16
   isolated-pass.

Future fixes should not combine WP1, WP4, WP6, and WP7 failure domains without
independent evidence and rollback points.

## Definition of ready for further changes

The original implementation readiness check is satisfied. Before any further
behavior edit, the implementer must still answer “yes” to all of these:

- The package has a named goal, scope, dependency, tests, live gate, and rollback.
- Its upstream assumptions are pinned to a version or verified current docs.
- It does not require root-config writes, native impersonation, V2 collaboration,
  or a new supervisor.
- Live-home or paid-cloud steps are separated from isolated development and will
  be run only with authorization.
- Existing dirty work is identified and will be preserved.

For the next session, live is global 0.1.13 pid 35004. Never repack 0.1.12 or
0.1.13. G12/G14/G17 are supported by their own traces, not installation,
picker visibility, smoke, or a neighboring gate. Current defaults remain the
G8 policy despite the isolated `none` result.
