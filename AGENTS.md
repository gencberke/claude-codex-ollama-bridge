# Agent notes

Read [STATUS.md](./STATUS.md) before changing behavior. Product contract:
[README.md](./README.md). Live gold: [LIVE-TESTING.md](./LIVE-TESTING.md).
Versioned global install: [RELEASE.md](./RELEASE.md), [CHANGELOG.md](./CHANGELOG.md).

## Do not

- Write `~/.codex/config.toml` from cob (`start` / `sync` / `restore` / tests).
  Desktop visibility on this machine is a **user-owned** root overlay; `cob
  restore` will not revert it. Snapshot SHA before any real-home config
  experiment.
- Run a **workspace** `cob start` / `stop` / `restore` / `sync` against live
  `~/.codex` unless the user asked for `--live-home`. Develop with
  `cob start --dev` (isolated `~/.codex-cob-dev`, port 18791). Publish to the
  Desktop/CLI gateway with `cob pack` then `npm install -g` the tarball
  ([RELEASE.md](./RELEASE.md)).
- Commit, push, tag, or open a PR unless the user asks.
- Treat picker success or a DeepSeek chat as native GPT or spawn gold.
- Implement OpenCodex `nativeAlias` (steal `gpt-5.6-sol` / luna / terra) as
  the Desktop picker fix. This ChatGPT build listed `ollama/...` slugs after
  root `model_catalog_json`.
- Call Ollama `/compact`, invent `ocx1` ciphertext, or send ChatGPT /
  `x-codex-*` headers / Fernet / cob envelopes to **Ollama**. A cob-owned
  `cob1.` envelope is Codex-facing and private `cob-state` only.
- Point Ollama threads at a custom `model_provider`. Keep `model_provider =
  "openai"` and loopback `openai_base_url`.
- Use deprecated Codex `profile = "cob"` in root config (unsupported since
  0.134).
- Pass `--ignore-user-config` on live Codex; it can drop the cob overlay.
- Chase L5 compact while Desktop is on the native catalog only, or while
  ChatGPT native quota is exhausted, **for GPT-thread compact**. Ollama-thread
  summarize compact does not need ChatGPT quota.
- Advertise `supports_search_tool` on Ollama rows unless cob.toml
  `[catalog] supports_search_tool = true`. That flag is opt-in; cob translates
  `tool_search_call` ↔ function_call and promotes discovered leaf tools onto
  the next Ollama `tools[]` as namespace-aware aliases. Do not set `tool_mode`.
  Do not hand-edit `cob-catalog.json` to force the flag.

## Activation split

- **CLI / TUI:** `codex --profile cob` → `$CODEX_HOME/cob.config.toml`.
  `codex debug models` does **not** accept `--profile`. Daily use:
  `CODEX_HOME=~/.codex` after a **global** `cob start`. Isolated trials:
  `CODEX_HOME=~/.codex-cob-dev` after `cob start --dev`.
- **Desktop:** bundled `codex app-server` has no `--profile`. It reads root
  `config.toml` only. `codex -p cob app-server` is rejected. Desktop always
  follows live `~/.codex` + loopback port (18790). Bind that port to the
  globally installed cob, not a git `dist/cli.js`.

## Ship standard

`npx tsc --noEmit` and `npm test` are a merge gate. Ship decisions follow
**live traces** (LIVE-TESTING G1–G10), not mock coverage.

English identifiers in code. Picker allowlist, 256k catalog cap, and Ollama
effort levels are implemented; do not reopen them as cosmetics. Default to
stability and throughput on the working Ollama-Desktop path. Ollama-thread
compact shrink is specified in [COMPACTION.md](./COMPACTION.md). Do not
implement OpenCodex `ocx1` / Fernet impersonation / `nativeAlias` / root
config writes.

Durability (STATUS: ChatGPT quit–reopen and `codex update`) is an **important**
subtask, not deferred cosmetics. Do not patch the app binary or use
`nativeAlias` to paper over an update. After lifecycle tests, picker + 0731
routing must still hit cob, or `cob status` must say why not.
