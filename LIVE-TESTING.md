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
(summarizer + `cob1.` envelope + replacement history). Isolated L5 and G8
`replay_ratio` on the next turn remain the live shrink gate.

2026-08-23 20:15 Desktop auto-compact on 0731 (live cob 0.1.6) is a named
G8 failure, not a pass: inbound `compaction_trigger` after `input_n=365`
and 146 tool pairs (decoded ~1.14MB); summarizer outbound `tools_n=0`
`wire_bytes=1121005`; model returned a tool call; cob
`compaction_summary_invalid` / `requires_full_context`; no envelope and no
follow-up. Record `pre_compact_input_bytes`, summarizer `tools_n`, extract
code, and whether a checkpoint was published. Do not change prompt, effort,
256k cap, or threshold on the next unchanged-path retry.

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
5. Regenerate. Status returns to a non-stale first line when the gateway and
   overlay are healthy.
6. Root-config SHA is unchanged.

Redact paths that are not needed; never record credentials or config
contents. Aggregate token counts are allowed.

## G12 — search default

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

Capture redacted outbound key names and response usage keys for one local
model and one cloud model, plus low/high/max reasoning. Force or fixture a
429 at the gateway boundary and prove one upstream attempt and preserved
`Retry-After`. Verify no user text, tool arguments, auth, or private state
is logged.

## G14 — Timeouts and backpressure

Use a controlled loopback upstream to delay response headers past 30
seconds, then run a long cloud reasoning turn and a stream with a
deliberate quiet interval. Record response-header latency separately from
first-event latency, maximum inter-event gap, completion state, timer
category (`upstream_headers_timeout` vs `idle_timeout`), and continuation
success. Also disconnect one client and prove upstream cancellation
without a gateway crash.

## G16 — Checkpoint identity

In the isolated development home, run a normal three-turn continuation
and a compact continuation, then tamper separately with stored value,
provenance, and identity. Each tampered checkpoint must fail closed with
the documented full-context recovery instruction and must not publish a
new checkpoint. Restore the valid fixture and prove continuation still
succeeds. Record checkpoint IDs, hashes, and transitions only.

## G15 — Hot-path reductions

For each retained optimization, run at least 30 warm-up and 100 measured
iterations of the fixed large-catalog/tool/SSE fixture on the same Node
version. Record median and p95 wall time, output hash, and fast-path hit
rate. Keep the change only if output is identical and the improvement is
outside run-to-run noise. Logs may record hit counts, never event or tool
contents. If there is no measurable live claim, mark G15 not applicable.

## What static tests are for

Keep `npx tsc --noEmit` and `npm test` as a merge gate (lock, SSE DONE
ordering, ciphertext, catalog hygiene). They do not replace L3–L6. A green
unit suite plus a red L3 is a **product** failure.
