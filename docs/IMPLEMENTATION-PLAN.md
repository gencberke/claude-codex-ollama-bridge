# cob Codex — plaintext collaboration wire and Ollama subagent performance

- Date: 2026-09-04
- Status: wire shipped and live; performance work open
- Scope: cob Codex only
- Authority: repository source, `AGENTS.md`, `README.md`, `STATUS.md`,
  `docs/LIVE-TESTING.md`, `docs/RELEASE.md`, and the live traces named below

This plan replaces the completed 2026-09-02 G26 reliability plan. That batch
shipped as 0.3.0 and is summarized in `STATUS.md`; do not reimplement or
revert it.

This document is written to be read cold. An agent joining here should be able
to reconstruct what the problem was, what was measured, what was built, why it
was built that way, and what is still open, without reading the session that
produced it.

---

## 1. The problem this plan exists to solve

cob's product goal is that a native GPT parent agent can drive Ollama Cloud
models as subagents inside Codex / ChatGPT Desktop. Until 2026-09-04 that path
did not work at all on the live gateway, and the repository did not know it.

### 1.1 Root cause, established from 792 live rollouts

**A child thread inherits its parent's `multi_agent_version`. Its own catalog
row is ignored.** Correlation across `~/.codex/sessions`, Codex 0.148.0-alpha.9
through 0.153.0-alpha.5:

| Parent | Child `turn_context.multi_agent_version` | Cases |
| --- | --- | ---: |
| `gpt-5.6-luna` (row v1) | v1 | 14 |
| `gpt-5.6-sol` (row v2) | v2 | 20 |

No exceptions in 34 observations. The `multi_agent_version = "v1"` cob stamps
on every Ollama row (`src/codex/capabilities.ts`, asserted in
`src/codex/catalog/catalog.ts`) governs a *main* thread and does nothing for a
child. The only lever on a child is the parent.

**Consequence.** A ChatGPT-backed V2 parent encrypts the `NEW_TASK` body with
Fernet. The key exists only inside OpenAI. cob refuses to forward encrypted
fields to a provider (`src/codex/encrypted.ts`, reached from
`src/codex/ollama.ts`), so the child dies immediately. On the live home, **19
of 19** Ollama children spawned by a `gpt-5.6-sol` parent died this way, the
earliest on 2026-08-23 under Codex 0.149.0-alpha.4.1. This was never a
regression; it had been broken for the entire period and looked like an
occasional failure rather than a total one.

Meanwhile **16 of 16** Ollama children under a `gpt-5.6-luna` (v1) parent
completed normally, which is why `STATUS.md` had recorded "native GPT parent →
Ollama V1 child" as a validated product path. That record was true only for
luna, and Desktop's default parent is sol.

### 1.2 The two collaboration protocols are two different call planes

This is the detail that makes the rest of the design make sense, and it is not
visible from schemas alone.

| | V2 `collaboration` | V1 `multi_agent_v1__*` |
| --- | --- | --- |
| How the model calls it | first-class namespaced `function_call` | only from inside an `exec` code-mode script |
| How the task reaches the child | `response_item` `agent_message` with an `encrypted_content` part | a plain `message` with `role: "user"` |
| Child gets `agent_path` | yes | no, nickname only |
| `list_agents` | yes | absent |
| `close_agent` / `resume_agent` | absent | yes |

Codex states the boundary to the child itself, in the V2 developer prompt:
*"collaboration tools cannot be called from inside `functions.exec`."*

Observed usage across all rollouts — V2 leaves are used freely, V1 leaves are
used rarely and are sometimes hallucinated because they must be discovered
through `tool_search` first:

- V2: `wait_agent` 851, `send_message` 368, `spawn_agent` 329,
  `list_agents` 231, `followup_task` 73, `interrupt_agent` 46. Zero invented
  leaf names.
- V1: `wait_agent` 125, `spawn_agent` 59, `close_agent` 22, `send_input` 21,
  `resume_agent` 3, plus 5 invented names (~2% of calls).

**Design consequence.** Downgrading the parent to V1 would have cost
`list_agents`, readable `/root/task_name` addressing, and roughly 3.7× less
mid-flight input per child, in exchange for `close_agent`. Keeping V2 and
removing only the encryption costs nothing.

### 1.3 What was already in the repo

`src/codex/experimental/native-plaintext-spawn.ts` already implemented the
right mechanism as a default-off isolated experiment: rewrite the outbound
request so the three encrypted `collaboration` leaves are replaced by
non-reserved top-level aliases whose `message` property is not marked
encrypted, then map the response back to the canonical namespaced identity.
No key is used, nothing is forged, and no ciphertext is ever sent to Ollama.

