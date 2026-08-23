# Roadmap — implementation plan

**Date:** 2026-08-23
**Status:** cob 0.1.7 packs isolated WP1–WP6 plus summarizer flatten; WP7 is blocked on live G8
**Next live package:** G8 on installed 0.1.7 (handoff + shrink), then WP7; G11–G16 still need live traces

This document is the implementation contract for the next development cycle.
It replaces the earlier proposal list with decisions verified against the current
code, the current Codex Desktop/CLI installation, and upstream documentation.

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
- Globally installed cob: `0.1.6` at `/opt/homebrew/bin/cob`; gateway pid
  `39122` on `127.0.0.1:18790` reported health `ok`.
- Ollama client: `0.32.15`; daemon answered `ollama ps` with an empty table.
- Live `cob-catalog.json` SHA-256
  `07c189597516dec8ec8fa7e04c6a7179a0a460f8935f056db44710188731b016`
  (mtime 17:35, before the 18:22 Desktop binary). There is no
  `cob-catalog.meta.json` sidecar, so provenance is unknown to unreleased WP1.
- Live `cob status` first line was `cob: ok` (installed 0.1.6 cannot emit
  `stale` / `unknown`). Overlay still `ok`. Isolated `--dev` home was absent.
- Isolated merge gate after WP1–WP6 plus the G8 tool-call fail-closed
  lock and remaining isolated fixtures: `npx tsc --noEmit` and `npm test`
  (284 passed, 0 failed, 3 skipped).
- The highest-value unresolved live proof remains current-build G8 compact
  shrink. **2026-08-23 20:15** identified the failure stage: after a correct
  no-tools summarizer request (`tools_n=0`, `wire_bytes=1121005`) on a
  0731 auto-compact (`input_n=365`, 146 tool pairs, decoded ~1.14MB), the
  model called a tool and cob fail-closed with `compaction_summary_invalid`
  / `requires_full_context`. No handoff, no follow-up, no `replay_ratio`.
  Mock coverage is not a substitute for a later successful shrink trace.

This version skew is not proof of a current picker failure. It is proof that the
catalog's producer and provenance are currently implicit, so a future update can
silently leave Desktop on stale model semantics.

## Code evidence map

Isolated WP1–WP6 are in the working tree. The remaining live-proof points:

- Catalog producer/sidecar/status kinds are implemented (`catalog-provenance.ts`).
  Live 0.1.6 still cannot emit `stale` / `unknown`; G11 needs a packed install.
- Search defaults on; newest-first promotion is unchanged. G12 is unrun.
- Ollama allowlist is pinned to 0.32.15 `ResponsesRequest` fields. G13 is unrun.
- Headers/idle/backpressure split is implemented. G14 is unrun.
- Catalog file-identity cache, one-stringify metrics, and SSE reference-equality
  passthrough are isolated-only. G15 is not a live claim.
- Checkpoint identity is recomputed on read. G16 is unrun.
- G8 failed at summarizer extract on 2026-08-23 (tool call after `tools_n=0`).
  WP7 Stages 2–4 stay blocked.

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

## Decision register

| Proposal | Decision | Reason |
| --- | --- | --- |
| Keep the loopback dual route | **Keep** | It is the working, Codex-native boundary. |
| Generate the live catalog with Desktop's bundled Codex | **Do first** | Desktop consumes the file and can run a newer schema than PATH Codex. |
| Persist catalog provenance and detect staleness | **Do first** | Current `status` cannot explain producer/version skew. |
| Default search support to true | **Do after current-build live proof** | It reduces tool-schema input cost and the shim already exists. |
| Make promoted tools chronological/first-come | **Reject as written** | It can pin stale schemas and starve newer relevant tools. Measure before redesigning order. |
| Raise all Ollama rows to a 1M active context | **Reject as default** | It increases paid input and delays lossy compaction without proven quality gain. |
| Expose a verified cloud maximum separately | **Conditional** | Safe only after cross-client schema and G8/G17 proof. |
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
| Rewrite compaction immediately | **Defer until current G8** | First establish live shrink and continuation on the unchanged path. |

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

