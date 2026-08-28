# cob — Codex and Claude Ollama bridges

One product with **two independent surfaces** — separate protocols, homes,
ports, and auth. Never mix them:

- **cob Codex** (`cob start`, the default `cob` command) — live product. [Codex](https://github.com/openai/codex) / ChatGPT Desktop keep native GPT on the ChatGPT subscription path and still list local Ollama models in the same picker. Native GPT can spawn selected Ollama models as V1 subagent children. Ollama parent → GPT child is not supported.
- **cob Claude** (`cob claude start`) — live Messages loopback on `:18792` / `~/.claude-cob`. Claude Code keeps native Claude models on the Anthropic subscription (OAuth forwarded). Other model ids go to Ollama `/v1/messages`. Native Claude ids are never rewritten to Ollama. `cob claude start --desktop` snapshots then points Claude Desktop 3P at this loopback, pins the 3P picker to Opus 5 / Sonnet 5 / Haiku 4.5 / Fable 5, and writes cob-owned `~/.claude/agents/cob-*.md` (restore reverts). Never ChatGPT Desktop gold. `ollama launch claude` is not this surface.

OpenCodex is a proof of concept, not the product. This repo reimplements the loopback idea. See [NOTICE](./NOTICE).

## Install

Node.js 22+, a local [Ollama](https://ollama.com) with `/v1/responses`
(0.13.3+), and the client you actually use:

- cob Codex: [Codex CLI](https://github.com/openai/codex) 0.149+ (`codex login`). ChatGPT Desktop is optional.
- cob Claude: Claude Code logged in on this machine. Claude Desktop is optional (`--desktop`).

cob does not ship ChatGPT or Anthropic API keys. It forwards the client’s
own login. Do not put secrets in this repo.

There is no npm registry package while `"private": true`. Install from a
clone:

```bash
git clone https://github.com/gencberke/claude-codex-ollama-bridge.git
cd claude-codex-ollama-bridge
npm install
npm run pack
npm install -g ./codex-ollama-bridge-0.2.0.tgz
cob version    # cob 0.2.0 (global)
```

Pull Ollama models you want listed (example):

```bash
ollama pull deepseek-v4-flash:0731-cloud
```

### cob Codex — CLI

```bash
cob start
cob status
codex --profile cob
```

`cob start` writes cob-owned files under `~/.codex` (`cob.config.toml`,
catalog, `cob.toml`). It never writes `~/.codex/config.toml`. After reboot
or a dead listener, run `cob start` again (no launchd).

### cob Codex — ChatGPT Desktop

Desktop’s bundled `codex app-server` ignores `--profile`. Point it at cob
yourself. Snapshot `~/.codex/config.toml` first. Then set these **root**
keys (not inside a `[table]`):

```toml
model_provider = "openai"
openai_base_url = "http://127.0.0.1:18790/v1"
model_catalog_json = "~/.codex/cob-catalog.json"
```

Keep `model_provider = "openai"`. Do not add a custom Ollama
`[model_providers]` table. Fully quit and reopen ChatGPT Desktop after a
catalog write. `cob restore` will not revert this overlay.

### cob Claude — CLI

```bash
cob claude start
unset ANTHROPIC_API_KEY
ANTHROPIC_BASE_URL=http://127.0.0.1:18792 claude --model opus
cob claude agents --dir .
```

Ask the parent for `cob-deepseek-0731`, not built-in Haiku. Native Claude ids
(`opus` / `sonnet` / `haiku` / `fable` / `claude-*`) stay on Anthropic.
Do not set `ANTHROPIC_AUTH_TOKEN=ollama`.

### cob Claude — Claude Desktop 3P

```bash
cob claude start --desktop
```

Fully quit and reopen Claude Desktop. This snapshots, then writes cob’s
3P profile (picker: Opus 5 / Sonnet 5 / Haiku 4.5 / Fable 5) and cob-owned
`~/.claude/agents/cob-*.md`. `cob claude restore` reverts those snapshots.
cob never writes `~/.claude/settings.json` and never runs `ollama launch`.

### Isolated checkout (does not touch live Desktop)

Use this while hacking on the git tree. Live ChatGPT Desktop must keep
using the **global** `cob` on `:18790`.

```bash
npm install
npm run build
node dist/cli.js start --dev
CODEX_HOME="$HOME/.codex-cob-dev" codex --profile cob

node dist/cli.js claude start --dev
```

A workspace `cob start` against live `~/.codex` is refused unless you pass
`--live-home`.

## What it does

```
codex --profile cob
  → ~/.codex/cob.config.toml
       model_provider = "openai"
       openai_base_url = "http://127.0.0.1:18790/v1"
       model_catalog_json = "~/.codex/cob-catalog.json"
       [features] multi_agent_v2 = false
                  remote_compaction_v2 = true
  → cob gateway POST /v1/responses
       native catalog slugs → https://chatgpt.com/backend-api/codex/responses
       ollama/*             → http://127.0.0.1:11434/v1/responses
  → cob gateway POST /v1/alpha/search
       exact path only      → https://chatgpt.com/backend-api/codex/alpha/search
       native-only byte passthrough; never Ollama
  → compaction_trigger on POST /v1/responses
       native thread        → native /responses byte passthrough
       ollama thread        → Ollama /v1/responses summarizer (not /compact);
                             cob envelope to Codex; next Ollama turn is handoff
                             + later turns (lossy). Optional ollama_threads=native
                             keeps ChatGPT compact + full replay.
  → legacy POST /v1/responses/compact → structured legacy_compaction_unavailable
```

Standalone hosted web search is separate from catalog
`supports_search_tool`. The latter defers MCP/collaboration schemas; it does
not serve Codex's `web.run` requests. cob allowlists only
`POST /v1/alpha/search`, forwards the Codex JSON and allowlisted ChatGPT auth /
turn headers to the native ChatGPT Codex endpoint, and relays the native status,
headers, and body. It does not rewrite the request model or fall back to Ollama.
Every other search-like or unknown `/v1/*` route remains closed.

On the Ollama Responses path, cob snapshots the final outbound `tools[]` after
deferred-tool promotion and the request allowlist. A client-executed
`function_call` whose name is missing from that snapshot is refused with HTTP
502 (JSON) or one `response.failed` plus `[DONE]` (SSE). The refused turn is
not checkpointed. Known aliases are still restored for Codex after the name is
authorized.

The reviewed Ollama 0.33.1 Responses source is unchanged from 0.32.15, whose
cloud path may close a successful stream after `response.completed` without an
OpenAI-style upstream `[DONE]`. cob treats only the valid completed envelope as
success, publishes its checkpoint, then emits exactly one client-facing
`[DONE]`. Incomplete streams end without a synthetic `[DONE]`; incomplete,
failed, malformed, or rejected streams publish no state.

Standard request/wire logs are content-free: they retain aggregate counts,
sizes, and SHA fields plus sorted `tool_bytes_top` definition sizes, but never
tool names, schemas, descriptions, arguments, outputs, user/response text,
authorization, or account identifiers. Guard rejections record only stable
code/kind, rejected-name length/SHA, and final declaration count/SHA.

`cob` never writes `~/.codex/config.toml`. Plain `codex` keeps working. `cob restore` deletes cob's overlay files and private conversation state.

Current live proof: [STATUS.md](./STATUS.md). Working rules for agents:
[AGENTS.md](./AGENTS.md) (Desktop spawn policy is user-owned
`~/.codex/AGENTS.md`). Ollama-thread compact envelope nuance:
[COMPACTION.md](./COMPACTION.md). Versions: [CHANGELOG.md](./CHANGELOG.md).
How live global install vs `--dev` works: [RELEASE.md](./RELEASE.md).

## Commands

| Command | Effect |
| --- | --- |
| `cob start` | Spawn `cob serve` if needed. Holds the cob lock until the child has written overlays and is healthy. Live install uses `~/.codex` and port 18790 |
| `cob start --dev` | Isolated `$HOME/.codex-cob-dev` and port 18791. Copies `auth.json` if missing. Does not touch live Desktop overlays |
| `cob stop` | Stop the gateway. Leaves the profile in place |
| `cob restore` | Stop, then delete profile + catalog + catalog metadata + cob state. Root config is untouched |
| `cob sync` | Refresh `cob-catalog.json` from the selected Codex producer (`COB_CODEX_BIN`, live Desktop bundle, or PATH) + Ollama `/api/tags`. Writes `cob-catalog.meta.json`. A running gateway reloads the catalog on the next request |
| `cob status` | First line `cob: ok\|ready\|broken\|absent\|unreadable\|stale\|unknown`; exit 1 if cob, the Desktop overlay, or catalog provenance needs action. Read-only overlay + sidecar check. Does not spawn Codex or probe Ollama. After reboot or a dead gateway: `cob start` |
| `cob smoke` | Catalog, roster, encrypted-content, restore, and native passthrough checks. `cob smoke --live` also pings Ollama through the gateway |
| `cob pack` | Workspace only: production `tsc` + `npm pack` (no `*.test.js` in the tarball) |
| `cob version` | Print `cob <version> (global\|workspace)` |
| `cob claude start` | Live cob Claude Messages loopback (`~/.claude-cob`, port 18792). Global install. Does not write `~/.claude/settings.json`. Not ChatGPT Desktop gold |
| `cob claude start --desktop` | Same loopback, plus cob-owned Claude Desktop 3P overlay and cob-owned `~/.claude/agents/cob-*.md` (snapshot then write). Restore reverts both. Never `ollama launch` or nativeAlias |
| `cob claude start --dev` | Isolated cob Claude (`~/.claude-cob-dev`, port 18793). Workspace checkouts. |
| `cob claude agents --dir .` | Writes cob-owned `cob-deepseek-0731.md` into this project's `.claude/agents`; it routes to the default `deepseek-v4-flash:0731-cloud` child. Refuses `~/.claude`. Ask the parent for that subagent, not built-in haiku |
| `cob claude status` / `stop` / `restore` | cob-owned Claude runtime; restore also reverts Desktop overlay and user-agents snapshots. Never `~/.claude/settings.json` |

Live Codex/Ollama traces are the ship gate, not the mock suite. Isolation, spawn, workspace R/W, compaction, restart, and restore procedures plus gold-standard metrics are in [LIVE-TESTING.md](./LIVE-TESTING.md). The official spawn harness is `COB_LIVE_SUBAGENT=1`; do not pass `--ignore-user-config`, and keep Codex stdin closed.

Native GPT rows are copied from the Codex binary that will consume them
(Desktop's bundled `codex` on a live macOS home; PATH / `COB_CODEX_BIN`
otherwise). The sidecar `cob-catalog.meta.json` records that producer. If a
consumer rejects a candidate, schema v2 retains only redacted failure metadata
beside the unchanged last-good catalog; a later successful sync writes clean
schema v1 again. Missing, stale, unknown, or last-failed catalog provenance is
non-ready.
A successful live catalog write is not visible in an already-open Desktop
session — fully quit and reopen ChatGPT Desktop before judging picker
changes. Native GPT rows are not "repaired" from a different Codex version.

Ollama rows are discovered from `/api/tags` on every start/sync. The picker
lists `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, then up to two configured
Ollama slugs from `cob.toml` `[subagents].models` inside the five-row V1 window
(default first row `ollama/deepseek-v4-flash:0731-cloud`). Additional configured
models remain catalogued and directly routable but are reported as V1 roster
overflow. Other native and discovered Ollama rows stay in `cob-catalog.json`
with `visibility=hide` so routing still works. Ollama `display_name` equals the
catalog slug (`ollama/...`). Do not steal GPT ids (`nativeAlias`). Ollama rows
get cob-owned `base_instructions` and a child-only capability profile; GPT
personality templates and unproven tool capabilities are not copied onto them.

DeepSeek thinking rows retain `none` / `low` / `high` / `max` (default `high`). GLM-5.3 Flash thinking is always on and advertises only `low` / `high` / `max` (default `max`); Codex `none`/`off`/`minimal` map to `low`, `medium` to `high`, and `xhigh` to `max` on that wire. For the DeepSeek ladder, `medium` / `xhigh` / `minimal` still map to `high`. The Ollama request is clipped to the reviewed Responses fields. Codex-only extras such as `client_metadata` and `stream_options` are dropped. Missing usage is omitted, never estimated. 429 is not retried inside cob. Header wait is a TTFB deadline (30s native, 240s Ollama; `upstream_headers_timeout`), and stream idle is 300s unless the client is applying backpressure. Advertised `context_window` is `min(tag context_length, 256000)` unless
`catalog.active_context_window` opts in to a different active cap.
`max_context_window` stays equal to that active window unless
`catalog.advertise_cloud_max_context = true` on a verified cloud tag. Desktop’s used-% bar is that advertised window: a short 0731 first turn meters ~61k here (~26% of 243k) versus ~17–20k on native GPT; that is not cob merging an older thread. Live notes: [STATUS.md](./STATUS.md).

The V1 spawn window is the first five `visibility=list` rows (priority ASC):

| priority | slug |
| --- | --- |
| 0 | `gpt-5.6-sol` |
| 1 | `gpt-5.6-terra` |
| 2 | `gpt-5.6-luna` |
| 3 | first configured Ollama slug from `cob.toml` `[subagents].models` |
| 20+ | second configured Ollama slug; later configured slugs overflow the five-row window |

Encrypted V2 child tasks return HTTP 400 and are never sent to Ollama. v1 is Responses-only: Chat Completions are not translated. For an Ollama `POST /v1/responses`, a top-level `previous_response_id` is resolved from cob's local checkpoint archive, provider-safe history is merged with the new input, and the field is removed before the Ollama request. Missing, corrupt, incompatible, or unsafe state fails closed with a structured 4xx response asking for full context. Native compaction is triggered only by one terminal `compaction_trigger` item; the trigger is transient and never enters Ollama history. Ollama threads summarize that history locally and return a cob-owned compaction envelope to Codex.

Gate 1-3 research exception (default off): an isolated `cob.toml` `[experimental]` policy may rewrite only an exact, explicitly fingerprinted `gpt-5.6-sol` `collaboration.spawn_agent`, `collaboration.send_message`, and `collaboration.followup_task` schema to non-reserved plaintext aliases and restore each V2 identity on the native response. This is a dev canary, not Ollama V2 support: Ollama rows remain `multi_agent_version = "v1"`, live `:18790` is unchanged, and schema absence, drift, ambiguity, or encrypted child content fails closed. Isolated Gate 4 additionally proves the preserved canonical `interrupt_agent` leaf can stop an active child; it adds no alias or catalog capability. Restart/replay behavior remains unenabled. Enable only in an isolated home after recording `native_plaintext_spawn_schema_sha256`.

Gate 5 is a separate, default-off catalog opt-in for an isolated `--dev` home:
`[catalog] apply_patch = true` adds cob-owned
`apply_patch_tool_type = "freeform"` only to Ollama rows whose slugs are listed
in `[subagents].models`. Native GPT rows remain verbatim, Ollama rows keep
`shell_type = "disabled"` and `multi_agent_version = "v1"`, and the live
`:18790` gateway/pack/catalog path does not enable it. On that isolated route,
cob translates the one declared Codex custom/freeform `apply_patch` tool to a
fixed Ollama function alias with a string input wrapper, then restores the
Codex custom call/output identity. Missing declarations, alias collisions,
encrypted fields, malformed history, and undeclared calls fail closed without
logging the patch body. The 2026-08-24 Gate 5 canary proved one real 0731 child
edit through that custom tool; `exec_command` plus a temporary patch binary is
not gold and shell remains disabled.

Ollama accepts a string as a complete first-turn `input`, but replayed history
uses `input[]`, whose entries must be typed items. cob preserves the first-turn
shorthand on the wire and promotes archived strings to typed user-message
items only when constructing a local `previous_response_id` continuation.

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
# Omit this key to use the thread model; omitted effort uses its model ladder
# default (DeepSeek high, GLM-5.3 Flash max when explicitly selected).
# ollama_effort = "none"

[subagents]
models = [
  "ollama/deepseek-v4-flash:0731-cloud",
  # Optional migration canary; add as a second row before making it primary:
  # "ollama/glm-5.3-flash:cloud",
]

[catalog]
# Default true. Desktop defers MCP behind tool_search. cob translates the
# wire shape and promotes discovered leaves onto the next Ollama tools[]
# (aliased). Set false to send the full tool list every turn.
# supports_search_tool = false
# Gate 5; isolated --dev only and default false. Only configured Ollama spawn
# rows receive apply_patch_tool_type = "freeform"; shell remains disabled.
apply_patch = false
# Set the preceding key to true only in the isolated --dev cob.toml canary.
# advertise_cloud_max_context = true
# active_context_window = 256000
# auto_compact_token_limit = 230400

[experimental]
# Gate 1-3 only; default is false and the schema digest is mandatory when true.
native_plaintext_spawn = false
# native_plaintext_spawn_schema_sha256 = "<64 hex chars from the isolated schema canary>"
```

G17's fixed-corpus trace was a legacy DeepSeek/0731 experiment: it rejected
`low` and found `none` faster/cheaper with the same two continuation checks.
That evidence does not override the model-specific ladder. For the shipped
DeepSeek 0731 default, omit `ollama_effort` to use `high`; explicitly selected
GLM-5.3 Flash uses `max` when omitted. Cloud-max advertisement is also
opt-in, and `auto_compact_token_limit` is emitted only when the native Codex
skeleton already supports that field. Exact measurements: [LIVE-TESTING.md](./LIVE-TESTING.md).

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
- Ollama client-executed tool calls must match the exact final outbound `tools[]` for that request. Undeclared or invalid names return HTTP 502 (`ollama_undeclared_tool_call` / `ollama_tool_call_invalid`) and do not create a checkpoint. There is no runtime opt-out.