It was pinned to `gpt-5.6-sol`, pinned to one schema digest recorded under
Codex 0.149, and hard-disabled on the live home.

---

## 2. What was measured, and against what

Every claim below comes from a live trace. Isolated runs used
`~/.codex-cob-dev` on `:18791`; live runs used Desktop on `:18790`.

### 2.1 The schema wire still matches on current Codex

Verification cost zero ChatGPT quota, because
`prepareNativePlaintextSpawn` runs before the upstream call and reports the
observed digest on rejection.

- The structural locator matched on **0.153.0-alpha.5** and again after the
  Desktop update to **0.153.1**: six leaves in exact order, all namespaces,
  `message.encrypted === true`, `target` required. The reject code was
  `native_plaintext_spawn_schema_mismatch`, never `_schema_shape`.
- Digests are **per client context**, not only per Codex build:

  | Client | Digest |
  | --- | --- |
  | `codex exec` CLI | `0fb512ca3ab771bbfc0e848843092082275b8cc25018923271ff3ea51f62e23d` |
  | ChatGPT Desktop | `5e042d4fbf2390b3011d7ec123661cf5c7aa42fb9793e592c3555972f04b56e3` |

  This is not a problem in practice: the live home is Desktop's and the dev
  home is the CLI's, and each has its own `cob.toml`.

### 2.2 The wire works end to end

Isolated, Codex 0.153.0-alpha.5, real ChatGPT upstream and real Ollama:

- The full Gate 6 sequence completed with plaintext child tasks —
  `spawn_agent` → `send_message` → `list_agents` → `send_message` →
  `wait_agent` → `list_agents` → `followup_task` → `wait_agent`. **Two sends
  were in flight before any wait.** All four inter-agent messages arrived as
  `input_text` with Turkish and emoji intact, and the child returned all four
  tokens in order.
- A native child (`gpt-5.6-luna`) spawned through the alias also received a
  plaintext task, which the earlier `ollama/`-only restriction would have
  rejected with a 502.
- A `gpt-5.6-luna` parent, which carries no collaboration namespace, was
  passed through untouched with the wire armed.

Live Desktop, after rotating the digest: a `gpt-5.6-sol` parent spawned
`/root/scan_user_service` on `ollama/deepseek-v4-flash:0731-cloud`; the child
ran 376 rollout lines with **zero Fernet and zero errors** and returned a real
report.

### 2.3 The Gate 6 premise in `UPSTREAM-U1.md` is disproven

That document argues Gate 6 cannot be closed without upstream
`agentControl/*` methods. The gold sequence it defines ran on cob's existing
transport, twice, with no upstream change. The blocker it recorded —
`controller_sequencing_observed` — was the parent model choosing to wait
between sends, and an explicit instruction changed that choice.

---

## 3. What shipped

Two releases, both cut from this workspace and installed globally.

### 3.1 0.3.2 — the plaintext collaboration wire

- **Behaviour-gated, not model-gated.** The model slug is no longer a
  condition. Whichever native model Codex hands the fingerprinted
  `collaboration` namespace is in scope, so a newly listed GPT row works with
  no configuration. A request that never carries the namespace is returned
  byte-for-byte untouched.
- **Closed argument set derived from the pinned schema.** The previous
  hand-listed set allowed only `message` and `model` and therefore rejected
  every real spawn on 0.153, which sends `task_name`, `fork_turns` and
  `reasoning_effort`. The set is still closed; it now follows the digest.
- **No `ollama/` restriction on the child model.** The alias replaces the
  canonical leaf for every spawn on the thread, so the restriction broke
  native-to-native spawn outright.
- **Live homes may opt in, with a pinned digest.** Gate 5 `apply_patch`
  remains isolated-only. An armed-but-unpinned policy is disarmed instead of
  being allowed to reject every turn.
- **Drift degrades on a live home, fails closed in an isolated one.** An
  unrecognized schema is passed through unrewritten on live so one Codex
  update cannot take the Desktop gateway down; an isolated canary keeps the
  loud reject. The Ollama boundary is untouched in both cases.
- **The digest is reportable.** A content-free log line records the observed
  digest, and `cob status` surfaces a stale pin with the exact `cob.toml` key
  to update.

This last point is not cosmetic. The degrade path is silent by construction,
so without the status line an operator cannot tell a working wire from a
disabled one. That exact situation occurred on the first live arming and was
diagnosed in one command.

### 3.2 0.3.3 — development instrumentation

