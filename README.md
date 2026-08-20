# cob — Codex Ollama bridge

Narrow loopback gateway so [Codex](https://github.com/openai/codex) can keep native GPT models on the ChatGPT subscription path and still list local Ollama models in the same picker. Native GPT can spawn selected Ollama models as V1 subagent children. Ollama parent → GPT child is not supported.

OpenCodex is a proof of concept, not the product. This repo reimplements the loopback idea. See [NOTICE](./NOTICE).

## What it does

```
codex --profile cob
  → ~/.codex/cob.config.toml
       model_provider = "openai"
       openai_base_url = "http://127.0.0.1:18790/v1"
       model_catalog_json = "~/.codex/cob-catalog.json"
       [features] multi_agent_v2 = false
  → cob gateway POST /v1/responses
       native catalog slugs → https://chatgpt.com/backend-api/codex/responses
       ollama/*             → http://127.0.0.1:11434/v1/responses
  → compaction_trigger on POST /v1/responses
       native thread        → native /responses byte passthrough
       ollama thread        → Ollama /v1/responses summarizer (not /compact);
                             cob envelope to Codex; next Ollama turn is handoff
                             + later turns (lossy). Optional ollama_threads=native
                             keeps ChatGPT compact + full replay.
  → legacy POST /v1/responses/compact → structured legacy_compaction_unavailable
```

`cob` never writes `~/.codex/config.toml`. Plain `codex` keeps working. `cob restore` deletes cob's overlay files and private conversation state.

Current live proof (Desktop picker, DeepSeek, what is still untested): [STATUS.md](./STATUS.md). Working rules for agents: [AGENTS.md](./AGENTS.md). Ollama-thread compact envelope nuance: [COMPACTION.md](./COMPACTION.md). Versions: [CHANGELOG.md](./CHANGELOG.md). How live global install vs `--dev` works: [RELEASE.md](./RELEASE.md).

## Requirements

- Node.js 22+
- Codex CLI (developed against 0.147.0)
- Ollama with `/v1/responses` (0.13.3+)

## Live vs develop

ChatGPT Desktop and daily `codex --profile cob` use the **globally installed**
`cob` on `127.0.0.1:18790` and the live `~/.codex` overlays. cob still does
not write `~/.codex/config.toml`; Desktop overlay keys on this machine stay
user-owned.

```bash
npm run pack
npm install -g ./codex-ollama-bridge-0.1.5.tgz
cob start
cob status
codex --profile cob
```

Bump `package.json` `version`, edit [CHANGELOG.md](./CHANGELOG.md), pack, and
`npm install -g` the new tarball when a release should replace that live
gateway. Full steps: [RELEASE.md](./RELEASE.md). Do not point Desktop at a git
`dist/cli.js`.

Checkout work uses an **isolated Codex home** so overlays, lock, and port
`18791` cannot steal the live Desktop cob:

```bash
npm install
npm run build
node dist/cli.js start --dev
CODEX_HOME="$HOME/.codex-cob-dev" codex --profile cob
```

A workspace `cob start` against live `~/.codex` is refused unless you pass
`--live-home`. `cob pack` emits a tarball without test files.

## Usage

```bash
cob start
codex --profile cob
```

Commands:

| Command | Effect |
| --- | --- |
| `cob start` | Spawn `cob serve` if needed. Holds the cob lock until the child has written overlays and is healthy. Live install uses `~/.codex` and port 18790 |
| `cob start --dev` | Isolated `$HOME/.codex-cob-dev` and port 18791. Copies `auth.json` if missing. Does not touch live Desktop overlays |
| `cob stop` | Stop the gateway. Leaves the profile in place |
| `cob restore` | Stop, then delete profile + catalog + cob state. Root config is untouched |
| `cob sync` | Refresh `cob-catalog.json` from `codex debug models --bundled` + Ollama `/api/tags`. A running gateway reloads that file on the next request |
| `cob status` | First line `cob: ok\|ready\|broken\|absent\|unreadable`; exit 1 if cob or the Desktop overlay needs action. Read-only overlay check (`openai_base_url` / `model_catalog_json` vs the live gateway). Does not spawn Codex. After reboot or a dead gateway: `cob start` |
| `cob smoke` | Catalog, roster, encrypted-content, restore, and native passthrough checks. `cob smoke --live` also pings Ollama through the gateway |
| `cob pack` | Workspace only: production `tsc` + `npm pack` (no `*.test.js` in the tarball) |
| `cob version` | Print `cob <version> (global\|workspace)` |

Live Codex/Ollama traces are the ship gate, not the mock suite. Isolation, spawn, workspace R/W, compaction, restart, and restore procedures plus gold-standard metrics are in [LIVE-TESTING.md](./LIVE-TESTING.md). The official spawn harness is `COB_LIVE_SUBAGENT=1`; do not pass `--ignore-user-config`, and keep Codex stdin closed.

Native GPT rows are copied from the live bundled catalog. Ollama rows are discovered from `/api/tags` on every start/sync. The picker **lists** `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, and the first spawnable Ollama slug from `cob.toml` `[subagents].models` (default `ollama/deepseek-v4-flash:0731-cloud`). Other native and discovered Ollama rows stay in `cob-catalog.json` with `visibility=hide` so routing still works. Ollama `display_name` equals the catalog slug (`ollama/...`). Do not steal GPT ids (`nativeAlias`). Ollama rows get cob-owned `base_instructions` and a child-only capability profile; GPT personality templates and unproven tool capabilities are not copied onto them.

Thinking Ollama rows advertise `none` / `low` / `high` / `max` (DeepSeek V4 ladder; default `high`). Codex `medium` and `xhigh` map to `high` on the Ollama wire. Advertised `context_window` is `min(tag context_length, 256000)`. Desktop’s used-% bar is that advertised window: a short 0731 first turn meters ~61k here (~26% of 243k) versus ~17–20k on native GPT; that is not cob merging an older thread. Live notes: [STATUS.md](./STATUS.md).

The V1 spawn window is the first five `visibility=list` rows (priority ASC). With the four listed models, all of them sit in that window:

| priority | slug |
| --- | --- |
| 0 | `gpt-5.6-sol` |
| 1 | `gpt-5.6-terra` |
| 2 | `gpt-5.6-luna` |
| 3 | first spawnable Ollama slug from `cob.toml` `[subagents].models` |

Encrypted V2 child tasks return HTTP 400 and are never sent to Ollama. v1 is Responses-only: Chat Completions are not translated. For an Ollama `POST /v1/responses`, a top-level `previous_response_id` is resolved from cob's local checkpoint archive, provider-safe history is merged with the new input, and the field is removed before the Ollama request. Missing, corrupt, incompatible, or unsafe state fails closed with a structured 4xx response asking for full context. Native compaction is triggered only by one terminal `compaction_trigger` item; the trigger is transient and never enters Ollama history. Ollama threads summarize that history locally and return a cob-owned compaction envelope to Codex.

## Compaction

Codex 0.147 uses `remote_compaction_v2`: a normal `POST /v1/responses` whose input ends in exactly one `{"type":"compaction_trigger"}`.

- Native GPT threads pass that request body and headers through unchanged to ChatGPT.
- Ollama threads strip the trigger and call **Ollama `/v1/responses`** (never `/compact`) with an allowlisted slug (the thread model, or `compaction.ollama_model`). The model writes a handoff summary. cob returns to Codex exactly one `compaction` item whose `encrypted_content` is a **cob-owned envelope** (`cob1.…`), not ChatGPT Fernet and not OpenCodex `ocx1`. JSON and SSE are published to `cob-state` before the client sees them.
- Follow-up input containing that item is resolved through the private checkpoint DAG. Ollama receives the **assistant handoff plus turns after compact**, never the envelope, Fernet, the trigger, or the pre-compact tail. Missing or unsafe state returns `requires_full_context`. cob never invents a developer-note stand-in for a missing summary.
- `compaction.ollama_threads = "native"` keeps the older ChatGPT-compact + full-replay path. Do not set `provider = "ollama"`; that still means “call Ollama `/compact`,” which cob never does.
- The retired `/v1/responses/compact` endpoint returns `legacy_compaction_unavailable`. There is no Ollama `/compact` fallback.

Policy lives in cob-owned `~/.codex/cob.toml` (not the Codex profile):

```toml
[compaction]
provider = "native"
ollama_threads = "summarize"
# ollama_model = "ollama/deepseek-v4-flash:0731-cloud"

[subagents]
models = [
  "ollama/deepseek-v4-flash:0731-cloud"
]

[catalog]
# Default false. When true, Ollama rows advertise supports_search_tool so
# Desktop defers MCP behind tool_search. cob translates the wire shape and
# promotes discovered leaves onto the next Ollama tools[] (aliased).
# supports_search_tool = true
```

`provider = "ollama"` and `provider = "disabled"` are no longer valid; cob reports a migration error instead of converting them silently. `--compaction-model` is still accepted (native ChatGPT slug). `--compaction-provider`, if passed, must be `native`. Envelope details: [COMPACTION.md](./COMPACTION.md).

## Durable Ollama state

The local archive is intentionally separate from the provider projection:

```
~/.codex/cob-state/                 # directory mode 0700
  checkpoints/<id>.json             # immutable checkpoint/DAG node, mode 0600
  compact-archive/<id>.json         # exact successful compact bytes (native or cob envelope), mode 0600
```

`<id>` is a URL-safe encoding of the response id. Checkpoints retain request
input, completed response output, parent response id, route/model and
provenance, stable item identities, and replacement history. The compact
archive is sensitive user/tool content and is never sent to Ollama.
Publication uses private temporary files and atomic rename; the state lock
serializes retention and publication, and restart recovery ignores incomplete
temporary files.

The defaults retain at most 512 checkpoint nodes, 64 newest heads, 256 MiB of
checkpoint/archive data, and 30 days of unreachable state. A retained child
always keeps its reachable ancestors. If a long single lineage cannot fit
within the bounded budget without deleting a reachable ancestor, cob refuses
to publish another checkpoint and asks for full context instead. `cob restore`
stops the gateway and deletes this cob-owned state along with cob overlays; it
never touches `~/.codex/config.toml`.

Projection is the only boundary that removes native-only fields: ciphertext
and output-only message shapes can exist in the local archive, but
provider-safe history sent to Ollama cannot contain `encrypted_content` or
ChatGPT-only request headers. After an Ollama-thread summarize compact, the
Ollama window is the handoff plus later turns (lossy by design). The optional
`ollama_threads = "native"` path still full-replays provider-safe history.

Only completed, valid non-stream responses and completed SSE responses with a
valid final envelope are published. Failed upstream responses, oversized or
malformed bodies, aborted client/upstream streams, incomplete SSE, and failed
compaction do not create a checkpoint/head. A stream that has already sent
headers cannot be converted into a new HTTP status, so cob terminates an
incomplete streamed handoff with an SSE error and still publishes no state.
Native v2 compaction SSE is bounded and buffered until a terminal
`response.completed` event so its raw archive can be committed before projected
bytes are released; the live backend may omit a `[DONE]` sentinel. Ollama-thread
summarize compact synthesizes JSON or SSE after the summarizer returns, and
still publishes before release. Ordinary Ollama SSE
remains live and publishes only after its final envelope arrives. For 2xx
Ollama SSE, cob suppresses the upstream DONE until publication commits; a
publication failure is sent as one terminal error event followed by one DONE.

## Safety

- ChatGPT `authorization` / `chatgpt-account-id` / `session_id` / `x-codex-*` headers never go to Ollama
- Top-level Ollama `previous_response_id` is local-only and is removed before the Ollama upstream call
- Missing, corrupt, incompatible, or unsafe local state fails closed instead of silently dropping history
- Gateway binds `127.0.0.1` only
- No Codex binary shim, launchd, custom `[model_providers.ollama]`, or Chat Completions translator
