# Changelog

Versions follow [semver](https://semver.org/) on the `0.x` line until durability
(ChatGPT quit–reopen / `codex update`) is proven. The git tag, `package.json`
`version`, and `cob version` string must match. How to cut a release:
[RELEASE.md](./RELEASE.md).

Ship decisions still follow live traces in [LIVE-TESTING.md](./LIVE-TESTING.md),
not this file.

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
