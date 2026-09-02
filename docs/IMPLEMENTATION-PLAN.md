# cob Codex G26 Reliability Implementation Plan

- Date: 2026-09-02
- Status: implemented and live-measured; 0.3.0 source cut prepared, artifact validation pending
- Scope: cob Codex only
- Authority: repository source, `AGENTS.md`, `README.md`, `STATUS.md`,
  `docs/LIVE-TESTING.md`, `docs/RELEASE.md`, exact local protocol evidence,
  and the independent Track A / Track B review completed on 2026-09-02

This plan replaces the 2026-08-31 reliability and contract-hardening plan.
That batch is already present in the dirty workspace and is summarized in
`STATUS.md`; do not reimplement, revert, restyle, or broaden it. The immediate
objective here is to remove the most likely G26 response-failure trigger,
make the next run decisively observable, and keep unrelated upstream
Multi-Agent work outside cob.

## 1. Outcome

The plan has one product-runtime objective:

> Picker-selected Ollama main-agent turns and native-parent → Ollama V1 child
> turns complete without the observed `possible_sse → invalid_json` failures,
> structurally identical resubmissions, hidden transport state, extra provider
> calls, or changes to the supported tool and state contracts.

The first implementation cut will:

1. Remove the exact hosted `web_search` tool definition from every final
   Ollama request while preserving cob's deferred `tool_search` bridge and
   ordinary function tools.
2. Record content-free outbound stream, response content-type, decoder, and
   hosted-tool-drop evidence on the existing request diagnostic pair.
3. Add no retry, fallback provider call, model turn, queue, background worker,
   full-body SSE buffering, or Multi-Agent capability.
4. Leave response sniffing unimplemented unless a new immutable A1 canary
   proves that header/body mismatch remains after the trigger is removed.

The implementation is not itself a production promotion. Workspace tests,
an isolated smoke, a preview artifact, a live replacement, G26-A, G26-B, and
promotion are separate evidence and authorization stages.

## 2. Current evidence and confidence boundary

### 2.1 Observed

- Live `0.2.4-preview.0` routing and same-child continuation passed.
- G26-B recorded 93 child provider requests: 52 HTTP 200
  `possible_sse → invalid_json` outcomes and 41 successes.
- Eleven request fingerprints repeated; one fingerprint occurred 25 times.
- The failed response class had a JSON content-type and an `event:`-shaped
  body. Normal `relayOllama` chooses the SSE path only from the response
  content-type; every other 2xx response is buffered and parsed as JSON.
- cob performs one Ollama fetch per ingress and owns no automatic request
  retry. Failure paths publish no successful continuation checkpoint.
- `web_search_call` is not a reviewed Ollama response capability. cob rejects
  that output kind instead of treating it as a supported client-executed tool.
- The post-preview bounded diagnostic sidecar exists only in workspace source;
  it is not installed in the burned preview and cannot retroactively change
  G26-B evidence.
- The canonical G26 receipt did not expose independent child tool/final trace
  visibility, so it does not prove the identity of any unnamed request tool.

### 2.2 High-confidence inference to test

- The external retained-log review reported a stable tool-set structure with
  one unnamed non-function tool and identified it as Codex's hosted
  `web_search` definition from versioned source behavior. That report is input
  to this plan, not a canonical G26 receipt; the new drop counter must remeasure
  the correlation.
- That definition selects the local Ollama cloud web-search orchestration path,
  whose header commit can preserve `application/json` while its body is SSE.
- The resulting cob 502 is followed by Codex-side structurally identical
  resubmission. The duplicate signatures are evidence of resubmission, not an
  authoritative controller-retry count.

### 2.3 Unknown and not to be rewritten as fact

- Whether every retained body was a complete, valid SSE transcript with one
  valid terminal.
- The exact runtime header-commit order in the installed Ollama daemon.
- The exact hosted-tool identity and count in a new instrumented live run.
- The authoritative Codex controller retry and no-progress counters.
- Provider-internal retry behavior and failed-request token usage.

Implementation and documentation must preserve the labels **observed**,
**inferred**, and **unknown**. A successful fix does not retroactively promote
the historical hypothesis into observed evidence.

