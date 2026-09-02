# Agent notes

Read [STATUS.md](./STATUS.md) before changing behavior. Product contract:
[README.md](./README.md). Live gold: [LIVE-TESTING.md](./docs/LIVE-TESTING.md).
Current implementation plan: [IMPLEMENTATION-PLAN.md](./docs/IMPLEMENTATION-PLAN.md).
Versioned global install: [RELEASE.md](./docs/RELEASE.md), [CHANGELOG.md](./CHANGELOG.md).

cob is one product with two surfaces. **cob Codex** (`cob start`) is the live
ChatGPT Desktop / `codex --profile cob` gateway. **cob Claude** (`cob claude`)
is a live Messages loopback for Claude Code / Claude Desktop 3P. Do not mix
protocols, homes, or ports. `cob start` remains Codex; do not steal that
default.

## Current development scope

Active product development is **cob Codex only**. cob Claude remains an
existing surface, but its feature work, hardening, canaries, and release-gate
work are frozen until the user explicitly reopens that scope. Preserve its
source and surface boundary; do not refactor or fix `src/claude/`, replace its
listener, or broaden its claims merely because a Codex release is being
prepared. Deferred Claude findings do not block a clearly Codex-scoped
decision, but they still prevent a new whole-product production-readiness
claim.

## Do not

- Write `~/.codex/config.toml` from cob (`start` / `sync` / `restore` / tests).
  Desktop visibility on this machine is a **user-owned** root overlay; `cob
  restore` will not revert it. Snapshot SHA before any real-home config
  experiment.
- Run a **workspace** `cob start` / `stop` / `restore` / `sync` against live
  `~/.codex` unless the user asked for `--live-home`. Develop with
  `cob start --dev` (isolated `~/.codex-cob-dev`, port 18791). Publish to the
  Desktop/CLI gateway with `cob pack` then `npm install -g` the tarball
  ([RELEASE.md](./docs/RELEASE.md)).
- Commit, push, tag, or open a PR unless the user asks.
- Treat picker success or a DeepSeek chat as native GPT or spawn gold.
- Implement OpenCodex `nativeAlias` (steal `gpt-5.6-sol` / luna / terra) as
  the Desktop picker fix. This ChatGPT build listed `ollama/...` slugs after
  root `model_catalog_json`.
- Call Ollama `/compact`, invent `ocx1` ciphertext, or send ChatGPT /
  `x-codex-*` headers / Fernet / cob envelopes to **Ollama**. A cob-owned
  `cob1.` envelope is Codex-facing and private `cob-state` only; the `cob1.`
  prefix is an encoding marker, not encryption.
- Point Ollama threads at a custom `model_provider`. Keep `model_provider =
  "openai"` and loopback `openai_base_url`.
- Use deprecated Codex `profile = "cob"` in root config (unsupported since
  0.134).
- Pass `--ignore-user-config` on live Codex; it can drop the cob overlay.
- Chase L5 compact while Desktop is on the native catalog only, or while
  ChatGPT native quota is exhausted, **for GPT-thread compact**. Ollama-thread
  summarize compact does not need ChatGPT quota.
- Advertise `supports_search_tool` on Ollama rows unless cob.toml
  `[catalog] supports_search_tool = false`. Default is on; cob translates
  `tool_search_call` ↔ function_call and promotes discovered leaf tools onto
  the next Ollama `tools[]` as namespace-aware aliases. Do not set `tool_mode`.
  Do not hand-edit `cob-catalog.json` to force the flag. Do not rewrite an
  existing explicit false.
- Gate 5 `catalog.apply_patch` is default-off and isolated `--dev` only. When
  explicitly true, advertise cob-owned `apply_patch_tool_type = "freeform"`
  only on configured Ollama spawn rows; native GPT rows remain verbatim and
  `multi_agent_version` stays `v1`. The opt-in does not change `shell_type`,
  which follows fresh `/api/tags` tools evidence: an exact lowercase `tools`
  capability advertises `unified_exec`; no-tools, unknown, or fallback
  evidence keeps `disabled`. Live
  `:18790` keeps `apply_patch = false`; do not advertise it on the live
  catalog. The bridge is strict Codex custom tool ↔ fixed Ollama function
  alias; undeclared or malformed calls fail closed and diagnostics must not
  include the tool name, alias, patch body, or heredoc. Do not count
  `exec_command` plus a temporary patch binary, or a parent-applied patch, as
  child gold.
- Install launchd, a Login Item, or any OS supervisor for cob. After reboot
  or a dead gateway, recovery is `cob start`.
- Enable Multi-Agent V2 for Ollama children, advertise `multi_agent_version`
  other than `v1` on Ollama rows, or call `followup_task` / encrypted
  collaboration payloads outside the isolated Gate 1-3 exception below.
  Ollama stays V1. Fernet never goes to Ollama.
