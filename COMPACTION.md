# Compaction — Ollama-thread shrink

Living design note. Product contract is [README.md](./README.md). Live gold
is [LIVE-TESTING.md](./LIVE-TESTING.md) G7/G8 (summarizer + cob envelope +
handoff replay). Mock coverage shipped with this path. Desktop `/compact` on
0731 recorded G7 on 2026-08-19 and G8 follow-up shrink on 2026-08-23 20:29
(live cob 0.1.7). Isolated L5 remains an unrun harness. 2026-08-23 20:15
Desktop auto-compact on cob 0.1.6 reached the no-tools summarizer
(`tools_n=0`) and failed at extract: 0731 called a tool on a ~1.14MB /
146-pair history; cob refused the handoff. The later 0.1.7 flatten produced
a text handoff and `replay_ratio ≈ 0.03`.

Reviewed as cob-appropriate (idea adapted, not OpenCodex source). OpenCodex
remains a proof of the **idea**. Do not copy `nativeAlias`, root `config.toml`
injection, Chat Completions translation, `ocx1` as ChatGPT crypto, or Fernet
impersonation (`gAAAAA…`).

## Why the previous path did not shrink Ollama

Codex Desktop `/compact` and auto-compact send `POST /v1/responses` with a
terminal `compaction_trigger`. cob previously rerouted that to ChatGPT native
compact, archived the opaque blob, and on the next Ollama turn **replayed the
full provider-safe history**. The Ollama window stayed full (`replay_ratio ~ 1`).

Ollama has no HTTP compact API. Its `/v1/responses` rejects `compaction_trigger`.
ChatGPT compact ciphertext cannot be sent to Ollama.

## Idea (OpenCodex, adapted)

A model **does** run and write a handoff summary. Codex v2 compact collects
exactly one Responses `compaction` item with non-empty `encrypted_content`.
That field is an **opaque bag Codex stores and sends back**. It is not ChatGPT
decrypting a Fernet token. Filling it with a cob-owned summary package uses
the same compact **shape** Codex already uses; it does not impersonate
ChatGPT crypto.

cob is the only decoder. Native GPT threads stay **byte passthrough** to
ChatGPT (real ChatGPT compact). This plan is **Ollama threads only**.

Treat “Codex round-trips opaque `encrypted_content`” as **observed** on this
ChatGPT/Codex build. Desktop `/compact` on 0731 proved G7 on this machine
(2026-08-19). Desktop auto-compact follow-up on 0731 proved G8 on this
machine (2026-08-23, cob 0.1.7).

## What we keep (cob contract)

- cob never writes `~/.codex/config.toml` (`cob restore` deletes cob overlays
  and `cob-state/`; it does not mutate root config)
- `model_provider = "openai"` + loopback `openai_base_url`
- no `nativeAlias`, no custom `[model_providers.ollama]`, no Chat Completions translator
- no Ollama `/compact` endpoint
- no ChatGPT headers, Fernet, cob envelope, or `encrypted_content` on the
  Ollama **upstream** request cob emits
- fail closed if the summarizer returns empty or truncated text
- cob never invents a developer-note stand-in for missing ChatGPT state; the
  Ollama model writes the handoff, cob projects it as an **assistant** message

## Proposed wire (Ollama thread)

1. Codex sends `compaction_trigger` (slash `/compact` or auto-compact). Desktop
   already hits cob when the user-owned root overlay points at loopback.
2. cob strips the trigger (it must not reach Ollama). The summarizer request is
   an **allowlist**: thread model (or a dedicated Ollama compact slug),
   provider-safe history (tool calls flattened to clipped notes), one
   top-level cob compact instruction (no duplicate developer copy). No tools,
   no structured
   output, no ChatGPT headers. Unsupported multimodal history **fails closed**
   rather than dropping images silently.
3. cob calls **Ollama `/v1/responses`** (not `/compact`).
4. On a non-empty summary, cob publishes a **compaction replacement
   checkpoint** (`provenance.source = ollama-summary`): `replacementHistory`
   and `history` are the summary items only. Do not copy full pre-compact
   input into `providerInput`. Parent id stays for lineage, not for replay.
   Then cob returns to Codex a synthetic completed response with **exactly
   one** `compaction` item (collision-resistant ids). JSON and SSE must
   satisfy the same publication-before-release rules as today's native compact
   relay. The item's `encrypted_content` is the cob envelope.
