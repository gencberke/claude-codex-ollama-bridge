# Live verification

Static `npm test` is a regression gate. It does not prove cob against Codex,
ChatGPT, or Ollama. **Ship decisions follow live traces**, not mock coverage.

Isolation rule for every live run: a temporary `CODEX_HOME` / `COB_CODEX_HOME`
(`cob start --dev`, or `CODEX_HOME=~/.codex-cob-dev`). Never point a trial
gateway at the real `~/.codex` unless the goal is an explicit
restore/config-byte check, and then snapshot `config.toml` first. The globally
installed cob on port 18790 is the ChatGPT Desktop path. Cut that install with
[RELEASE.md](./RELEASE.md).

Official spawn harness (Codex 0.147.0):

- `-p cob` loads `$CODEX_HOME/cob.config.toml`. Do **not** pass
  `--ignore-user-config`; that skips `$CODEX_HOME/config.toml` and can drop
  the cob overlay.
- Isolation is `CODEX_HOME=<temp>` plus a copied `auth.json`.
- Codex `exec` treats an open stdin pipe as more prompt. Spawn with
  `stdio: ["ignore", "pipe", "pipe"]`.

```bash
# L3 — official GPT parent → Ollama child
COB_LIVE_SUBAGENT=1 \
COB_LIVE_SUBAGENT_MODEL=ollama/deepseek-v4-flash:0731-cloud \
npm test -- --test-name-pattern="drives a GPT parent"
```

Optional catalog lie for compaction drills (does **not** change Ollama `n_ctx`):

```bash
COB_LIVE_CONTEXT_WINDOW=8192
```

## Gold standards

A scenario passes only if **all** of its rows are observed on the wire, not
inferred from Codex UI text.

| ID | Must observe | Fail if |
| --- | --- | --- |
| G1 | ≥1 native `/v1/responses` for the GPT parent | Parent answered without cob |
| G2 | ≥1 Ollama `/v1/responses` for the child slug | No child spawn |
| G3 | Ollama request headers ⊆ `{accept, content-type}` (plus hop-safe defaults). No `authorization`, `chatgpt-*`, `x-codex-*`, `x-openai-*` | Any ChatGPT header on Ollama |
| G4 | Ollama body `model` is the unprefixed upstream id | Catalog slug leaked |
| G5 | `encrypted_content` / Fernet never on the **Ollama upstream** request cob emits. A cob `cob1.` envelope **is** allowed Codex-facing and in private `cob-state` | Ciphertext or cob envelope on Ollama, or 400-bypass |
| G6 | Ollama `/compact` hit count = 0 | Any Ollama compact |
| G7 | Ollama-thread terminal `compaction_trigger` → Ollama `/v1/responses` summarizer; trigger not in that body; no legacy `/compact` hit | Trigger routed to ChatGPT native compact (unless `ollama_threads = "native"`) or to Ollama `/compact` |
| G8 | cob envelope reaches Codex; follow-up Ollama `input` is the assistant handoff plus later turns (`replay_ratio << 1`); no envelope/Fernet on Ollama | Full pre-compact replay, ciphertext replay, or developer-note substitution |
| G9 | `cob restore` deletes `cob-state/` and overlays; `config.toml` bytes unchanged | State leftover or root config mutate |
| G10 | Real workspace effect: file created/edited on disk, or a tool call in the Ollama body succeeded | Model claimed a write with no inode change and no tool payload |
| G11 | Packed global cob; sidecar names the Desktop producer and distinct validators; picker + native + Ollama routing after a full Desktop quit-and-reopen; `status` goes non-ready when only the recorded consumer identity is mutated, without spawning Codex; root-config SHA unchanged | Sidecar missing/wrong producer, status stays `ok` on stale identity, or Desktop judged without a full quit |
| G12 | Three-turn Ollama sequence with one deferred MCP leaf and one V1 collaboration leaf; input/tool bytes and alias hashes by turn; explicit false is the rollback control | Picker-only success, missing promotion, or schemas/arguments in logs |
| G13 | Redacted outbound key names and usage keys for one local and one cloud model, plus low/high/max reasoning; a 429 has one upstream attempt and preserved retry metadata | Extra retries, invented usage, ChatGPT headers on Ollama, or user text in logs |
| G14 | Controlled header delay past 30s, one long cloud reasoning turn, and a quiet interval; record header latency vs first-event latency, max gap, timer category, continuation, and one client disconnect without a gateway crash | False idle while the client is backpressured, `connect_timeout` leftovers, or a hung gateway after abort |
| G15 | For each kept hot-path optimization, 30 warm-up + 100 measured iterations of the large catalog/tool/SSE fixture; identical output hash and a repeatable win | Claimed speedup with changed bytes, or a no-op marked as a live pass |
| G16 | Isolated three-turn and compact continuation; tamper value, provenance, and identity separately; each fails closed with full-context recovery and no new checkpoint | Tamper accepted, rewritten in place, or a successful-looking turn that cannot continue |
| G17 | Same 0731 long-task corpus across the default compact policy and each isolated effort/context toggle; record quality, latency, sizes, section flags, and continuation | A toggle becomes default from shrink alone, or quality/cost regresses |
| G18 | Installed cob serves a real `web.run` through exact `POST /v1/alpha/search`; gateway log is content/auth-free, result is usable, no search request reaches Ollama, and root-config SHA is unchanged | Unsupported path, generic proxying, Ollama fallback, secret/query logging, rewritten body/model, or root config mutation |
| G19 | Packed post-0.1.9 cob validates Ollama client tool calls against the exact final outbound catalog for JSON, SSE, terminal-only, direct, `tool_search`, V1, and MCP lanes; rejected turns publish no checkpoint | Unknown/invalid call reaches Codex, a false-positive blocks a declared alias, failure is followed by completed, logs leak content, or rejected state becomes continuable |