`COB_DEV_MODE=1` implies the existing structured sidecar and adds four
per-request fields to `request_end`:

- `thread_sha8` / `parent_thread_sha8` — a plain unsalted `sha256` prefix of
  the thread id, so an analyst can reproduce it from a rollout's own thread id
  and correlate the two without either record carrying content.
- `cpu_ms` / `rss_mb` — process CPU delta and RSS observed while one request
  is in flight. Concurrent work may contribute; these are not exclusive
  per-request attribution.

The sidecar already recorded `first_event_latency_ms`. **It is not time to
first token.** Measured across 100 live Ollama requests it trails
`headers_latency_ms` by a median of 10 ms (4-58 ms, 88% under 20 ms), because
Ollama emits its first SSE frame with the response headers, before prefill.
The field is therefore time to the first stream chunk, and no prefill /
generation split can be derived from it. Dev mode starts no worker,
makes no provider call, and never fails a request; CPU and memory are read at
points the request already passes through. With the switch off, the hot path
and the human log are byte-identical.

The later workspace hardening adds a content-free process `run_sha8`, closed
request terminals, bounded `error_code`, `non_success_kind`, loss counters for
the diagnostic sink, compaction-to-request correlation, and a read-only `cob
diagnostics [--json]` summarizer. The boundary contract is
[ERROR-HANDLING.md](./ERROR-HANDLING.md). These additions are workspace state,
not evidence for the already-burned 0.3.3 artifact.

---

## 4. The open problem: Ollama subagent performance

Claims in this section carry the labels defined in `AGENTS.md`: **measured**
names its population, **inferred** names the step that could break it,
**proposed** is an intention and never evidence, **superseded** is kept with
what replaced it. The population behind everything below is one artifact's
sidecar — 36 subagent requests on two threads, recorded under 0.3.3 and
preserved at `~/.codex/backups/cob-diagnostics-baseline-20260904.jsonl`. It is
**not** the live population: the 2026-09-05 canary ran 206 Ollama requests of
which only 2 were subagent, and both died before reaching a model, so nothing
in this section has been reproduced on the current artifact.

A live subagent task took 31 minutes for work that was, by measurement,
trivial. Dev mode explains why, and the explanation is not what it looked
like.

### 4.1 Where the time actually goes — measured

Two controlled runs against the same repository, changing one variable each
from the pre-instrumentation baseline (broad task, `reasoning_effort` max):

| Run | Requests | Completed | **Non-success** | Wall | **Lost to failures** |
| --- | ---: | ---: | ---: | ---: | ---: |
| Gate A — broad task, effort `low` | 31 | 26 | **5** | 23.1 min | **17.5 min (76%)** |
| Gate B — narrow task, effort `max` | 5 | 4 | **1** | 4.9 min | **3.2 min (65%)** |

The two populations do not overlap:

```
non-success:  180–254 s   3.65–4.04 MB   no usage reported
completed:      3– 88 s   0.09–0.79 MB   113–282 output tok/s
```

Time to first token is normal on the failures (0.8–3.0 s), so the model starts
answering fine, then streams roughly 4 MB — on the order of tens of thousands
of output tokens, several times the largest successful response — and Ollama
itself emits `response.failed` / `response.incomplete`
(`src/codex/ollama-response-boundary.ts`). cob relays that terminal verbatim
once and never appends a success to it, which is correct.

**These failures are invisible in Codex's own transcript.** The Gate A child
rollout contains 187 items and zero error records: Codex retries silently and
only the successful attempt is written. Without cob's dev-mode diagnostics the
17.5 minutes are unattributable, which is precisely why the instrumentation
was built before the optimization.

### 4.2 Hypotheses, and two claims now superseded

- **RETRACTED — "prefill is 4% of wall time".** That figure was
  `first_event_latency_ms` read as prefill. It is not: see 3.2 above, the
  first SSE frame arrives with the headers. Prefill has never been measured on
  this path, and no claim about where prefill time goes is currently
  supported. `cached_input_tokens: 0` is likewise not evidence of a cache
  miss — Ollama Cloud does not report cached tokens at all (issue #15758 is
  open; PR #17943, in the installed 0.33.3, wires the count from local runners
  only). The prefix-stability claim behind "cob is not defeating any prefix
  cache" was also measured on the wrong object: `instr_sha` / `tools_sha` come
  from `markRequestStart` on the **inbound** payload
  (`src/codex/gateway/responses.ts:491`), while deferred-tool promotion
  happens afterwards in `prepareOllamaWireBounded`
  (`src/codex/ollama.ts:310`). The final Ollama wire has never been
  fingerprinted. Whether the cache helps is **open**.