## 3. Decisions

### D1 — remove the unsupported trigger first

Implement an unconditional, exact request-tool filter for records whose
`type === "web_search"` on the Ollama route.

Why:

- cob cannot safely consume the corresponding provider output kind;
- the tool does not provide a supported cob capability;
- removing it adds no provider call, model turn, token, or latency stage;
- the change is smaller and more causal than accepting mislabeled responses;
- standalone hosted search and deferred tool discovery are separate routes.

Do not generalize this into an allowlist for every hosted tool. No other
hosted request type has the same current evidence.

### D2 — preserve the two search contracts

The filter must not change either of these:

- `POST /v1/alpha/search`: native ChatGPT-hosted search passthrough, never an
  Ollama request;
- Codex `tool_search`: cob's deferred MCP/collaboration discovery shim, rewritten
  to the fixed Ollama `function` alias and restored on the response path.

A function tool named `web_search` is also not the hosted tool definition and
must not be removed merely because of its name. The match is by exact tool
`type`, not name, substring, description, namespace, or serialized content.

### D3 — add outbound evidence without changing fingerprint ownership

`request_start` remains the record of the inbound decoded request. Its
`request_fp8` continues to hash the path plus original raw body so repeated
ingress can be grouped across the process.

`request_end` gains only outbound/provider-boundary evidence:

- `outbound_stream?: boolean`
- `response_content_type_class?: "absent" | "json" | "sse" | "html" | "text" | "other"`
- `decoder_mode?: "sse_header" | "sse_sniff" | "json"`
- `hosted_tools_dropped_n?: number`

Rules:

- Emit the four fields only where their values are known.
- A request dispatched through `forwardOllamaResponses` records
  `outbound_stream`, response content-type class, and a drop count including
  zero. It records decoder mode when a response parser/relay branch is actually
  selected. This includes ordinary Ollama relay and the Ollama-summarizer
  compaction path.
- Do not infer provider ownership from `route === "ollama"`: native-for-Ollama
  compaction uses the native provider and must not acquire Ollama-only outbound
  or hosted-drop evidence.
- A pre-dispatch rejection has `provider_attempts = 0`; it must not claim an
  upstream response or decoder.
- Native and native-search behavior remains byte-passthrough and does not gain
  Ollama-only fields merely to fill a schema.
- No raw content-type, tool name, tool ID, model name, prompt, output, body,
  error, auth material, or response identifier enters the event.
- `ollama_invalid_json` remains the detailed content-free failure event.
- The additive optional fields keep diagnostic `schema_version: 1`; there is
  no incompatible consumer or meaning change to an existing field.

Do not add `header_body_mismatch` in this package. Without an A2 sniff path it
would be unavailable on the successful hot path. A current mismatch remains
expressible as `response_content_type_class=json`, `decoder_mode=json`,
`terminal=invalid_json`, plus the existing `body_class=possible_sse` event.

### D4 — keep one retry owner

cob continues to make one provider request per ingress. Do not add:

- automatic resend after 502 or invalid JSON;
- retry-after scheduling;
- body repair or completion synthesis;
- controller/no-progress counter inference from duplicate fingerprints;
- queue, admission policy, or background processing.

For a provider-bound request, `provider_attempts = 1` means one initial cob
fetch and therefore zero cob retries. It is not evidence about provider-
internal behavior.

### D5 — normal-relay response sniffing is conditional A2

Do not implement response dialect normalization in the first cut. Open A2 only
if a new immutable A1 canary shows all of the following on the same request:

- `outbound_stream = true`;
- hosted `web_search` was absent from the final wire request;
- the provider response content-type was not SSE;
- the body was still classified as `possible_sse` and failed the JSON decoder.

If opened, A2 may inspect only a bounded initial chunk, restore those exact
bytes to the stream, and use the existing strict SSE transform, terminal
tracker, response guard, and checkpoint publication path. It must not buffer
the full generation, collapse SSE to JSON for `stream=false`, or add a request.

### D6 — Track B remains upstream-owned

This plan makes no cob product change for cross-provider Multi-Agent V2.

Upstream OpenAI Codex owns:

- a target-provider-aware collaboration handoff that yields an appropriate
  plaintext or encrypted task before dispatch;