Ollama child catalog rows advertise `shell_type=disabled` and no `apply_patch`.
Record what Codex **actually** puts in the child `tools` array (G10). If the
child has no tools, R/W is a parent-tool success plus a correct child artifact;
do not pretend the Ollama model wrote the file.

## Scenario ladder

Run in order. Do not treat a later scenario as done because an earlier one
passed.

### L1 — Isolated lifecycle

Temp `COB_CODEX_HOME`. `cob start` → `GET /healthz` → `GET /v1/models` →
`cob sync` → `cob restore`.

Pass: health `ok`, models list contains native + `ollama/*`, restore removes
profile/catalog/state, root `config.toml` SHA unchanged.

### L2 — `cob smoke --live`

```bash
node dist/cli.js smoke --live
# or, from a checkout, against the isolated home:
node dist/cli.js start --dev
```

Pass: live Ollama ping through the gateway. This is connectivity, not spawn.

### L3 — Official spawn harness

Command above. Pass: G1–G5, child body contains `pong`, `compactHits=0` for
this short prompt. This is the routing gold standard.

### L4 — Real workspace R/W

Temp git repo as `--cd`. Parent `gpt-5.6-luna`, sandbox `workspace-write`
(not the L3 `read-only` harness). Task: spawn the Ollama child to produce a
specific file (content + path), parent applies or the child tools write.

Pass: G1–G5 **and** G10. Capture:

- tool names in the Ollama request
- tool-call success vs model-only prose
- `stat`/`sha256` of the written file before/after
- wall time parent, child, total

### L5 — Live compaction + follow-up

Same isolated home. Set `COB_LIVE_CONTEXT_WINDOW=8192` on the **catalog Codex
reads**. Do **not** lower Ollama `n_ctx`. Grow the **Ollama child thread**
(large file in spawn input, or a second child turn), not only the Luna parent.

Pass: G6–G8. Capture:

- compact request URL = Ollama `/v1/responses` (not ChatGPT, not Ollama `/compact`)
- compact request body has no `compaction_trigger` and no `encrypted_content`
- compact request model is the thread (or `compaction.ollama_model`) unprefixed upstream id
- retired `/v1/responses/compact` hit count = 0
- Codex-visible compact body has exactly one `compaction` item with a `cob1.` envelope; JSON or SSE includes `response.completed`
- raw archive file exists under `cob-state/compact-archive/`
- Ollama-visible follow-up has no envelope/Fernet; item count and bytes are the handoff plus later turns (`replay_ratio << 1`)
- summarizer latency and pre/post Ollama prompt bytes
- whether Codex sent `previous_response_id` or full `input` on follow-up

Desktop 0731 parent `/compact` on this machine (2026-08-19) recorded G7
(summarizer + `cob1.` envelope + replacement history). Isolated L5 remains
an unrun harness.

2026-08-23 20:15 Desktop auto-compact on 0731 (live cob 0.1.6) is a named
G8 failure, not a pass: inbound `compaction_trigger` after `input_n=365`
and 146 tool pairs (decoded ~1.14MB); summarizer outbound `tools_n=0`
`wire_bytes=1121005`; model returned a tool call; cob
`compaction_summary_invalid` / `requires_full_context`; no envelope and no
follow-up.

2026-08-23 20:29 Desktop auto-compact on the same 0731 thread (live cob
0.1.7, pid 49194, `cob_cmp_6bebd81b54f9377ddb3de5bcac3647ff`) is the G8
pass: flatten summarizer `wire_bytes=266304` `tools_n=0`; Codex-facing
`cob1.` compaction item; first continuation `b_input=32885` / `input_n=7`
(`replay_ratio ≈ 0.029` vs trigger `b_input=1121805`); next Ollama wire
`48206` vs last pre-compact wire `1167851` (`≈ 0.041`); later turns kept
the compaction item and grew new tool pairs. Upstream exact tokens were
not logged. Do not treat this as G17. cob **0.1.8** packs Stage 3/4 as
opt-in toggles; the live default stays on that G8 effort, 256k cap, and
threshold until G17.

8k is a test lie. Production catalog cap is **256k** (0.1.2:
`min(tag context_length, 256000)`), not 8k and not unbounded 1M. Desktop’s
context bar is `used / advertised`. On this ChatGPT build a short native GPT
first turn meters ~17–20k (~7% of 258400); the same Desktop harness on 0731
meters ~61k. That 61k was already the 0731 first-turn figure on the old 1M
window (~6% of 996147). Shrinking the catalog window to 256k makes the same
meter read ~26% of 243200. That is not cob merging an older thread.

### L6 — Restart continuity

After a successful Ollama child response, restart **cob** (same `cob-state`
dir). Next Codex turn on that thread.

Pass: if the client sends `previous_response_id`, cob expands it and Ollama
sees merged history with the field stripped. If the client sends full `input`
instead, record that — the DAG is unused on the wire; do not call Codex
`resume --last` a cob-state proof (`resume` is Codex session files).

### L7 — Restore + hygiene

`cob restore`. Pass: G9. Confirm no leftover `cob-state`, gateway port closed,
Ollama daemon policy as you chose for the trial.

## Performance–efficiency curve

Log one row per live child turn. Static tests cannot produce this table.

| Field | Why |
| --- | --- |
| `catalog_window` | Advertised tokens (tag, 8k test, or 256k cap) |
| `pre_compact_input_bytes` | Child context before compact |
| `compact_latency_ms` | Ollama summarizer RTT through cob |
| `post_compact_ollama_input_bytes` | What Ollama actually received |
| `replay_ratio` | `post / pre` — summarize compact should be `<<1` |
| `child_ttft_ms` / `child_total_ms` | Ollama usefulness |
| `parent_total_ms` | End-to-end spawn cost |
| `native_hits` / `ollama_hits` / `compact_hits` | Routing mix |
| `tool_calls` / `tool_ok` | G10 |
| `forbidden_header_count` | Must stay 0 |