## WP2 — Make tool deferral the safe default

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
snapshot to log formatters. Preserve the live per-tool byte breakdown used to
diagnose schema bloat. If high-cardinality details are hidden behind debug mode,
keep aggregate counts and the top offenders available in the standard redacted
log.

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

Current unchanged-path blocker (2026-08-23 20:15, live cob 0.1.6): the
summarizer request already omitted `tools` (`tools_n=0`) and the model still
returned a tool call. cob fail-closed. Unreleased in-tree now flattens
function-call history to notes and keeps mixed handoff text; that is not a
prompt/effort/threshold change and is not live until a packed global
install. Do not start Stages 2–4 until a later run on the installed build
produces a text handoff and a measured follow-up shrink.

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
`low` against the current behavior. The likely candidate is `low`, but no
default changes without a quality/latency trace. A malformed or incomplete
skeleton fails closed with `requires_full_context`; do not automatically resend
the full history because that doubles the most expensive input.

### Stage 4 — Separate maximum from active threshold

Keep the default active context at 256k during the experiment.

- For verified cloud tags, test exposing their actual supported
  `max_context_window` without changing the active compact threshold.
- Keep local model rows conservative unless their runtime/tag proves a larger
  limit.
- Test the current Desktop and PATH schemas before adding
  `auto_compact_token_limit`; bundled rows currently omit it even though the
  field exists in Codex internals.
- If an explicit threshold is needed to preserve current behavior, begin near
  90% of 256k (`230400`) and verify it in an isolated catalog.
- Larger active contexts are opt-in until G17 shows lower total cost or materially
  better task success. Never infer benefit from maximum context alone.

### G17 — live acceptance

Use the same long task corpus for baseline and candidate. Compare task success,
constraint retention, compact latency, total input/output tokens, first
continuation size, and a second continuation. Pass only if the candidate
preserves or improves task quality and does not create an unexplained cost
regression.

### Rollback

Prompt, effort, maximum advertisement, and active threshold are separate toggles.
Revert the failing dimension only; retain the proven current G8 path.

## Documentation and release integration

Every behavior package updates the relevant documents in the same change:

- `README.md`: stable user contract and configuration defaults.
- `STATUS.md`: current version matrix, proven gates, and remaining live gaps.
- `LIVE-TESTING.md`: exact G11–G17 procedures, trace fields, redaction, and pass
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

## Execution order

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
                                                                 └──> WP7 compact/context
```

Recommended review/release units:

1. WP1 only: catalog provenance and status, with G11.
2. WP2 only: search default and instrumentation, with G12.
3. WP3 only: request allowlist/reasoning/usage/errors, with G13.
4. WP4 only: timeout/backpressure behavior, with G14.
5. WP5A/B/C as separate performance commits; keep only measured G15 wins.
6. WP6A before WP6B/C/D; integrity must precede identity-based speedups; run G16.
7. WP7 stages separately after the unchanged G8 trace, with G17.

Do not combine WP1, WP4, WP6, and WP7 into one release. They touch independent
failure domains and need independent rollback.

## Definition of ready for implementation

The roadmap is ready to execute when the implementer can answer “yes” to all of
these before editing code:

- The package has a named goal, scope, dependency, tests, live gate, and rollback.
- Its upstream assumptions are pinned to a version or verified current docs.
- It does not require root-config writes, native impersonation, V2 collaboration,
  or a new supervisor.
- Live-home or paid-cloud steps are separated from isolated development and will
  be run only with authorization.
- Existing dirty work is identified and will be preserved.

For the next session, begin with **WP1**. Do not start WP2–WP7 until WP1's
catalog/status behavior is implemented and the merge gates pass. If G11 is
blocked only by live-home or cloud authorization, record that as the sole live
blocker and continue with isolated work; do not claim the package is live-proven.