- or, as a minimum correctness fallback, an explicit unsupported-provider
  failure before an unreadable child is created;
- an experimental/public deterministic AgentControl surface over the existing
  registry and scheduler;
- authoritative retry/reconnect attempt markers.

These are separate workstreams. Deterministic sequencing does not solve
encrypted delivery, and provider-neutral delivery does not prove nested spawn
or the Gate 6 sequence. cob must not decrypt, relay ciphertext to Ollama,
impersonate a native model, enable Ollama V2, add a collaboration queue, or use
an extra GPT recovery turn.

## 4. Immutable scope and safety boundaries

The implementation worker must preserve all of these:

- Work only on cob Codex. Do not touch `src/claude/**` or port `18792`.
- Preserve native request and native compact byte-passthrough.
- Preserve Ollama V1 catalog rows and `multi_agent_version = "v1"`.
- Keep live `apply_patch = false` and `native_plaintext_spawn = false`.
- Do not write root `~/.codex/config.toml`.
- Do not send ChatGPT headers, Fernet, encrypted content, cob envelopes, or
  private collaboration payloads to Ollama.
- Preserve bounded JSON traversal, fail-closed request validation, strict
  response guards, one terminal, one `[DONE]`, and publication-before-release.
- Preserve the default human-readable log and opt-in-only structured sidecar.
- Do not add dependencies, a generic provider framework, a new abstraction
  layer, a broad `responses.ts` extraction, or unrelated cleanup.
- Treat the dirty worktree, deleted legacy files, untracked eval sources, and
  user IDE files as owned baseline work.
- Do not commit, push, tag, publish, pack, install globally, replace `:18790`,
  run Desktop canaries, or change the live home without the separately named
  authorization for that phase.

## 5. Work package WP1 — exact hosted-tool filter

### Owner paths

- `src/codex/tool-search.ts`
- `src/codex/ollama.ts` only where bridge metrics are returned or logged
- `src/tool-search.test.ts`
- `src/ollama-boundary.test.ts` or `src/gateway.test.ts` only for the narrow
  final-wire/fetch assertion

### Required design

1. Add `hostedToolsDroppedN: number` to `ToolSearchBridge`; initialize it to
   zero. Keep it distinct from `skippedUnsupported`, which describes deferred
   leaf promotion and has different semantics.
2. Reuse the existing bounded tool-definition traversal. Do not add an
   unbounded recursive walk.
3. After aliases/collisions are registered and before definitions are rewritten
   or declared, run the wire-tool filter for every tools array, even when
   `blockedAliases.size === 0`.
4. During that traversal, omit only a record with exact
   `tool.type === "web_search"`; increment the counter once per omitted
   definition. Namespace children may be traversed, but a named function leaf
   remains a function regardless of its name.
5. Preserve the existing blocked-alias filtering in the same traversal or an
   equally bounded adjacent step. Do not leave hosted filtering hidden behind
   the current collision-only condition.
6. Run `requestHasToolSearchDefinition`, leaf promotion, history flattening,
   `rewriteToolDefinitions`, the request boundary, and tool declaration on the
   filtered result. The hosted definition must be absent from both the final
   JSON body and `OllamaToolDeclaration`.
7. Add `hosted_tools_dropped_n=<n>` to the existing content-free Ollama wire
   metrics. Do not log the dropped type or any definition bytes.
8. Return the drop count through the existing `bridge`; do not create a second
   request-analysis object.

### Required red regressions

Add the fewest cases that jointly prove:

- With no alias collision, `[web_search, tool_search, function]` becomes the
  expected deferred `tool_search` function plus the ordinary function, and
  `hostedToolsDroppedN === 1`.
- A namespace containing one exact hosted definition plus an ordinary function
  drops the hosted child, preserves the function child and namespace handling,
  and increments the same counter once.
- A function tool whose name is `web_search` is preserved.
- Existing namespaced function flattening and declaration integrity remain
  unchanged.
- The final serialized Ollama fetch body contains no hosted `web_search`, the
  surviving tool count/hash matches the filtered function set, `Accept`
  remains derived from `stream`, and the fake upstream is called exactly once.

