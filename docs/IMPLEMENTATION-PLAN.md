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

The sidecar already recorded `first_event_latency_ms`, which is time to first
token and therefore the prefill/generation split. Dev mode starts no worker,
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

A live subagent task took 31 minutes for work that was, by measurement,
trivial. Dev mode explains why, and the explanation is not what it looked
like.

### 4.1 Where the time actually goes

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

### 4.2 Two hypotheses that the measurement killed

- **Prefill and the zero cache are not the bottleneck.** Prefill is **4%** of
  wall time; 64k input tokens prefill in about 1.9 s. `cached_input_tokens: 0`
  is real and reported by Ollama, and it matters for tokens billed, but it is
  not where the minutes go. cob is not defeating any prefix cache: `instr_sha`
  and `tools_sha` are constant across a run and the input is append-only.
- **Reasoning effort is not the lever.** Dropping to `low` cut output tokens
  by 66% but doubled tool calls, and total wall time fell only 26%.

Also ruled out as a cob-owned lever: the 43-tool, 48.5 KB tool list resent on
every request. cob never shrinks `tools[]`; it drops the hosted `web_search`
tool and may append discovered leaves (`src/codex/tool-search.ts`).
`supports_search_tool` is a catalog advertisement that the wire code does not
read. The list is Codex's.

### 4.3 Proposed next step

Add a configurable ceiling on the Ollama response stream so a runaway
generation fails in seconds rather than minutes. Observed successful responses
peak at 0.79 MB, so a 1.5–2 MB ceiling has ample headroom.

The turn is already lost when this fires; what is recovered is the *duration*
of the loss, which is 65–76% of wall time in both measured runs. This is not a
retry and does not make cob a retry owner — Codex continues to own that.

Measurement is already in place: re-run the identical Gate A prompt with dev
mode on and compare non-success duration.

---

## 5. State an incoming agent needs

### 5.1 Live

- Global cob **0.3.3**, dev mode **on**, plaintext wire **armed** with the
  Desktop digest. `cob status` reports both.
- Desktop updated itself to **codex-cli 0.153.1** mid-session. The wire still
  matches. Catalog provenance is **stale** because the producer binary
  identity changed; the fix is `cob sync`, and Desktop must be fully quit and
  reopened if catalog bytes change.

### 5.2 Workspace

- The source for 0.3.2 and 0.3.3 is **uncommitted**. `RELEASE.md`'s basic cut
  does not require a commit, and none was authorized. A tag, push, or GitHub
  release requires separate authorization.
- `npx tsc --noEmit` clean, `npm test` 804 tests passing.

### 5.3 Where to look

| Question | File |
| --- | --- |
| Request rewrite, response mapping, digest, drift | `src/codex/experimental/native-plaintext-spawn.ts` |
| Where the wire is applied and drift is recorded | `src/codex/gateway/responses.ts` |
| Live-home policy and the isolated/live split | `src/codex/runtime/lifecycle.ts` |
| Dev-mode gate and per-request event shape | `src/codex/diagnostic-event.ts` |
| Stale-digest reporting | `src/codex/runtime/status.ts` |
| Non-success terminal classification | `src/codex/ollama-response-boundary.ts` |
| Ollama tool list handling | `src/codex/tool-search.ts` |

### 5.4 How to reproduce the measurement

```bash
COB_DEV_MODE=1 cob start
cob status          # expect: dev mode on, native plaintext spawn armed
```

Then spawn one Ollama subagent from Desktop and read
`~/.codex/cob-diagnostics.jsonl`. Correlate a run by hashing the child's
thread id from its rollout filename with `sha256`, first 8 hex characters, and
filtering `request_end` records on `thread_sha8`. Per request:
`first_event_latency_ms` is prefill, `total_latency_ms` minus that is
generation, `terminal` separates the populations, and `cpu_ms` attributes
gateway cost.

---

## 6. Out of scope

- Any cob-owned message queue, scheduler, or retry.
- Advertising `multi_agent_version` other than `v1` on Ollama catalog rows.
  The wire removes encryption from the parent's request; it does not change
  what Ollama rows advertise.
- `nativeAlias`, OpenCodex `ocx1`, Fernet or cob envelopes to Ollama.
- Writing `~/.codex/config.toml`.
- Enabling Gate 5 `apply_patch` on a live home.
- cob Claude, which remains frozen.