5. Follow-up: Codex sends that item back (with or without
   `previous_response_id`). cob accepts the envelope **only** when it matches
   the checkpoint (id / fingerprint / model / lineage). Caller-supplied
   cob-prefixed strings are not authoritative. Decode locally. Send Ollama
   **one assistant handoff + turns after that compact** (no pre-compact tail
   unless a later bounded-tail subtask says otherwise). Never the envelope,
   Fernet, or trigger.
6. Legacy `POST /v1/responses/compact` stays `legacy_compaction_unavailable`.

## Envelope

- Distinct cob magic + version (not `ocx1`, not Fernet).
- UTF-8 summary, bounded size, base64url payload.
- Unknown version, malformed bytes, or Fernet prefix → reject / require full
  context.
- State-bound: decode only through cob's checkpoint map.

## Envelope nuance

Codex stores the bag; cob decodes cob bags; ChatGPT bags never go to Ollama.

Compatibility note: Ollama-thread compaction relies on Codex continuing to
round-trip non-empty opaque `encrypted_content`; if a future build validates
a ChatGPT-specific encoding, cob will fail closed and report that build as
unsupported for Ollama-thread compaction.

Never put a cob envelope on a **native** ChatGPT request.

## Policy sketch (`cob.toml`, cob-owned)

Do not silently reuse today's `[compaction] model` (native slug) as an
Ollama model.

```toml
[compaction]
# GPT threads: unchanged ChatGPT passthrough
# Ollama threads: summarize | (later) keep today's native-full-replay if needed
ollama_threads = "summarize"
# optional dedicated Ollama slug; default = thread model
# ollama_model = "ollama/deepseek-v4-flash:0731-cloud"
# optional Stage 3 experiment; omit to keep G8 wire high
# ollama_effort = "low"

[catalog]
# advertise_cloud_max_context = true
# active_context_window = 256000
# auto_compact_token_limit = 230400
```

Do not revive `provider = "ollama"` as "call Ollama `/compact`."

## Gold-standard (shipped in cob; Desktop G7 and G8 recorded)

Update README, AGENTS, and LIVE-TESTING **in the same merge** as the code.
This file stays the nuance note.

| ID | Today | After |
| --- | --- | --- |
| G5 | no `encrypted_content` on the Ollama **route cob emits** | still none on **Ollama upstream**; cob envelope **is** allowed Codex-facing and in private `cob-state` |
| G6 | Ollama `/compact` = 0 | still 0 |
| G7 | trigger → **native** `/v1/responses` | trigger → **Ollama** `/v1/responses` summarizer; trigger not in Ollama body |
| G8 | native opaque bytes to Codex; Ollama full replay | cob envelope to Codex; Ollama assistant handoff + later turns; `replay_ratio << 1`; no envelope on Ollama |

L5 still uses an 8k **catalog** lie to force compact; do not lower Ollama `n_ctx`.
Record summarizer latency and pre/post Ollama prompt bytes.

## Implementation order

1–3 and 5 are in cob (envelope, summarizer, handoff checkpoint, docs). Desktop
`/compact` on 0731 recorded G7. 2026-08-23 20:29 auto-compact on cob 0.1.7
recorded G8 (flatten handoff, `cob1.` envelope, follow-up
`replay_ratio ≈ 0.03`). Isolated L5 remains a recorded harness. WP7 Stages 2–4
(single instruction copy, required section headings, opt-in effort, split
max vs active context) are packed in cob **0.1.8**.
Incomplete skeletons fail closed. Defaults keep the G8 effort/cap/threshold.

Out of scope: `nativeAlias`, writing root config, ChatGPT.app patches.

## Risks (ordinary)

- Lossy: tool logs and exact code can disappear. Expected for a summarizer.
- The compact **turn** itself can still be large; Ollama may overflow that
  one call. Fail closed; do not silently trim.
- Summary quality is the thread model (or a named Ollama compact slug).
  Live 0731 on 2026-08-19 wrote source-like text into the handoff instead
  of a recap; Codex still accepted the `cob1.` envelope (G7 ≠ good summary).
- Desktop auto-compact timing still depends on catalog `context_window`
  (Ollama rows are capped at 256k). The Desktop used-% bar is that window,
  not proof of cob transcript leakage; 0731 first turns meter ~61k here
  vs ~17–20k on native GPT (see [STATUS.md](./STATUS.md)).