Interpret `replay_ratio`:

- `<<1` after Ollama-thread summarize compact: expected (lossy handoff).
- `~1` after `ollama_threads = "native"`: expected full replay, no context win.
- `>1` or missing items: fail, history bug.

Use L5 at 8k to force compact cheaply, then one run near the intended 256k cap
once the 8k path is green. Do not tune cob from mock timings.

## G11 — catalog provenance

**Status — BLOCKED/PARTIAL (live 0.1.11, 2026-08-24):** controlled sidecar
schema-v2, retained last-good catalog, stale/unknown/missing-sidecar status,
no-Codex-spawn, and foreground/detached rollback lanes passed. Live `cob sync`
failed closed because PATH Codex 0.147 rejected the Desktop 0.149 candidate
near `supports_parallel_tool_calls`; therefore successful regeneration plus
Desktop picker/native/Ollama routing was not claimed. Root config SHA stayed
`6ae7ff46867ae81073af18106b49a82f3d19aafc642e80eb263764dd03a9b418`.

Live-home only after explicit authorization. Snapshot the user-owned root
`config.toml` SHA first. Use the packed global tarball, not `dist/cli.js`.

1. `cob start` / `cob sync` on live `~/.codex`.
2. Read `cob-catalog.meta.json`: producer `kind=desktop` names the bundled
   binary; validators include that Desktop file and PATH Codex when they are
   distinct inodes.
3. Fully quit and reopen ChatGPT Desktop. Prove picker, native GPT routing,
   and Ollama routing (G1/G2 still apply).
4. In an isolated copy of the sidecar, change only the recorded consumer
   identity. `cob status` must become `stale` (or `unknown`) with exit 1 and
   must not spawn Codex.
5. Fixture a consumer rejection. The unchanged last-good catalog and redacted
   schema-v2 `last_failure` must survive foreground and detached rollback;
   status names the producer/validator skew without raw validator stderr or a
   Codex subprocess.
6. Regenerate. Status returns to a non-stale first line when the gateway and
   overlay are healthy.
7. Root-config SHA is unchanged.

Redact paths that are not needed; never record credentials or config
contents. Aggregate token counts are allowed.

## G12 — search default

**Status — BLOCKED (live 0.1.11, 2026-08-24):** the required full Desktop
quit/reopen and valid three-turn deferred MCP + V1 function-execution sequence
were not completed. `supports_search_tool=true` remained configured and the
explicit-false rollback was not credited. G18 hosted search is a different
route and does not satisfy this gate.

On the same packed build as G11, after Desktop quit-and-reopen:

1. New/missing cob.toml should advertise search on Ollama rows (`tools_n` near
   the deferred set, not the 168-tool flatten).
2. Run three turns containing one deferred MCP leaf and one V1
   `spawn_agent` leaf. Record input/tool bytes, `alias_sha`,
   `alias_added`/`removed`/`replaced`, `used_alias_missing`, and that the
   function executed.
3. Repeat with `catalog.supports_search_tool = false` as the rollback control.
4. Logs must not contain schemas, arguments, or outputs.

## G13 — Ollama request boundary

**Status — PARTIAL (live 0.1.11, 2026-08-24):** real cloud low/high/max turns
reported exact usage `(13/16/29)`, `(92/16/108)`, and `(105/16/121)` and the
Ollama daemon access log independently recorded the three matching
`POST /v1/responses` calls. The controlled boundary exposed only the pinned
allowlisted keys, preserved a fixture 429 + `Retry-After: 17` with one attempt,
and kept logs redacted. No local model is installed, so the local-model lane
remains unavailable; do not call the whole gate PASS.