- **Reasoning effort is not the lever.** Dropping to `low` cut output tokens
  by 66% but doubled tool calls, and total wall time fell only 26%.

Also ruled out as a cob-owned lever: the 43-tool, 48.5 KB tool list resent on
every request. cob never shrinks `tools[]`; it drops the hosted `web_search`
tool and may append discovered leaves (`src/codex/tool-search.ts`).
`supports_search_tool` is a catalog advertisement that the wire code does not
read. The list is Codex's.

### 4.3 The ceiling — installed on live 0.3.5, and a damage limiter only

This is **not** instrumentation: it changes default behaviour on every Ollama
SSE response, and it is live. Treat it as an operator-facing policy under
evaluation, not as the fix for runaway generation — a byte count cannot decide
that a generation failed, and a cut also removes the provider terminal that
would have named the real cause. A cumulative ceiling on the Ollama SSE
response is implemented in `relayOllama` and configurable through `cob.toml` `[limits]
ollama_max_response_bytes` / `COB_OLLAMA_MAX_RESPONSE_BYTES`, default
**2.5 MiB**. A cut emits exactly one cob-owned `response.failed` plus one
`[DONE]` per ERROR-HANDLING rule 5, increments a counter `cob status` reports,
and records request terminal
`overflow` with code `ollama_response_stream_too_large`. This is not a retry
and does not make cob a retry owner — Codex continues to own that.

Two corrections to the earlier proposal, both from the full live sidecar
rather than the 09-04 window alone:

- **1.5 MB is too low.** The 0.79 MB peak holds only for the dev-mode window.
  Across the whole sidecar there is a *completed* 1,632,434-byte response
  (17,760 output tokens). A 1.5 MB ceiling would have cut a real successful
  turn. The measured populations are completed ≤ 1.63 MB and non-success
  ≥ 3.83 MB, so 2.5 MiB sits 1.53× above the largest observed success and
  1.5× below the smallest observed failure.
- **The recovery is partial, not total.** The 65–76% figure is the share of
  wall time *lost*, not the share a ceiling returns: the turn still generates
  everything up to the ceiling before being cut. Modelling the six recorded
  failures at their own observed stream rates: a 2.0 MB ceiling recovers 51%
  of the lost time, 2.5 MB recovers 39%, 3.0 MB recovers 27%. At the shipped
  default that is 8.0 of the 20.7 lost minutes.

Verification is a re-run of the identical Gate A prompt with dev mode on,
comparing non-success duration and confirming no completed turn is cut.

---

## 5. State an incoming agent needs

### 5.1 Live

Verified by a real-environment `cob status` on 2026-09-04 21:26 +03:

- Global cob **0.3.4**, gateway pid 31073 on `127.0.0.1:18790`, health `ok`,
  overlay `ok`, dev mode **on**, plaintext wire **armed** with the pinned
  Desktop digest.
- Desktop is **codex-cli 0.153.1** and catalog provenance is **fresh** again;
  the earlier `stale` disposition is resolved.
- The diagnostic baseline that every measurement in this document rests on is
  preserved at `~/.codex/backups/cob-diagnostics-baseline-20260904.jsonl`.

### 5.2 Workspace

- The 0.3.2/0.3.3/0.3.4 source is committed and pushed on `master`; the exact
  0.3.4 artifact is installed globally and serving the live gateway. A tag,
  push, or GitHub release still requires separate authorization.
- Test counts differ by scope and must not be conflated: the packed 0.3.4
  artifact was cut at **818** (814 pass, 4 skips); the current dirty worktree
  is **820** (816 pass, 4 skips) because it carries the two uncommitted
  ceiling tests.
- The response ceiling above is **workspace source only**: typechecked and
  covered by tests, not packed, installed, or live-canary tested.
- `npx tsc --noEmit` clean, `npm test` 820 tests (816 pass, 4 documented skips).

### 5.3 Where to look

| Question | File |
| --- | --- |
| Request rewrite, response mapping, digest, drift | `src/codex/experimental/native-plaintext-spawn.ts` |
| Where the wire is applied and drift is recorded | `src/codex/gateway/responses.ts` |
| Live-home policy and the isolated/live split | `src/codex/runtime/lifecycle.ts` |
| Dev-mode gate and per-request event shape | `src/codex/diagnostic-event.ts` |
| Stale-digest reporting | `src/codex/runtime/status.ts` |
| Non-success terminal classification | `src/codex/ollama-response-boundary.ts` |
| Response ceiling constant and error | `src/codex/limits.ts` |
| Ollama tool list handling | `src/codex/tool-search.ts` |

