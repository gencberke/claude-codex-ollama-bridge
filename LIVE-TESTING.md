# Live verification

Static `npm test` is a regression gate. It does not prove cob against Codex,
ChatGPT, or Ollama. **Ship decisions follow live traces**, not mock coverage.

Isolation rule for every live run: a temporary `CODEX_HOME` / `COB_CODEX_HOME`
(`cob start --dev`, or `CODEX_HOME=~/.codex-cob-dev`). Never point a trial
gateway at the real `~/.codex` unless the goal is an explicit
restore/config-byte check, and then snapshot `config.toml` first. The globally
installed cob on port 18790 is the ChatGPT Desktop path. Cut that install with
[RELEASE.md](./RELEASE.md). Current live is cob **0.2.0**; the workspace
stabilization diff is not installed there. G12/G14/G17 traces remain
historical **0.1.13** evidence and are not credited to the current live
artifact.

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
| G20 (Gate 5) | In an isolated, explicit opt-in, a real 0731 child receives the declared freeform patch capability, emits a Codex-facing `custom_tool_call(name="apply_patch")` plus matching output, and changes the fixture without a shell write | No custom call/output pair, parent-applied patch, `exec_command`/temporary patch binary/heredoc write, capability on a native/non-spawn/live row, shell enabled, or patch/alias/content leakage |
| G21 (Gate 6) | One isolated 0731 child receives two `send_message` payloads while still active, then two `followup_task` turns after idle/completed, all in one session/id with nonce order preserved | Second spawn, send after the child already completed, wait between the two active sends, duplicate/lost/wrong-id delivery, or Sol `GATE6_PASS` without those child-session rows |
| G21-H (Gate 6-H) | Workspace `npm run gate6h` watches parent/child rollout JSONL; two same-turn `send_message` calls with no wait/list/final between them, then two idle `followup_task` rows on one 0731 child | `controller_sequencing_fail` (wait/list/interrupt/final/exec before send2); three such fails record `controller_sequencing_observed` and `transport_unmeasured`. Do not add a cob queue or open Gate 7–10 |

Ollama child catalog rows advertise `shell_type=disabled` and no
`apply_patch_tool_type` by default. The isolated Gate 5 opt-in may add the
cob-owned `freeform` alias only to configured spawn rows; it does not enable
shell writes or change the V1 child contract. G20 passed in the isolated
2026-08-24 canary: the child session contains one native custom patch
call/output pair and only read-only shell checks; the live gateway, root
overlay, and live catalog were unchanged.
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

**Status — PASS (live 0.1.12, 2026-08-24):** PATH and Desktop 0.149 validate
the same unchanged catalog; provenance is fresh. After a full Desktop reopen,
picker, native luna wire, and Ollama 0731 wire passed. An isolated mutation of
only a recorded validator `mtime_ms` changed `cob: ok` to `cob: stale`, exit 1,
without executing the marker Codex binary. Live root config SHA
`70b109578a83de533fa40e433efb5a4a08892cd675e62a18adbda8f2cf22e776`
and catalog SHA `9748309e…` remained unchanged.

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

**Status — PASS (2026-08-24):** live 0.1.12
completed the deferred GitHub MCP + V1 child sequence with 14 promoted aliases,
stable alias hash, and zero missing used aliases. The isolated explicit-false
control exposed a real 0.1.12 namespace mismatch in the WP8 guard. Workspace
0.1.13 fixes Ollama's dot-qualified namespace wire names and completed the same
real MCP + V1 rollback with no promotion and zero missing aliases. The affected
rollback was then retraced using exact global 0.1.13 on isolated `:18791`: one
read-only GitHub MCP leaf and one V1 0731 child completed, all main/child wire
lines reported `promoted_n=0`, `alias_sha=-`, zero alias mutation/missing-use,
and no guard/upstream error. Root `d24f79…` and catalog `9748309e…` were
unchanged and the dev listener was stopped.
G18 hosted search is a different route and does not satisfy this gate.

On the same packed build as G11, after Desktop quit-and-reopen:

1. New/missing cob.toml should advertise search on Ollama rows (`tools_n` near
   the deferred set, not the 168-tool flatten).
2. Run three turns containing one deferred MCP leaf and one V1
   `spawn_agent` leaf. The spawn must use `fork_turns = "none"`; the child
   prompt must identify the receiver as the child, forbid satisfying inherited
   parent-phase instructions, and require one exact marker. Do not use an
   external/V2 task path as the V1 proof.
3. Record one child/session id, child metadata `multi_agent_version = "v1"`,
   the exact marker, a real Ollama wire line, input/tool bytes, `alias_sha`,
   `alias_added`/`removed`/`replaced`, `used_alias_missing`, and that the
   function executed. An encrypted V2 `agent_message` rejected before Ollama
   wire is a separate fail-closed boundary canary, not G12 evidence.