Capture redacted outbound key names and response usage keys for one local
model and one cloud model, plus low/high/max reasoning. Force or fixture a
429 at the gateway boundary and prove one upstream attempt and preserved
`Retry-After`. Verify no user text, tool arguments, auth, or private state
is logged.

## G14 — Timeouts and backpressure

**Status — PARTIAL/FIX VERIFIED (0.1.11 live diagnosis; packed isolated 0.1.12,
2026-08-24):** controlled lanes passed: native headers timeout 504 at ~30.0s,
Ollama headers at ~31.0s succeeded under its 240s route deadline, quiet-stream
and scaled idle classification were correct, client disconnect aborted
upstream, and 4×-idle client backpressure did not falsely cancel the source.
Real 0.1.11 Ollama SSE reached `response.completed` but then cob emitted
`upstream_stream_error` because Ollama 0.32.15 closed without upstream
`[DONE]`. Exact packed 0.1.12 (SHA-256
`684db47f34cdafd246699639d1996c79b91a5fd8b048833b7aaa9d15f507dbb6`)
accepted that terminal envelope, checkpointed before one client `[DONE]`,
promoted archived string shorthand for `input[]`, and completed the real
follow-up (HTTP 200); Ollama access-log delta was 2 and checkpoints 1→2.
The same two-turn smoke later passed on live global 0.1.12 `:18790`
(checkpoints 6→8, access-log 295→297). The full long-cloud gate remains
pending.

Use a controlled loopback upstream to delay response headers past 30
seconds, then run a long cloud reasoning turn and a stream with a
deliberate quiet interval. Record response-header latency separately from
first-event latency, maximum inter-event gap, completion state, timer
category (`upstream_headers_timeout` vs `idle_timeout`), and continuation
success. Also disconnect one client and prove upstream cancellation
without a gateway crash.

## G16 — Checkpoint identity

**Status — PASS (isolated 0.1.11, 2026-08-24):** normal three-turn,
compact, and compact-follow-up continuations succeeded. Separate stored value,
provenance, and identity tampering each returned 400
`state_checkpoint_corrupt` with `requires_full_context=true`, published no new
checkpoint, preserved the tampered file for diagnosis, and succeeded after the
original bytes were restored. State directories/checkpoints were 0700/0600.
Temporary dev/fixture listeners were stopped afterward. This is isolated
integrity evidence, not a Desktop live claim.

In the isolated development home, run a normal three-turn continuation
and a compact continuation, then tamper separately with stored value,
provenance, and identity. Each tampered checkpoint must fail closed with
the documented full-context recovery instruction and must not publish a
new checkpoint. Restore the valid fixture and prove continuation still
succeeds. Record checkpoint IDs, hashes, and transitions only.

## G15 — Hot-path reductions

**Status — PARTIAL (0.1.11 benchmark, 2026-08-24):** Node 26.7.0, 30 warm-up
plus 100 measured iterations ×3. WP5A catalog cache preserved the output hash and
improved median from 0.017083ms to 0.002667ms (~84.3%). WP5B metrics preserved
the hash but was ~9% slower (0.048458ms vs 0.044438ms); WP5C SSE was equal at
0.000375ms. Only WP5A has a measured-win claim; G15 is not a blanket PASS.

For each retained optimization, run at least 30 warm-up and 100 measured
iterations of the fixed large-catalog/tool/SSE fixture on the same Node
version. Record median and p95 wall time, output hash, and fast-path hit
rate. Keep the change only if output is identical and the improvement is
outside run-to-run noise. Logs may record hit counts, never event or tool
contents. If there is no measurable live claim, mark G15 not applicable.

## G17 — compact quality / context policy

**Status — NOT RUN (2026-08-24):** no same-corpus comparison was completed.
The default remains omitted effort → wire `high`, 256k active context, no cloud
max advertisement, and no `auto_compact_token_limit`.