Do not snapshot a full tool schema and do not add a new fixture file.

### Acceptance

- The exact hosted definition cannot reach `/v1/responses` on Ollama.
- No supported request or response tool dialect changes.
- One ingress still causes at most one Ollama fetch.
- Diagnostics remain content-free.

## 6. Work package WP2 — outbound and decoder diagnostics

### Owner paths

- `src/codex/diagnostic-event.ts`
- `src/codex/ollama.ts`
- `src/codex/gateway/responses.ts`
- `src/diagnostic-event.test.ts`
- `src/gateway.test.ts`

### Required design

1. Export or introduce one structural content-type classifier so successful
   and failed Ollama responses use the same class vocabulary. Do not persist
   the raw header.
2. Extend `GatewayRequestContext` and the `request_end` event variant with the
   four optional fields from D3.
3. Extend `OllamaForwardResult` with the final boolean stream decision, or set
   that value on the request context at the same final-wire seam. The value
   must come from the sanitized payload actually sent upstream, not the
   inbound payload.
4. After a successful `prepareOllamaWire`, copy
   `bridge.hostedToolsDroppedN` and final stream mode into the request context
   before or immediately after the one fetch. If fetch setup fails, existing
   failure handling remains authoritative; do not manufacture a response
   classification.
5. Set the outbound/drop fields for both ordinary Ollama dispatch and
   `summarize-ollama` compaction, because both call `forwardOllamaResponses`.
   Do not set them for `native-for-ollama` compaction, even though its client
   route is Ollama.
6. When headers return from an Ollama provider fetch, classify and store their
   content type for both success and error statuses. Pass provider ownership
   explicitly at the call seam; do not branch only on `context.route`.
7. Set decoder mode at the actual parser seam:
   - ordinary `relayOllama`: `sse_header` for proper-header SSE and `json` for
     the buffered non-SSE branch;
   - Ollama summarizer: `sse_header`, existing buffered `sse_sniff`, or `json`
     according to `parseSummarizerResponse`;
   - native-for-Ollama compaction: omit the Ollama decoder field.
8. Persist the fields in `request_end`. Keep `request_start` inbound and keep
   its fingerprint, metrics, and privacy behavior unchanged.
9. Do not alter default human log lines. Structured sink failure must remain
   non-failing and must not affect request behavior.

### Required red regressions

- A diagnostic-enabled Ollama request containing private input and the hosted
  tool emits one start/end pair with matching sequence/fingerprint, one
  provider attempt, final stream mode, successful response content-type class,
  decoder mode, and drop count.
- The persisted pair contains neither the private input, raw model slug, hosted
  tool type/name, serialized definitions, nor response body.
- A proper SSE response records `sse` plus `sse_header`; a proper JSON response
  records `json` plus `json`.
- An Ollama-summarizer compaction records its final stream/drop values and the
  decoder actually selected by the existing JSON/SSE-sniff parser.
- A native-for-Ollama compaction records its native provider attempt but no
  Ollama-only stream, hosted-drop, or decoder fields.
- A pre-dispatch Ollama rejection records `provider_attempts = 0` and no false
  response/decoder evidence.
- Native and native-search diagnostic behavior remains unchanged.
- Existing invalid JSON classification still reports `possible_sse` without
  retaining body content.

### Acceptance

The next canary can join each inbound request to its final outbound stream
choice, hosted-tool disposition, provider content-type, decoder selection, and
terminal without reading prompts, tool definitions, or outputs.

## 7. Work package WP3 — documentation reconciliation

Update documentation only after WP1 and WP2 tests are green.

### `README.md`

- State that exact hosted `web_search` definitions are removed from Ollama
  request tools because the corresponding output dialect is unsupported.
- Preserve and clarify the distinction between standalone `/v1/alpha/search`
  and deferred `tool_search`.
- Add the four new optional `request_end` fields to the diagnostic-sidecar
  contract without exposing tool names.

### `docs/LIVE-TESTING.md`

- Extend the future G26 capture matrix with outbound stream, response
  content-type, decoder, and hosted-drop evidence.
