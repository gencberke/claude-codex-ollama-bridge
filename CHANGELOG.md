# Changelog

Versions follow [semver](https://semver.org/) on the `0.x` line. The 26.818
Desktop hop is in STATUS; do not jump to `1.0.0`. The git tag,
`package.json` `version`, and `cob version` string must match. How to cut a
release: [RELEASE.md](./RELEASE.md).

Ship decisions still follow live traces in [LIVE-TESTING.md](./LIVE-TESTING.md),
not this file.

## 0.2.1 — 2026-08-29

First packed cut of the post-0.2.0 hardening series: the cob Claude security
package plus redacted compact observability. Live claims stay in
[LIVE-TESTING.md](./LIVE-TESTING.md); installing this tarball is not G11/G12
gold.

- cob Claude auth boundary: the static `"cob"` Desktop key is gone. Start
  generates a per-install 256-bit token (0600 regular file), `--desktop`
  writes it into the 3P profile, and only its exact timing-safe match may
  trigger Claude Code keychain injection; missing, stale, or placeholder
  credentials are rejected locally with 401 before the credential reader
  runs. Real Claude OAuth stays byte-faithful passthrough; Ollama routes
  never see Anthropic auth.
- cob Claude process ownership: the runtime records a nonce plus ps start
  identity, health is bound to pid+nonce via the `x-cob-nonce` challenge
  (`nonce_ok` — the secret is never published), stop uses the authenticated
  `POST /cob/shutdown` primitive, and any signal fallback re-verifies
  pid+argv+startKey before TERM and again before KILL, then confirms exit
  before touching state. Unproven ownership fails closed with state kept.
- Runtime state machine `absent | invalid | valid` with pid-sidecar
  consistency. Stop, restore, and start refuse present-but-invalid state
  instead of deleting it; foreground and detached starts make the runtime
  decision, prepare, and commit (overlays included) inside the lifecycle
  lock, and a commit lock timeout reports an explicitly resolvable
  indeterminate state — no signal, no state change.
- Token file hardening: `O_NOFOLLOW|O_NONBLOCK` open, fstat regular-file /
  hardlink / special-bit rejection, and `fchmodSync` on the verified fd.
- `cob claude restore` is one locked transaction (stop locked → surface
  cleanup → overlay restore); the cleanup helper no longer deletes the lock
  file itself.
- Shared `isPidAlive` refuses non-positive and non-integer pids, so cob can
  never issue `kill(0)` or group-wide signals.
- Codex compact: incomplete Ollama handoff logs add `summary_bytes`,
  configured effort, the seven handoff section flags, and exact usage
  counters when available — never summary text, prompt content, tool names,
  or credentials. The G12 gold procedure now requires `fork_turns="none"`,
  explicit child-role prompts, one child/session id,
  `multi_agent_version="v1"`, and a real Ollama wire line; the encrypted-V2
  no-wire rejection is a separate fail-closed boundary canary, not G12
  evidence.
- Workspace-only tooling stays pack-excluded: Gate 6-H harness, G2–G9 eval
  fixtures, and [UPSTREAM-U1.md](./UPSTREAM-U1.md).

## 0.2.0 — 2026-08-27

Public-source cut: one CLI, two surfaces. Same product as 0.1.16 (cob Codex
loopback plus live cob Claude Messages and Desktop picker pin). The version
jump marks that split for GitHub; it is not a Codex `:18790` gateway replace
and does not `npm publish`.

- README install-from-source for a new machine (`npm run pack` then
  `npm install -g` the tarball). `"private": true` stays on.
- No live listener restart. This lab’s global CLI remains 0.1.16 until an
  authorized pack of 0.2.0.

Do not repack 0.1.11–0.1.16.

## 0.1.16 — 2026-08-27

Claude Desktop 3P picker pin on live cob Claude. Codex `:18790` is not
restarted.

- Pin `inferenceModels` to Opus 5 / Sonnet 5 / Haiku 4.5 / Fable 5. Drop
  4.6 ids that discovery listed from cob's `/v1/models`.
- Set `autoModeEnabled` for the permission Auto selector. The 1P
  model-Auto router is not a 3P gateway row; cob does not invent an
  `auto` model id.
- Authorized global CLI install 2026-08-27: tarball SHA-256
  `3826127c96aef5d0016a9876018ec1a4287f9ce61ef3afc905300cdc88fa2560`
  (57 files). cob Claude pid **81560** on `:18792`. Codex pid **54105**
  on `:18790` not restarted. Overlay sha256 `7429a97e…` (snapshot);
  live profile pinned Opus 5 / Sonnet 5 / Haiku 4.5 / Fable 5 with
  `autoModeEnabled=true`. No tag, push, or npm publish.

Do not repack 0.1.11–0.1.15. Codex `:18790` is not restarted.

## 0.1.15 — 2026-08-27

cob Claude goes live as a **second surface**, not as ChatGPT Desktop gold.
`cob start` / `:18790` Codex listener is not restarted by this cut.

- `cob claude start` (global) binds `127.0.0.1:18792` and cob-owned
  `~/.claude-cob`. Native Claude ids pass through to `api.anthropic.com`
  with OAuth forwarded; other model ids go to Ollama `/v1/messages`.
  Claude ids are never rewritten to Ollama.
- Spawn: cob-owned agents + system `cob-route` (not haiku/fable slot
  steal). Ask for `cob-deepseek-0731`. Agent tool still sends a Haiku
  placeholder; cob rewrites allowlisted Ollama tags.
- `cob claude start --desktop` snapshots then writes a cob-owned Claude
  Desktop 3P overlay **and** cob-owned `~/.claude/agents/cob-*.md`.
  Restore reverts both. Never `~/.claude/settings.json`, never
  `ollama launch`, never `ANTHROPIC_AUTH_TOKEN=ollama`.
- Isolated `cob claude start --dev` remains `~/.claude-cob-dev` / `:18793`.
- Ollama `count_tokens` is cob-local (`input_tokens`); Ollama has no that
  path.
- Also ships log-only Codex token-efficiency lines (`b_instr` / compact
  group). Those do not apply until a later authorized `cob start`.
- Authorized global CLI install 2026-08-27: tarball SHA-256
  `6ca55eee23a53fd753d5a3565c4867b9be3979b223443230b75c417aeaa1be6d`
  (57 files). cob Claude pid **75390** on `:18792`. Codex pid **54105**
  on `:18790` not restarted. Overlay sha256 `7429a97e…`. No tag, push,
  or npm publish.

Do not repack 0.1.11–0.1.14.

## 0.1.14 — 2026-08-25

Scoped live cut of fail-closed Ollama JSON/encrypted-wire hardening. Product
remains native GPT + Ollama **V1** child. Isolated Gate 5 `apply_patch` and
`native_plaintext_spawn` stay default-off; live `~/.codex` start forces both
off and drops any stored schema fingerprint. No cob queue, no Ollama V2
catalog, no G6–G10 claim. Do not repack 0.1.11–0.1.13.

- JSON Ollama 2xx bodies are parsed, guarded, and normalized before any
  checkpoint. Invalid JSON, a normalize/identity failure, or a leaked
  apply-patch alias returns a redacted 502 and never relays the raw provider
  body.
- Ollama requests reject non-empty `encrypted_*` fields and recursive
  `gAAAAA` / `ocx1` / `cob1.` prefixes. Empty placeholders are stripped.
- Summarizer HTTP failures log only status, byte count, SHA-8, and latency.
- Tarball excludes tests, harnesses, `gate6h`, and `eval-*`.
- G12/G14/G17 remain 0.1.13 evidence; this cut does not re-claim them.
- Authorized global install 2026-08-25: tarball SHA-256
  `0395b5df04bd30e4cc825c17c1f6de6392a3a2fe17d82becb87a6a1426ad83ec`
  (45 files), pid **54105**, `cob status` `ok`. Root `989c27f9…` and catalog
  `9748309e…` unchanged. cob.toml records `apply_patch = false` and
  `native_plaintext_spawn = false`. No tag, push, or npm publish.

## 0.1.13 — 2026-08-24

G12 explicit-false rollback compatibility for Ollama 0.32.15 namespace tools.
Exact tarball SHA-256
`81a99bad0f645bffcb0bb2551dae3a86dc5cb4dd8869d8a713fe210823fd1c72` is now
the authorized live global (pid **35004**). Isolated-live MCP + V1 rollback
passed before install; the affected rollback later passed against this exact
global artifact. G14 and G17 also closed without repacking. No commit, tag,
push, or publish.

- Ollama's pinned Responses implementation expands a namespace declaration to
  a dot-qualified wire name such as `namespace.function`. cob now snapshots
  that exact final wire identity instead of the unqualified leaf, so the WP8
  undeclared-tool guard authorizes only the function Ollama was actually
  offered.
- Dot-qualified Ollama calls are restored to Codex's separate `name` and
  `namespace` fields before client execution. Replayed namespaced history uses
  the same wire identity, including Ollama's recursive prefix rule.
- Deferred `supports_search_tool=true` promotion is unchanged. The fix is for
  the explicit-false full namespace catalog and does not weaken the empty or
  undeclared catalog guard.
- The first isolated rollback run reproduced the 0.1.12 failure as
  `ollama_undeclared_tool_call`. The corrected 0.1.13 workspace completed one
  real GitHub MCP leaf plus one V1 Ollama child and returned `G12_FALSE_OK`;
  all turns reported `promoted_n=0`, `alias_sha=-`, and
  `used_alias_missing=0`.
- Post-install G12 retrace repeated the real read-only GitHub MCP + V1 child
  lane against exact global 0.1.13 with zero promotions/aliases and no guard
  error. G14 then passed a 10.7s long cloud stream, continuation, and
  abort-without-checkpoint lane. G17 passed its fixed 134-item same-corpus
  comparison: `low` regressed, `none` was the isolated winner, cloud-max was
  accepted by Desktop/PATH with active 256k, and auto-limit remained correctly
  omitted by the native-skeleton guard. Shipped defaults did not change.
- Merge gate: `npx tsc --noEmit`; 344 tests, 341 passed, 3 intentional skips,
  0 failures. The local tarball contains 43 files / 37 production JS files and
  no test or harness JS. Authorized global install replaced 0.1.12 pid 21099;
  root SHA `70b10957…` and catalog SHA `9748309e…` were unchanged at install.
  Later Desktop/user activity established root `d24f79f…`; all closeout gates
  preserved that current baseline and catalog `9748309e…`.

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