Same long-task 0731 corpus for baseline and candidate. Do not claim G17 from
the G8 shrink alone. Isolated Stages 3–4 stay off the live default until this
gate: omit `ollama_effort`, keep the 256k active cap, do not advertise cloud
max, do not emit `auto_compact_token_limit`.

Compare, on the same thread shape:

1. Baseline: current G8 path (omitted effort → wire `high`, 256k/256k).
2. Candidate A: `compaction.ollama_effort = "low"`.
3. Candidate B: `compaction.ollama_effort = "none"` only if 0731 accepts it.
4. Candidate C (separate toggle): `catalog.advertise_cloud_max_context = true`
   with active `context_window` still 256000.
5. Candidate D (separate toggle): isolated `auto_compact_token_limit = 230400`
   only if Desktop and PATH both accept the field.

Record latency, inbound/outbound bytes, exact tokens when Ollama supplies
them, section-presence flags, first continuation size, second continuation,
and task success (constraints, pending work, tool state). Do not log summary
text. An incomplete skeleton must fail closed with
`compaction_summary_incomplete` / `requires_full_context` and must not
trigger a second full-history summarizer call.

Pass only if the candidate preserves or improves task quality and does not
create an unexplained cost regression. Revert the failing toggle only.

## G18 — standalone hosted web search

**Live result — PASS (2026-08-23 22:44–22:50 local):** packed global cob **0.1.9**,
pid **86967**, Desktop Codex producer `0.149.0-alpha.4.1`. A narrow native
`web__run` search returned usable official OpenAI documentation and the page
opened successfully. Gateway evidence was limited to three content-free
`POST /v1/alpha/search ... target=native-search` metric lines; no query,
result, authorization, or account data was recorded. Fake-auth requests to
`/alpha/search`, `/v1/alpha/search/`, and `/v1/alpha/search/child` each returned
404 and left the native-search line count unchanged. The request did not route
to Ollama. Root `config.toml` SHA-256 before and after was
`6ae7ff46867ae81073af18106b49a82f3d19aafc642e80eb263764dd03a9b418`.
This passes G18 only; G11–G17 retain their own procedures.

Run only after an explicit packed global install/live-home authorization. With
`web_search = "indexed"`, issue one narrow `web.run` query from a native GPT
task and verify a usable cited result. Record the cob version, Codex producer,
the content-free `target=native-search` gateway line, final status, and root
config SHA before/after. Do not record authorization, account IDs, query text,
or result bodies.

Then send fake-auth requests only to neighboring local paths
(`/alpha/search`, `/v1/alpha/search/`, `/v1/alpha/search/child`) and prove 404
without an upstream hit. A real search must target the ChatGPT Codex
`/alpha/search` endpoint and must never be translated, retried, or failed over
to Ollama. Keep G12 separate: it proves deferred tool discovery, not hosted web
search.

## G19 — Ollama response integrity and dialect conformance

**Status — PASS (packed isolated 0.1.11, 2026-08-24):** the merge gate passed
(`npx tsc --noEmit`; 337 tests, 334 passed, 3 intentional skips, 0 failures).
The inspected 43-file tarball SHA-256 is
`71b4e3f1963182d73097e5bac0e3ac67cd536e9f7ad5f4301dbca510fdc458db`.
G19 passed **25/25**: 21 `protocol_conformance`, 3
`live_route_compatibility`, and 1 `task_effectiveness` lane. The real Codex CLI
declared and executed `exec_command`, returned its output through a continuation,
and completed successfully. Direct, deferred-search, V1, and MCP aliases were
accepted only after final-wire declaration; every undeclared/malformed/capped/
colliding lane failed closed without a checkpoint. Valid SSE state existed
before success `[DONE]`, and the log guard found no tool name, schema,
arguments, content, or auth disclosure.