- Add the A1 sufficiency predicate from D5.
- Keep historical `0.2.4-preview.0` G26-B evidence unchanged.
- Continue to report controller retry/no-progress as unavailable unless an
  upstream trace or receipt exposes them authoritatively.

### `STATUS.md`

- After workspace verification, advance the current plan-only checkpoint to a
  concise workspace-implemented statement about A1 and diagnostics.
- Do not change the current live version, pid, artifact hashes, root overlay,
  catalog hashes, or gate dispositions before a real authorized run.

### `CHANGELOG.md`

- Add an Unreleased/source entry only if its current convention supports one.
- Do not bump the version in the workspace implementation phase.

### Files not changed by this package

- `docs/RELEASE.md` unless an actual release procedure changes;
- `docs/UPSTREAM-U1.md` unless separately tasked to prepare an upstream patch;
- vault notes, historical deleted plan files, or Claude documentation.

## 8. Work package WP4 — workspace verification

### Narrow checks

Compile once, then run the affected emitted tests:

```text
npm run clean
npx tsc
node --test dist/tool-search.test.js dist/ollama-boundary.test.js
node --test dist/diagnostic-event.test.js dist/gateway.test.js
```

If the test runner or emitted layout differs, use the narrowest equivalent
existing command; do not introduce a new runner.

### Mandatory workspace gates

```text
npx tsc --noEmit
npm test
npm run build
git diff --check
```

Then verify:

- no test, harness, `gate6h`, or `eval-*` file entered the production `dist`
  selection;
- no tarball, diagnostic log, temp home, receipt, or generated IDE file was
  added by the work;
- `git status --short` contains only the user-owned baseline plus the exact
  planned changes;
- no live port, home, config, artifact, or process was touched.

### Workspace definition of done

WP1-WP4 are complete when the targeted and mandatory checks pass, the diff
matches the plan, privacy and one-fetch invariants are re-reviewed, and docs
describe only verified workspace behavior. This authorizes no preview or live
claim.

## 9. Authorization-gated preview and live validation

Each subsection below requires its own explicit authorization when reached.

### Phase P1 — isolated dev smoke

1. Build workspace source.
2. Start only the isolated Codex dev gateway on `127.0.0.1:18791` with
   `CODEX_HOME=~/.codex-cob-dev` and `COB_DIAGNOSTIC_JSONL=1`.
3. Verify mode-0600 bounded JSONL, one start/end pair per model-bearing request,
   the four new fields, default human log compatibility, and cleanup.
4. Do not point Desktop at `:18791`, mutate root config, or infer live gold.

### Phase P2 — immutable preview cut

1. This completed phase used `0.2.4-preview.1`; both preview artifacts are now
   burned and must never be repacked. The next authorized changed cut is
   `0.3.0`.
2. Update version and release notes according to `docs/RELEASE.md`.
3. Run the full workspace gates again, then `npm run pack`.
4. Record tarball file list, version, SHA-256, source state, and rollback
   artifact identity. Pack must exclude tests, harnesses, `gate6h`, and
   `eval-*`.
5. Do not install globally in the same authorization merely because a tarball
   exists.

### Phase P3 — live gateway replacement

Before replacement, record read-only:

- current `cob status` and listener ownership;
- live version and artifact identity;
- root `config.toml`, catalog, and catalog-meta SHA-256;
- PATH and Desktop Codex producer/consumer versions;
- current Ollama client/daemon version;
- rollback artifact SHA-256.

Then follow `docs/RELEASE.md` exactly: stop the existing global owner, install
the immutable preview tarball globally, start global cob on `:18790`, and run
post-install status/health/provenance checks. Root config must remain byte-
identical. Do not restart Claude or enable experiments.

### Phase P4 — G26-A then G26-B — completed 2026-09-02

Run in this order with the sidecar enabled:

1. G26-A: direct picker-selected Ollama main-agent task.
2. G26-B: one native GPT/Luna parent → one Ollama V1 child → same-child
   follow-up.

For every lane retain only the content-free canonical matrix:

- outcome and continuity;
- parent turn count and child continuation count;
- provider request count and status/terminal categories;
- `outbound_stream`, response content-type, decoder, hosted drop count;
- `provider_attempts` and `gateway_retry_count`;
- duplicate fingerprint count and maximum repeat;
- authoritative controller reconnect/retry and no-progress counts when exposed;
- agent-local retry count;
- exact provider-supplied successful usage only;
- parent, child, and total wall time;
- audit completeness and privacy verdict.

Do not store prompts, task/child IDs, model slugs, tool names, arguments,
outputs, or raw errors in the receipt.

Recorded result: direct-main G26-A completed 45/45 Ollama requests and
native-parent→same-child G26-B completed 19/19. All 64 requests returned
`200/200/completed`, used one provider attempt, zero gateway retries, the
`true/sse/sse_header` decoder tuple, and exactly one hosted-tool drop. Invalid
JSON and duplicate fingerprints were both zero. G26-B used one spawn, one
child, one same-child follow-up, and zero fallback. Exact successful usage,
latency, pair completeness, screenshot correlation, and privacy evidence are
recorded in `docs/LIVE-TESTING.md` without retaining task or child identity.

### A1 success criteria

Both lanes require:

- `invalid_json = 0`;
- duplicate fingerprints `= 0`;
- one initial cob provider attempt and zero cob retries per provider-bound
  request;
- `gateway_retry_count = 0`;
- hosted drop count exactly matching requests that actually contained the
  hosted definition;
- for relevant `outbound_stream = true` successes, SSE content-type and
  `sse_header` decoder mode;
- controller retry/reconnect `= 0`, no-progress repeat `= 0`, and agent-local
  retry `= 0` from authoritative or directly observed sources;
- successful routing, same-child continuity, visible usage/latency, and a
  complete content-free audit.

If an authoritative required controller field remains unavailable, record
**NOT GOLD / audit incomplete** even if the functional failures disappear.

### Decision after the canary

- If A1 criteria pass, close the response-dialect work without A2.
- If invalid JSON is zero but duplicates remain, investigate the Codex
  controller/reconnect path; do not add a decoder workaround.
- If the D5 mismatch predicate is observed, open conditional A2 and cut a new
  immutable preview after implementation and tests.
- If failures have a different signature, stop and classify that signature;
  do not force it into the hosted-search hypothesis.
- Never modify a burned preview in place.

Actual decision: the observable A1 transport criteria passed and the D5
mismatch predicate did not occur, so A2 remains closed. The exact hosted-tool
filter is confirmed and no further response-dialect runtime work is indicated.
Strict G26 remains **AUDIT INCOMPLETE / NOT GOLD** only because authoritative
controller retry/reconnect, no-progress, and agent-local retry counters were
unavailable; cob does not infer them from zero duplicate fingerprints.

## 10. Conditional package A2 — bounded response-mode sniff

This package is **BLOCKED BY EVIDENCE** until D5 is satisfied.

### Owner paths

- `src/codex/gateway/responses.ts`
- existing bounded stream/relay helpers only as needed
- `src/gateway.test.ts`
- `src/codex/diagnostic-event.ts` only if normal-relay evidence needs a field
  beyond the already-declared `sse_sniff` mode
- `docs/LIVE-TESTING.md` and `STATUS.md` after verification

### Required design if opened

1. Keep the proper `text/event-stream` hot path byte/latency behavior
   unchanged.
2. For `outbound_stream = true` plus a non-SSE header, read only a bounded
   initial chunk sufficient to classify the first significant framing bytes.
3. Restore the exact peeked bytes in original order to a `Readable`; do not
   discard, duplicate, decode/re-encode, or persist them.
4. If the prefix is an SSE candidate, enter the existing strict Ollama SSE
   transform and set `decoder_mode = sse_sniff`.
5. The existing terminal tracker must still reject malformed JSON frames,
   truncated streams, duplicate/missing/contradictory terminals, unsupported
   tool outputs, traversal overflow, and checkpoint failure.
6. If `outbound_stream = false` and the body is SSE-shaped, fail closed. Do not
   add an SSE-to-JSON collapse path with no current client.
7. Add no provider call, retry, model turn, full-body buffer, or permissive raw
   relay.

### Required regressions if opened

- JSON content-type plus valid SSE: same SSE semantics, one held completed
  terminal, one checkpoint, one client `[DONE]`, one provider fetch.
