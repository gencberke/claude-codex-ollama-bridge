# Changelog

Versions follow [semver](https://semver.org/) on the `0.x` line. The 26.818
Desktop hop is in STATUS; do not jump to `1.0.0`. The git tag,
`package.json` `version`, and `cob version` string must match. How to cut a
release: [RELEASE.md](./RELEASE.md).

Ship decisions still follow live traces in [LIVE-TESTING.md](./LIVE-TESTING.md),
not this file.

## Unreleased

Source checkpoint for installed cob 0.1.12: `tsc -p tsconfig.build.json`
matches the 43-file tarball production JS byte-for-byte (SHA-256
`684db47f34cdafd246699639d1996c79b91a5fd8b048833b7aaa9d15f507dbb6`).
Packed `README.md` / `CHANGELOG.md` / `RELEASE.md` later recorded the live
`:18790` install and two-turn smoke; those doc-only diffs are in this tree
and do not change the 0.1.12 artifact. Do not repack 0.1.12.

## 0.1.12 — 2026-08-24

Real Ollama 0.32.15 cloud SSE compatibility after the 0.1.11 live gate exposed
that successful streams close after `response.completed` without an upstream
`[DONE]` sentinel.

- Dialect authority v2 records `[DONE]` as optional after a valid completed
  envelope. cob publishes that checkpoint durably, then emits exactly one
  client-facing `[DONE]` so continuation becomes resolvable.
- `response.incomplete`, `response.failed`, malformed streams, guard failures,
  and publication failures remain fail-closed and create no checkpoint.
- When local `previous_response_id` replay expands an earlier top-level string
  into `input[]`, cob promotes that shorthand to a typed user-message item.
  The initial string request remains unchanged. This avoids Ollama 0.32.15's
  `cannot unmarshal string` continuation rejection.
- Added regression coverage for completed-without-DONE publication and
  continuation, string-shorthand replay, plus incomplete-without-DONE
  rejection. This fixes the live
  0.1.11 sequence `response.completed` → `upstream_stream_error` → `[DONE]`
  with no checkpoint.
- Merge gate: `npx tsc --noEmit`; 340 tests, 337 passed, 3 intentional
  skips, 0 failures. The inspected 43-file tarball SHA-256 is
  `684db47f34cdafd246699639d1996c79b91a5fd8b048833b7aaa9d15f507dbb6`.
  Its extracted runtime passed a real Ollama 0.32.15 two-turn gate with one
  client `[DONE]`, checkpoint-before-terminal ordering, HTTP-200 continuation,
  access-log delta 2, and checkpoint transition 1→2. An authorized live
  install of this exact artifact later passed the same two-turn smoke on
  `:18790`.

## 0.1.11 — 2026-08-24

Packed WP8 release candidate after the isolated G19 redaction failure on
0.1.10. G19 passed on this artifact. It was later installed globally for the
live gates, where the DONE-less Ollama SSE gap above was found.

- Standard ingress and Ollama-wire diagnostics retain aggregate byte/count/SHA
  fields and sorted top tool-definition byte sizes, but no longer print tool
  names. Guard logs remain limited to stable code/kind, rejected-name
  length/SHA, and final declaration count/SHA.
- The WP8 dialect, final outbound declaration, JSON/SSE guard, fail-closed
  checkpoint ordering, alias restoration, and continuation behavior are
  otherwise unchanged from the 0.1.10 candidate.
- Merge gate: `npx tsc --noEmit`; 337 tests, 334 passed, 3 intentional skips,
  0 failures. Packed G19 passed 25/25 across protocol conformance, packed route,
  and real Codex declared-tool continuation. The 43-file tarball SHA-256 is
  `71b4e3f1963182d73097e5bac0e3ac67cd536e9f7ad5f4301dbca510fdc458db`.

## 0.1.10 — 2026-08-24

WP8 Ollama response integrity. This packed candidate was rejected by isolated
G19 because standard request/wire diagnostics still printed tool names. It was
never installed globally; live cob remains 0.1.9.

- Versioned Ollama 0.32.15 Responses dialect is the single owner of the request
  allowlist and reviewed client-executed call kinds.
- Each Ollama turn snapshots the final outbound `tools[]` names after promotion
  and allowlisting. Only those names may be called.
- Non-stream JSON validates `output[]` before usage logging, checkpoint
  publication, or client relay. Undeclared or invalid calls return HTTP 502
  (`upstream_error`) and write no checkpoint.
- SSE trips permanently on the first undeclared/invalid client tool in
  `output_item.added` / `done` or a terminal snapshot, emits one
  `response.failed` plus one `[DONE]`, and publishes no state.
- Guard logs keep only code, kind, name length/SHA, and declaration count/SHA.

## 0.1.9 — 2026-08-23

Post-implementation audit fixes for WP1–WP7 plus standalone search routing.
The cut itself is not a G11–G18 live claim; versioned live evidence is tracked
separately in [STATUS.md](./STATUS.md).

- Catalog validation failures are retained as redacted schema-v2 state in
  `cob-catalog.meta.json`, including foreground/detached startup rollback.
  The last-good catalog and provenance stay intact, legacy catalogs remain
  `unknown`, missing catalogs are non-ready, and status stat-checks every
  recorded validator without executing Codex. A successful sync returns the
  sidecar to clean schema v1.
- Ollama drops only `tool_choice = "auto"`; correctness-affecting or malformed
  choices fail closed with a precise 400 error.
- Compact handoffs require exact, ordered, non-empty headings. Prefixes,
  duplicates, malformed Markdown, and empty sections return
  `compaction_summary_incomplete` with full-context recovery guidance and no
  automatic history resend.
- State replay preserves the reference conflict rule for repeated item IDs by
  retaining every previously observed serialized value.
- Deferred-tool telemetry hashes only aliases actually appended in wire order,
  reports append-only add/remove/replace counts truthfully, and checks used
  alias availability against final outbound `tools[]`.
- Exact `POST /v1/alpha/search` requests now pass through to ChatGPT's native
  Codex search endpoint with the existing native auth allowlist, body limits,
  cancellation, and timeout handling. Search never falls back to Ollama;
  unknown `/v1/*` paths remain closed. This is distinct from deferred
  `supports_search_tool` translation.

## 0.1.8 — 2026-08-23

WP7 Stages 2–4 on the 0.1.7 G8 path. Isolated L5 / G11–G17 are still not
claimed. Defaults stay on the proven G8 effort, 256k cap, and threshold.

- Compact summarizer keeps one top-level instruction and requires the
  handoff headings (Goal, Constraints, Completed, Pending, Decisions,
  Tool state, Verification/evidence). `None` is allowed; omission is not.
  The compact-ok log records section-presence flags, never summary text.
- An incomplete handoff skeleton returns `compaction_summary_incomplete`
  and does not resend the full history.
- `compaction.ollama_effort` accepts `none` / `low` / `high` / `max`.
  Omit it to keep the G8 wire (`high`).
- `catalog.advertise_cloud_max_context = true` can expose a verified
  cloud tag's `max_context_window` without raising the 256k active
  `context_window`. Local rows stay conservative.
- `catalog.auto_compact_token_limit` is omitted unless the native
  skeleton already has the field. Isolated experiment value is `230400`.
- `catalog.active_context_window` can raise the active cap; it is never
  inferred from max.

## 0.1.7 — 2026-08-23

Intermediate patch: isolated WP1–WP6 plus the compact summarizer flatten.
Live G8 / G11–G17 are not claimed by this cut.

- Live `cob start` / `sync` generate native catalog rows with Desktop's
  bundled Codex when that home is live macOS; `--dev` stays on
  `COB_CODEX_BIN` / PATH. Every distinct consumer validates the candidate in
  an isolated temporary `CODEX_HOME`.
- `cob-catalog.meta.json` records producer/validators and the catalog SHA.
  A crash between the two files is a detectable mismatch, not false freshness.
- `cob status` first line also uses `stale` and `unknown`. A stale or
  legacy-unprovenanced catalog is non-ready even if the gateway is healthy.
  Status still does not spawn Codex. After a live catalog replacement it
  tells you to fully quit and reopen ChatGPT Desktop.
- V1 roster capacity is reported; overflow names omitted configured slugs.
- `cob restore` deletes the sidecar with the other cob-owned artifacts.
- New and missing `cob.toml` default `[catalog] supports_search_tool = true`.
  An explicit false stays false and is not rewritten. Ollama wire logs add
  alias hash/add/remove/replace counts, never schemas or arguments.
- Ollama requests are clipped to the reviewed 0.32.15 Responses surface.
  Unknown fields 400; advisory fields are dropped, including Codex
  `client_metadata` and `stream_options`. `xhigh` still maps to `high`,
  not `max`. 429 bodies keep `Retry-After` and are not retried.
- Fetch-to-headers is a TTFB deadline (`upstream_headers_timeout`), not a
  TCP connect timer: 30s native, 240s Ollama. Stream idle is 300s and pauses
  while the Codex client applies write backpressure.
- Gateway catalog reads cache the parsed file by inode/mtime/size. Request
  metrics stringify each snapshot field once. Unchanged Ollama SSE events
  keep the original `data:` bytes.
- Checkpoint read recomputes history identity from value and provenance
  and fails closed on mismatch. `sameHistory` then compares identity
  sequences. Merge membership is set/map-keyed. Publish/cleanup reuse one
  checkpoint listing. Clones stay at mutation boundaries.
- Ollama summarizer history flattens `function_call` / `function_call_output`
  to clipped notes. A tool call next to real handoff text is ignored;
  tool-only output still fail-closes and logs `ollama compact failed code=…`.
- `cob start` keeps the last known-good catalog when a detected consumer
  rejects the new candidate (Desktop vs PATH schema skew). `cob sync` still
  fails closed. No sidecar is written for the old implicit catalog.

## 0.1.6 — 2026-08-20

Fail-closed `cob status`, plus the Desktop GPT→0731 gold already on the wire.

- `cob status` first line is `cob: ok|ready|broken|absent|unreadable`. Exit 0
  only when this Codex home needs no action; otherwise exit 1. Default status
  still spawns nothing. Isolated `--dev` homes do not treat a missing root
  config as `absent`.
- Ollama children stay V1. Parent spawn policy is user-owned
  `~/.codex/AGENTS.md`; cob does not write that file or `agents/*.toml`.
- Thinking catalog default remains `high` (`max` is still advertised).
- Post-ship same evening: Desktop **26.818.22352** / `0.148.0-alpha.21` kept
  picker, native parent, and 0731 V1 child on this gateway. Overlay keys and
  user-owned `[agents]` defaults survived the app rewrite.

## 0.1.5 — 2026-08-20

Ollama-callable deferred tools after `tool_search`. Opt-in catalog flag unchanged.

- When an Ollama request includes a `tool_search` definition, cob promotes
  leaf functions from this request's `tool_search_output` history into the
  next Ollama `tools[]` as namespace-aware aliases (`multi_agent_v1__spawn_agent`,
  `mcp__codex_apps__github___search_issues`). Caps: 16 leaves or 32KiB.
- Inbound aliases restore Codex `{name, namespace}`. Only unnamespaced
  `tool_search` becomes `tool_search_call` (`execution = "client"`).
- Ingress request metrics stay on the Codex body. A second `ollama wire`
  line logs post-sanitize `tools_n` / `promoted_n` without schemas.
- Live 0731 (2026-08-20 11:05): ping ~11k, Direct `ls` ~13k, unaided
  `spawn_agent` child (parent ~24k / child ~12k). GitHub MCP `_search_issues`
  dispatched after an explicit prompt; first issue-list turn still used `gh`.

## 0.1.4 — 2026-08-20

Opt-in Desktop tool deferral for Ollama rows, plus a cob `tool_search` shim.
Default remains off.

- `cob.toml` `[catalog] supports_search_tool = true` makes Ollama catalog rows
  advertise `supports_search_tool`. Desktop then defers MCP behind `tool_search`
  (live 0731 ping: `tools_n` 168→17, `last_in` 52927→11819). Default `false`.
- Gateway translates Codex `tool_search` / `tool_search_call` /
  `tool_search_output` to Ollama function tools on the way out, and
  `function_call` name `tool_search` back to `tool_search_call` with
  `execution = "client"` on the way in ([openai/codex#20574](https://github.com/openai/codex/issues/20574)).
- Do not set `tool_mode`. Do not hand-edit `cob-catalog.json`; `cob start` /
  `sync` rebuild the catalog from this flag.

## 0.1.3 — 2026-08-20

Numeric Ollama request accounting. No body dump, no catalog or tool-surface
change.

- Gateway log lines for `POST /v1/responses` add decoded byte buckets
  (`b_tools`, `b_input`, `b_instr`, …), `tools_n`, `input_by` type counts,
  8-hex `tools_sha` / `instr_sha`, and `effort`. Tool names and sizes only —
  never schemas, user text, or `previous_response_id` values.
- After an Ollama completion, a second line logs `usage` (`in` / `out` /
  `cache` / `prompt_eval_ms`) when the upstream envelope includes it.

## 0.1.2 — 2026-08-20

Picker and catalog polish. Not native GPT gold, G8, or durability.

- Desktop/CLI picker **lists** `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`,
  then spawnable Ollama (default `ollama/deepseek-v4-flash:0731-cloud`). Other
  native and discovered Ollama rows stay in the catalog with `visibility=hide`.
- Ollama `display_name` equals the catalog slug (`ollama/...`). No `nativeAlias`.
- Thinking Ollama rows advertise `none` / `low` / `high` / `max` (default
  `high`). Codex leftover `medium` / `xhigh` map to `high` on the Ollama wire.
- Advertised Ollama `context_window` is `min(tag context_length, 256000)`.
  Desktop’s context bar is `used / advertised`; a short 0731 first turn still
  meters ~61k (was ~6% of 1M, ~26% of 256k). That is not previous-chat leakage.

## 0.1.1 — 2026-08-19

- `cob version` / `cob status` follow the Homebrew/npm `bin/cob` symlink to the
  packed `package.json`. 0.1.0 printed `cob 0.0.0 (unknown)` on
  `/opt/homebrew/bin/cob`.

## 0.1.0 — 2026-08-19

First versioned tarball (`codex-ollama-bridge-0.1.0.tgz`). Intended live
install: `npm install -g` then `cob start` on `127.0.0.1:18790`.

### Gateway

- Loopback `/v1/responses`: native catalog slugs stay on ChatGPT auth; `ollama/*`
  goes to local Ollama Responses. No Chat Completions translator.
- cob never writes `~/.codex/config.toml`. CLI/TUI: `codex --profile cob` →
  `cob.config.toml`. Desktop overlay remains user-owned on this machine.
- Ollama threads: terminal `compaction_trigger` → Ollama `/v1/responses`
  summarizer (never Ollama `/compact`). Codex-facing `cob1.` envelope; follow-up
  is assistant handoff + later turns. Native GPT compact stays ChatGPT
  passthrough.
- Workspace `cob start` / `stop` / `restore` / `sync` refuse live `~/.codex`
  unless `--live-home`. `cob start --dev` uses `~/.codex-cob-dev` and port 18791.

### Proven on this machine (not a completeness claim)

- Desktop picker listed `ollama/deepseek-v4-flash:0731-cloud` after user-owned
  root overlay keys.
- 0731 parent turns reach cob `target=ollama`.
- Desktop `/compact` on 0731 recorded G7 (summarizer + `cob1.` + replacement
  history). G8 `replay_ratio` and isolated L5 are still open. Summarizer text
  on that run was source-like, not a recap.

### Not in this release

- ChatGPT quit–reopen / `codex update` durability
- Native GPT gold after the 2026-08-19 quota block
- Native GPT parent → Ollama V1 child on Desktop
- Ollama parent → GPT child (out of product)
- Public npm publish (`private: true`)
- Homebrew / fat binary

### Pack

- `npm run pack` → production `tsc` (`tsconfig.build.json`, tests excluded) +
  `npm pack`. Tarball has no `*.test.js` / `*.harness.js`. Includes README,
  CHANGELOG, RELEASE, LICENSE, NOTICE.