The controlled Ollama fixture implemented the reviewed **0.32.15** Responses
dialect; the negative lanes intentionally did not ask a real model to
hallucinate protocol violations. The dev evidence manifest SHA-256 is
`50f5e240fed1dfaac68a02cddbea6ffd84370d842df5345e0ca8bc57b7b78d7a`.
Port 18791 was stopped after the run. Root config SHA-256 remained
`6ae7ff46867ae81073af18106b49a82f3d19aafc642e80eb263764dd03a9b418`.
The gate itself did not credit the then-global 0.1.9. Exact 0.1.11 was later
installed globally in a separate install-only cut; that install is not G19 or
G11–G17 evidence.

Candidate 0.1.10 is a recorded failure, not a releasable artifact: its first
isolated run exposed clear tool names in ordinary ingress/wire diagnostics.
0.1.11 retains aggregate counts/SHA and sorted tool-definition byte sizes but
removes names; the full matrix then passed.

Use the packed CLI in the development home first. Negative lanes use a
controlled loopback Ollama Responses fixture so provider defects are
deterministic; do not prompt a real model to hallucinate an undeclared tool.
The declared positive lane may reuse the same candidate-build G12 trace when it
records all G19 fields.

Record before the run:

- packed cob version and tarball SHA;
- dialect authority version and reviewed Ollama version;
- observed Ollama client/daemon version for the real positive lane;
- isolated state-directory file list/hashes;
- root-config SHA only when a global/live-home cut is separately authorized.

Controlled negative matrix:

1. Final outbound catalog declares `exec_command`; non-stream JSON returns
   `function_call(name="apply_patch")`. Expect HTTP 502 and
   `ollama_undeclared_tool_call`.
2. SSE announces the same undeclared call in `response.output_item.added`, then
   sends argument deltas, an empty `response.completed`, and upstream `[DONE]`.
   Expect one `response.failed`, one `[DONE]`, and no relayed completed/deltas
   after the trip.
3. Repeat with the undeclared call present only in `response.output_item.done`
   and only in the terminal response snapshot.
4. An empty outbound catalog followed by a function call fails closed.
5. Missing, empty, non-string, overlong, control-character, and newline-bearing
   names produce the stable invalid/undeclared code without corrupting SSE or
   logs.
6. A name present in the inbound body but absent from final wire `tools[]`
   because promotion was skipped, capped, or collided is undeclared.
7. For every rejected JSON/SSE turn, the state directory and parent checkpoint
   remain unchanged; the refused response id cannot be resolved.

Positive matrix:

1. One declared direct function call reaches Codex unchanged and its
   `function_call_output` continues from the new checkpoint.
2. Converted `tool_search` is accepted only when its function definition was
   sent on the wire.
3. One promoted V1 alias and one promoted MCP alias are accepted under their
   final wire names, restored to the original namespace/name, executed, and
   continued.
4. Valid JSON and SSE outputs retain their previous bytes/normalized meaning;
   usage may be present or omitted without fabrication.
5. A valid completed stream still publishes the checkpoint before cob releases
   the success `[DONE]`.

Log acceptance:

- allowed fields: route, status, stable code, final declaration count/SHA,
  rejected-name length/SHA, latency, and aggregate sizes;
- forbidden fields: tool name, schema, description, arguments, output, user
  text, response text, auth/account headers, checkpoint content, or injected
  newline fragments.

Report these evidence layers separately:

- `protocol_conformance`: deterministic fixture verdicts;
- `live_route_compatibility`: packed gateway process and controlled/real
  upstream route;
- `task_effectiveness`: real Codex declared-tool execution plus continuation.

Pass requires every negative control to fail for its intended stable code,
every declared lane to pass without false positives, and zero checkpoint
publication for rejected turns. A green unit suite alone is not G19; a real
declared tool call alone does not prove the rejection boundary.

## What static tests are for

Keep `npx tsc --noEmit` and `npm test` as a merge gate (lock, SSE DONE
ordering, ciphertext, catalog hygiene). They do not replace L3–L6. A green
unit suite plus a red L3 is a **product** failure.
