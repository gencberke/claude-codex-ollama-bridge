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

## What static tests are for

Keep `npx tsc --noEmit` and `npm test` as a merge gate (lock, SSE DONE
ordering, ciphertext, catalog hygiene). They do not replace L3–L6. A green
unit suite plus a red L3 is a **product** failure.