- Write `~/.claude/settings.json` or run `ollama launch claude` /
  `ollama launch claude-desktop` from cob. cob claude live owns `~/.claude-cob`
  (port 18792). Isolated trials use `cob claude start --dev`
  (`~/.claude-cob-dev`, 18793). `--desktop` snapshots then writes cob's
  Claude Desktop 3P profile (not Ollama's UUID, not nativeAlias) and may
  snapshot then write cob-owned `~/.claude/agents/cob-*.md` only. `cob claude
  restore` reverts those snapshots. Never settings.json. Do not quit or
  restart Claude.app from cob; print fully quit and reopen. Snapshot SHA
  before any real-home Desktop experiment. CLI project agents remain
  `cob claude agents --dir .`.
- Rewrite Claude model ids (`opus` / `sonnet` / `haiku` / `fable` / `claude-*`)
  to Ollama. That is `nativeAlias` for this surface. Anthropic routes must
  forward Claude Code OAuth untouched; do not set `ANTHROPIC_AUTH_TOKEN=ollama`.
- Treat cob claude as ChatGPT Desktop gold, pack it as the Codex gateway, or
  point ChatGPT Desktop at :18792. Live Codex proof stays cob Codex on :18790.

## Orchestration

Parent spawn policy for Desktop/CLI is user-owned `~/.codex/AGENTS.md`. Do
not treat this file as that policy.

Ollama children stay V1. Spawn slot is `cob.toml` `[subagents].models`
(default `ollama/deepseek-v4-flash:0731-cloud`). Do not add
`~/.codex/agents/*.toml` for discovery. Do not steal native GPT ids.
Thinking Ollama default is `high`; leftover Codex `medium` / `xhigh` map to
`high` on the Ollama wire.

User-authorized Gate 1-3 research is the narrow exception under test: isolated
`[experimental] native_plaintext_spawn = true` may rewrite only an exact,
fingerprinted `gpt-5.6-sol` `collaboration.spawn_agent`,
`collaboration.send_message`, and `collaboration.followup_task` schema and
restore each native V2 identity. It does not advertise Ollama V2, enable
interrupt/restart/replay, or turn on live `~/.codex` experiments; missing
or changed schema fails closed. This exception is not product proof.

Gate 4 may exercise the preserved canonical `collaboration.interrupt_agent`
leaf in the same isolated home. It adds no plaintext alias or Ollama catalog
capability; restart/replay/worktree/Desktop remain outside that proof.

Gate 5 is a separate catalog/tool-dialect experiment, not a collaboration
alias. Its isolated canary has one real 0731 child-native custom `apply_patch`
edit; it does not authorize live enablement, shell writes, nested V2,
restart/replay, worktree, or Desktop claims.

Gate-specific dispositions and evidence are not recorded here. Current
machine, workspace, and canary state belongs in [STATUS.md](./STATUS.md);
repeatable procedures and receipts belong in [LIVE-TESTING.md](./docs/LIVE-TESTING.md).
Do not treat a fixture, isolated canary, picker success, or model chat as
product gold without the required trace or receipt. Gate 6's controller
capability remains cob-external; follow [UPSTREAM-U1.md](./docs/UPSTREAM-U1.md), do
not implement `agentControl/*` or a cob-owned collaboration queue, and do not
re-measure it outside the authorized isolated path.

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
**live traces** (LIVE-TESTING G1–G10, plus G11+ when that package is
live-authorized), not mock coverage.

Live catalog generation prefers Desktop's bundled Codex; `cob status` must
explain producer/consumer skew via `cob-catalog.meta.json` without spawning
Codex. First-line kinds include `stale` and `unknown`. Do not claim Desktop
hot-reloaded the catalog; say fully quit and reopen ChatGPT Desktop.

## Logging and evidence boundaries

- Structured persistence is opt-in only. The default hot path and human-readable
  log remain unchanged.
- Logs and persisted diagnostics are structural and content-free: never record
  prompts, outputs, tool names or IDs, auth material, or raw errors.
- Logging is diagnostic-only and must not make a model/provider call, automatic
  retry, queue, or background worker. A logging failure never fails a request.
- Exact usage is forwarded only when supported by upstream evidence; never
  fabricate, estimate, or infer exact usage.
- Controller retries and no-progress counts belong to the upstream controller;
  cob may report them only when a trace or receipt provides the evidence. The
  gateway must not invent, merge, or own those counters.
- Operational logging details and receipt fields belong in [README.md](./README.md)
  and [LIVE-TESTING.md](./docs/LIVE-TESTING.md). The current installed state belongs
  in [STATUS.md](./STATUS.md).

English identifiers in code. Picker allowlist, 256k catalog cap, and Ollama
effort levels are implemented; do not reopen them as cosmetics. Default to
stability and throughput on the working Ollama-Desktop path. Ollama-thread
compact shrink is specified in [COMPACTION.md](./docs/COMPACTION.md). Do not
implement OpenCodex `ocx1` / Fernet impersonation / `nativeAlias` / root
config writes.

Current machine, workspace, and canary facts—including PID, version, root
overlay/catalog hashes, and gate dispositions—are maintained only in
[STATUS.md](./STATUS.md). Burned artifact identities, release events, global
installation, and rollback procedure are maintained only in
[RELEASE.md](./docs/RELEASE.md). Link to those authorities instead of copying their
volatile snapshots into this file. Never repack a burned or historical
artifact; cut a new version as required by [RELEASE.md](./docs/RELEASE.md).

Fail-closed JSON/encrypted-wire is required; `apply_patch` and
`native_plaintext_spawn` stay default-off and isolated from the live root.
Pack excludes `gate6h` and `eval-*`. Do not restart or replace the live Codex
gateway to pick up source changes unless the user authorizes that gateway
replacement. Future app updates can still drop the overlay or hide
`ollama/...`; diagnose the result with `cob status`, not by patching the app or
using `nativeAlias`. Reboot is not cob autostart; `cob start` brings the
gateway back.