### 5.4 How to reproduce the measurement

Two homes, and they must not be mixed. The isolated CLI flow stays in the dev
home end to end:

```bash
COB_DEV_MODE=1 cob start --dev     # isolated ~/.codex-cob-dev on :18791
CODEX_HOME=~/.codex-cob-dev codex --profile cob
```

and reads `~/.codex-cob-dev/cob-diagnostics.jsonl`. Desktop is a separate,
separately authorized live recipe: it always follows `~/.codex` and `:18790`,
so a Desktop-driven run requires replacing the live gateway and reads
`~/.codex/cob-diagnostics.jsonl`.

For either home, Correlate a run by hashing the child's
thread id from its rollout filename with `sha256`, first 8 hex characters, and
filtering `request_end` records on `thread_sha8`. Per request:
`terminal` separates the populations and `cpu_ms` attributes gateway cost.
`first_event_latency_ms` is time to the first stream chunk, **not** prefill —
do not subtract it from `total_latency_ms` and call the remainder generation.

---

## 6. Ollama prompt caching — open, with one measured sub-claim

The efficiency question is separate from the latency one.

**The final wire is stable across a thread except at compaction, measured on
the right object.** The 2026-09-05 canary is the first run with
`request_end.wire`, and it settles a claim that an earlier revision got wrong
by reading `request_start` instead: across 204 Ollama requests on one thread,
the inbound `tools_sha8` differs from the wire `tools_sha8` on **204 of 204**
requests, so the inbound value never was evidence about the wire. On the wire
itself there are 8 transitions in 204 requests, and all 8 are the compaction
summarizer turn entering and leaving (`tools_n` 15 → 0 with a one-item input,
then back). The conversation prefix itself did not change, and `promoted_n`
was 0 throughout, so mid-thread tool promotion still has never been observed.

Two limits on that result: it is one thread on the direct-Ollama main route,
not a subagent thread, and `input_n` is a count rather than a hash of the
retained history — see the fingerprint caveat below.

**Upstream will not tell us the hit rate on Cloud.** Ollama PR #17943 (merged
2026-09-02, first released in **0.33.3**, the installed build) populates
`usage.input_tokens_details.cached_tokens` on `/v1/responses` — but it wires
that from local runners only. Issue #15758, "Cloud doesn't report number of
cached tokens", is still open, and Ollama's cloud path forwards whatever the
backend sends. `extractOllamaUsage` already reads that exact path, so cob
needs no parser change; `usage.cached_input_tokens` and
`prompt_cache_hit_tokens` are not Ollama field names and are harmless extra
fallbacks. The `cached_input_tokens: 0` on every recorded request is therefore
an **observability gap, not evidence of a cache miss**.

**RETRACTED — the "flat TTFT proves a cache hit" inference.** It rested on
`first_event_latency_ms`, which is the first stream chunk, not the first
token; see 3.2. Prefill has never been measured on this path and nothing in
the sidecar measures it.

**Dropping `prompt_cache_key` is not known to cost anything.** Ollama Cloud
caching is implicit and the one report that explicit cache parameters are
accepted and ignored is a community benchmark, not an Ollama guarantee; the
0.33.3 Cloud path is largely raw passthrough, so local converter behaviour
does not generalize to what the Cloud backend does with these fields. Keep
them in `OLLAMA_ADVISORY_FIELDS` — there is no evidence for changing that —
but do not record the decision as proven free.

**What the 0.3.5 wire fingerprint does and does not prove.** It captures
`instr_sha8` / `tools_sha8` / `tools_n` / `input_n` / `bytes` / `promoted_n`
of the exact serialized payload, which is the right object. It is still not a
proof that the whole input prefix was unchanged: `input_n` is a count, not a
hash of the retained history, so a mutation inside an existing item would not
show. A prefix hash is required before any claim that the replayed history was
byte-stable.

Consequently a tool-promotion redesign — freezing the tool set, or a generic
deferred-tool executor — is **not** justified by current evidence. What would
justify it is a measured mid-thread `tools_sha8` change, which cob does not
yet record as a first-class fact.

## 7. Out of scope

- Any cob-owned message queue, scheduler, or retry.
- Advertising `multi_agent_version` other than `v1` on Ollama catalog rows.
  The wire removes encryption from the parent's request; it does not change
  what Ollama rows advertise.
- `nativeAlias`, OpenCodex `ocx1`, Fernet or cob envelopes to Ollama.
- Writing `~/.codex/config.toml`.
- Enabling Gate 5 `apply_patch` on a live home.
- cob Claude, which remains frozen.
