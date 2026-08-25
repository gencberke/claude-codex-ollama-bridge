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
  `[catalog] supports_search_tool = false`. Default is on; cob translates
  `tool_search_call` ↔ function_call and promotes discovered leaf tools onto
  the next Ollama `tools[]` as namespace-aware aliases. Do not set `tool_mode`.
  Do not hand-edit `cob-catalog.json` to force the flag. Do not rewrite an
  existing explicit false.
- Gate 5 `catalog.apply_patch` is default-off and isolated `--dev` only. When
  explicitly true, advertise cob-owned `apply_patch_tool_type = "freeform"`
  only on configured Ollama spawn rows; native GPT rows remain verbatim,
  `shell_type` stays `disabled`, and `multi_agent_version` stays `v1`. Live
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

Gate 6 (two active `send_message` plus two idle `followup_task` on one child)
failed in isolated `:18791` canaries: Sol waited after the first send and the
0731 child completed after `SEND1`. Gate 6-H is the workspace-only JSONL
harness (`npm run gate6h`) that fail-stops on `controller_sequencing_fail`
and retries the same fixture at most three times. It does not add a cob
queue. Three sequencing fails record `controller_sequencing_observed` with
`transport_unmeasured`. Do not pack the harness, run a fourth Sol canary, or
write a cob-owned queue.
Isolated 2026-08-25 canaries: Gate 7 FAIL `worktree_not_distinct`; Gate 8-M
PASS same-child continue after mid-flight `cob stop --dev`/`start --dev`
(not G8-R completed-checkpoint replay); Gate 9 FAIL
`compaction_summary_incomplete` (8k catalog lie; a later compact-ok is not
gold without continuation; not live G8). Pack-excluded eval fixtures cover
G2–G5 approval preflight, G8-R replay, and G9 protocol without a live canary.
Gate 10 FAIL no nested leaf (`collaboration.spawn_agent` absent from the
0731 child toolset). Desktop hop stays separately authorized. Next Gate 6
work is cob-external Upstream U1. The portable proposal is
[UPSTREAM-U1.md](./UPSTREAM-U1.md). Do not implement `agentControl/*` inside cob.
Re-measure Gate 6 on isolated `:18791` only after Codex ships that driver.

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

English identifiers in code. Picker allowlist, 256k catalog cap, and Ollama
effort levels are implemented; do not reopen them as cosmetics. Default to
stability and throughput on the working Ollama-Desktop path. Ollama-thread
compact shrink is specified in [COMPACTION.md](./COMPACTION.md). Do not
implement OpenCodex `ocx1` / Fernet impersonation / `nativeAlias` / root
config writes.

The 26.810 → 26.818 Desktop hop is recorded in STATUS (picker + 0731 + V1
child on cob 0.1.6). Live global is cob **0.1.14** after an authorized scoped
install of tarball SHA-256
`0395b5df04bd30e4cc825c17c1f6de6392a3a2fe17d82becb87a6a1426ad83ec`
(pid **54105**). Fail-closed JSON/encrypted-wire is live; `apply_patch` and
`native_plaintext_spawn` stay off on `~/.codex`. Pack excludes `gate6h` and
`eval-*`. PATH Codex 0.149.0 and Desktop 0.149.0-alpha.4.3 validate catalog
`9748309e…` (bytes unchanged at install). Host-network `cob status` is `ok`.
Current root SHA baseline is `989c27f9…` (Desktop/user; cob did not write it).
G11 pass; G12 default-on and exact-global 0.1.13 rollback pass; G13 partial;
G14 pass; G15 partial; G16 isolated-pass; G17 same-corpus pass with no default
change. Do not credit the 0.1.14 install with those gates. Do not repack
0.1.11–0.1.14. Future app updates can still drop overlay or hide
`ollama/...`; then `cob status` must say why. Do not patch the app binary or
use `nativeAlias` to paper over an update. Reboot is not cob autostart;
`cob start` brings the gateway back.