4. Repeat with `catalog.supports_search_tool = false` as the rollback control,
   using the same child prompt and fork semantics.
5. Logs must not contain schemas, arguments, outputs, or marker text.

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

**Status — PASS (0.1.11 diagnosis; 0.1.12 fix; global 0.1.13 closeout,
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
(checkpoints 6→8, access-log 295→297). On exact global 0.1.13, a finite
20-check high-reasoning cloud stream completed in 10.731s: headers/first event
961/962ms, maximum inter-event gap 270ms, one completed event, one client
`[DONE]`, and usage 582/2981. Continuation completed in 710ms with usage
600/22. A separate abort received its first chunk, left `/health` green, and
published no state file (21→21). Root/catalog hashes were unchanged.

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

**Status — PASS WITH NO DEFAULT CHANGE (global 0.1.13 artifact, isolated homes,
2026-08-24):** every executed lane used the same 134-item, 51,671-byte corpus
(SHA-256 `554c6ece4cdd13fba93e28be323fdc4ba89f23fe51b97ba90060ab41426361a9`),
produced all seven required handoff sections, and retained both exact
constraint/pending-work checks across two continuations.

| Variant | Compact latency | Summary bytes | Compact tokens in/out | First/second Ollama wire | Disposition |
| --- | ---: | ---: | ---: | ---: | --- |
| baseline, omitted → high | 3297ms | 830 | 13896/561 | 1167/1821 B | PASS; shipped default |
| `low` | 4703ms | 852 | 13817/1131 | 1173/1912 B | REJECT; slower and ~2× output |
| `none` | 1488ms | 780 | 13817/225 | 1117/1701 B | PASS; isolated opt-in candidate |
| cloud max, high | 2040ms | 815 | 13896/456 | 1136/1794 B | Schema/quality PASS; presentation opt-in only |

Cloud-max generation was accepted by Desktop 0.149-alpha and PATH 0.149 with
`context_window=256000` and `max_context_window=1048576`. Candidate D was not
run: both current native skeletons omit `auto_compact_token_limit`, so cob's
capability guard correctly omitted the requested `230400` field. The default
therefore remains omitted effort → wire `high`, active 256k, cloud max off,
and auto-limit omitted. A future default change for `none` needs a broader
quality corpus and a separately authorized release; this gate alone does not
mutate 0.1.13 policy.

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

## G20 / Gate 5 — isolated child-native apply_patch

This gate is default-off and may run only with `cob start --dev` plus an
explicit `[catalog] apply_patch = true` in the isolated home. Before starting,
record the root-config and live-catalog SHA values; after stopping, prove they
are unchanged and restore the dev policy bytes.

The configured Ollama spawn row must advertise
`apply_patch_tool_type="freeform"`, `shell_type="disabled"`, and
`multi_agent_version="v1"`. Other Ollama rows receive no patch field and
native rows remain byte-for-byte native. On the wire, Ollama sees only cob's
declared function alias. Codex sees a custom `apply_patch` call and matching
custom output. Malformed/undeclared calls, alias collisions, encrypted fields,
and invalid history fail closed; diagnostics contain no tool name, alias,
patch body, nonce, heredoc, or output.

Gold requires structural child-session evidence and a real filesystem effect:

1. The child emits exactly one completed Codex-facing custom patch call and
   one output with the same call id.
2. The child uses no `exec_command` write, temporary patch binary, heredoc, or
   parent-applied patch. Read-only pre/post inspection is allowed and recorded.
3. The fixture's expected bytes and inode prove the in-place edit; model text
   such as `GATE5_PASS` is corroboration only.
4. The parent only spawns, waits, and verifies; it does not repair the result.
5. Dev `:18791` is stopped and the fixture/dev opt-in are cleaned up. No pack,
   install, Desktop hop, root-config write, or live `:18790` change occurs.

The 2026-08-24 run passed these checks. It does not close repeated messaging,
worktree, nested V2, replay/compact/restart, or Desktop gates.

## G21 / Gate 6 — isolated same-child message queue

This gate reuses the default-off `[experimental] native_plaintext_spawn`
fingerprint. It does not enable `[catalog] apply_patch`. Run only with
`cob start --dev`. Record live root-config and catalog SHA values first.

Gold is structural, not Sol text:

1. Exactly one `collaboration.spawn_agent` and one child session/id.
2. Two `collaboration.send_message` calls on that id with no `wait_agent`
   between them, issued while the child is still running; the child session
   records two `Message Type: MESSAGE` rows before any `FINAL_ANSWER`.
3. After that child is completed/idle, two separate `followup_task` calls on
   the same id, each with its own nonce, processed in order.
4. Child `agent_message` order is spawn task, send1, send2, follow1, follow2
   with exact nonce/Unicode fidelity. Duplicate, lost, overflow, or wrong
   child id fails.
5. Dev `:18791` is stopped afterward. No pack, install, Desktop hop, or live
   `:18790` / root-config change.

The 2026-08-24 canaries failed step 2: Sol inserted `wait_agent` after the
first send, and the 0731 child `FINAL_ANSWER`ed after `SEND1`. A first-pass
parent did eventually issue send2 plus two follow-ups onto the same child
session in nonce order, but send2 was not an active-child queue. Retry
stopped after one send. Isolated Gate 7–10 canaries later ran 2026-08-25
and are recorded below; they are not product gold.

## G21-H / Gate 6-H — sequencing harness

Workspace-only. Not packed. Does not change live `:18790` or add a cob queue.

```bash
npm run gate6h
```

The harness starts isolated `cob start --dev`, runs PATH Codex `exec` with
`gpt-5.6-sol` and the same 0731 fixture (30s child tool window), and reduces
rollout JSONL as a state machine. If `wait_agent`, `list_agents`,
`interrupt_agent`, a parent `final`, or a parent `exec_command` appears before
the second `send_message`, the attempt is killed as
`controller_sequencing_fail`. The same fixture is retried at most three times.
The harness requires `~/.codex/auth.json` and writes its verdict to
`~/.codex-cob-dev/gate6h-verdict.json`.
Isolated Gate 7–10 canaries are separate from this harness.

- Pass: one spawn, two same-turn sends, wait, two follow-ups, child plaintext
  order spawn → send1 → send2 → follow1 → follow2, nonce/Unicode fidelity.
- Three sequencing fails: record `controller_sequencing_observed` plus
  `transport_unmeasured` and wait for upstream portable V2 or a direct
  collaboration driver. Do not implement a cob-side queue. Isolated Gate 7–10
  canaries are recorded separately and are not this harness.
- Any live root-config or live-catalog SHA change is a harness failure.

The 2026-08-24 `npm run gate6h` cut recorded that blocked verdict after three
`controller_sequencing_fail` attempts (wait, wait, then list_agents before
send2). Live catalog SHA was unchanged; isolated `cob.toml` was restored.
Root baseline for later work is `b6ec9273…` (Desktop/user rewrite; harness
pre/post matched). Do not add a cob queue or a fourth Sol canary. Next is
Upstream U1: a model-free Codex collaboration driver for
`spawn → send1 → send2 → wait → followup1 → wait → followup2 → wait`.
0.149 experimental app-server `ClientRequest` has no such method. The
portable proposal is [UPSTREAM-U1.md](./UPSTREAM-U1.md). Do not implement
that driver in cob.

## G22 / Gate 7 — isolated worktree + two native apply_patch

Isolated `[catalog] apply_patch = true` only. Gold needs a distinct git
worktree plus two child-native `apply_patch` edits. The 2026-08-25 canary
failed `worktree_not_distinct`: two native patches landed in the parent
repo cwd. That is not worktree gold.

## G23 / Gate 8 — isolated gateway restart

Two distinct lanes:

- **G8-M** (mid-flight): spawn one 0731 child, issue `wait_agent`, restart
  isolated cob (`stop --dev` then `start --dev`) while the child is still
  running, and prove the same child session completes. The 2026-08-25
  `gate8b_replay` canary passed that check. It is not L6
  `previous_response_id` expand and not compact replay.
- **G8-R** (completed checkpoint replay): one completed checkpoint, epoch A
  stop with the port closed, epoch B start on the same state dir,
  `previous_response_id` expand, exactly one new checkpoint, and a
  provider-safe Ollama body (no `previous_response_id`, cob envelope,
  trigger, or ciphertext). Workspace protocol fixture only until an
  isolated 0731 canary is authorized.

## G24 / Gate 9 — isolated Ollama-thread compact + continuation

Do not count live G8 as this gate. Gold needs a `compaction_trigger` on the
0731 child, a cob summarizer handoff (`cob1.` Codex-facing, none on Ollama),
and two same-child continuations with `replay_ratio << 1`. The workspace
protocol fixture fail-closes incomplete summaries without cob retry; a
later compact-ok without those continuations is
`compaction_continuation_incomplete`, not PASS. The 2026-08-25 8k-catalog
canary triggered compact but failed closed on
`compaction_summary_incomplete` for the spawn turn; a later compact-ok
follow-up did not make the parent wait succeed. Not live G8 gold.

## G25 / Gate 10 — isolated nested V2 / child-originated spawn

Ollama catalog rows stay `multi_agent_version=v1`. Gold would be a depth-2
leaf child with a readable nested task. The 2026-08-25 canary failed closed:
the 0731 child had no `collaboration.spawn_agent` tool (tool_search returned
only GitHub). Do not advertise Ollama V2 to paper over this.

## What static tests are for

Keep `npx tsc --noEmit` and `npm test` as a merge gate (lock, SSE DONE
ordering, ciphertext, catalog hygiene). They do not replace L3–L6. A green
unit suite plus a red L3 is a **product** failure.