- JSON content-type plus malformed/truncated/contradictory SSE: exactly one
  fail-closed terminal, no success checkpoint, no retry.
- Proper-header SSE: no sniff-buffer regression and unchanged first-event
  behavior.
- Proper JSON: strict completed-envelope validation remains unchanged.
- `stream=false` plus SSE candidate: deterministic fail-closed JSON error, no
  fabricated completion.
- Diagnostics expose only structural mode/classification fields.

## 11. Upstream Track B workstream

Track B is recorded here for priority and ownership, not as a cob patch set.

### U1 — provider-neutral collaboration handoff

Required upstream contract:

- At the point where the target child provider is known, generate or preserve
  a task representation that the target can consume without cob decrypting or
  calling another model.
- Native/OpenAI delivery may remain encrypted.
- Non-OpenAI delivery must not send Fernet or an opaque backend envelope.
- If secure plaintext delivery is unavailable, reject before registering or
  creating the child.

Do not prematurely prescribe a schema-only conditional: mixed provider pools
and runtime model selection may make the target unknown when the collaboration
tool schema is built. Upstream design must prove when provider identity becomes
authoritative.

Minimum upstream tests:

- native parent → non-OpenAI target receives the exact plaintext task once and
  can complete a deterministic fixture action;
- unsupported delivery creates zero children;
- native target retains its existing encryption/security behavior;
- no extra provider call or model turn is introduced.

### U2 — deterministic AgentControl driver

Expose experimental app-server methods over the existing in-process registry
and scheduler for spawn, send-message, follow-up, wait, list, and later
interrupt. Preserve the semantic difference between queued `send_message` and
turn-starting `followup_task`.

Prove scheduler sequencing first with a native or fake child so encrypted
cross-provider delivery is not a hidden dependency. Then run the separate
cross-provider integration once U1 exists. Do not implement polling,
sequencing, or a second queue in cob.

### U3 — retry/reconnect audit marker

Expose a content-free attempt/reconnect event or receipt field sufficient to
distinguish:

- initial HTTP attempt;
- HTTP transport retry;
- stream reconnect;
- controller logical resend;
- model/agent-local retry.

Until such evidence exists, cob records only provider-boundary attempts and
structurally identical ingress; it must not rename either as controller state.

### V2 stop/restart condition

Keep the product on V1 while the upstream handoff contract is absent. Park V2
product work if the remaining options are fingerprinted aliases, identity
impersonation, ciphertext recovery, an extra model call, or a cob-owned queue.
Reopen the design only around a versioned upstream provider-neutral transport;
Gate 6 sequencing and Gate 10 nested spawn remain separate gates afterward.

## 12. Deferred and unaffected work

This plan does not close or reclassify:

- G24 post-compact/recompact behavior;
- current Gate 5 child-native custom-call/edit gold;
- Gate 6 until an upstream driver exists;
- Gate 7 worktree isolation;
- Gate 10 nested Ollama orchestration;
- G13 local-model coverage;
- Desktop-update durability;
- cob Claude readiness or whole-product production readiness.

Address each in its canonical gate after the G26 Track A decision. Do not use
an A1 pass to promote an unrelated gate.

## 13. Final definition of done

### Implementation complete

- WP1-WP4 acceptance criteria pass.
- Source and documentation contain only the scoped filter and diagnostics.
- No retry, A2 sniff, V2, live, release, Claude, or root-config change occurred.

### Preview validation complete

- An authorized immutable preview contains the verified workspace bytes.
- Isolated smoke proves the sidecar contract and artifact contents.
- Artifact identity and rollback are recorded.

### G26 decision complete

- Authorized G26-A and G26-B receipts contain every observable content-free
  metric and explicitly mark controller-owned counters unavailable.
- The result is classified strictly as observable transport/continuity PASS,
  audit incomplete, NOT GOLD.
- A2 is closed as unnecessary because the exact D5 evidence was absent.

### Production promotion

Production promotion is a later explicit decision. It requires G26 gold for
both supported Ollama surfaces plus a fresh review of the other current gate
dispositions. A functional pass, picker success, isolated fixture, source
test, or preview artifact is not sufficient.
