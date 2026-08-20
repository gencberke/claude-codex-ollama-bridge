# Status — 2026-08-20

Living checkpoint. Product contract stays in [README.md](./README.md). Live
gold standards stay in [LIVE-TESTING.md](./LIVE-TESTING.md). Agents start at
[AGENTS.md](./AGENTS.md). Release cut: [RELEASE.md](./RELEASE.md). History:
[CHANGELOG.md](./CHANGELOG.md).

Priority while this snapshot is current: **stability, performance, and
throughput** of the path that already works. Catalog picker polish (sol /
terra / luna / 0731, 256k cap, DeepSeek effort ladder) is **live on 0.1.2**.
It is not native GPT gold.

**Important subtask (not low-priority):** prove the working Desktop+cob path
**survives Codex updates and ChatGPT/Codex quit–reopen**, without a one-shot
manual overlay. Today the app binary is stock; durability is unproven. Desktop
rewrites `config.toml`, `app-server` ignores `--profile cob`, and cob is a
separate process on `openai_base_url`. After an update or a cold start, picker
and 0731 routing must still hit cob, or `cob status` must say why not. Do not
patch ChatGPT.app or steal native slugs to “survive” an update.

## Surfaces

| Surface | Version / note |
| --- | --- |
| cob gateway | loopback `127.0.0.1:18790` (live global **0.1.5**), Ollama-thread summarize compact. Dev isolate: `cob start --dev` → `~/.codex-cob-dev` port **18791**. |
| Codex CLI | 0.147.0 — `codex --profile cob` loads `~/.codex/cob.config.toml` |
| ChatGPT Desktop | 26.810.52044, bundled `codex-cli 0.148.0-alpha.9` |
| Spawn slot | `cob.toml` `[subagents].models` → `ollama/deepseek-v4-flash:0731-cloud` |

Desktop starts `codex app-server` **without** `--profile cob`. Named-profile
activation is CLI/TUI only. There is no `CODEX_CONFIG_PROFILE` (see
[openai/codex#38104](https://github.com/openai/codex/issues/38104)).

`cob` still does not write `~/.codex/config.toml`. `cob restore` does not
revert a user-owned Desktop trial.

## Proven

- **CLI overlay:** `codex exec --profile cob` against real `$CODEX_HOME` hits
  `http://127.0.0.1:18790/v1` (`gpt-5.6-sol` logged `target=native`).
- **Desktop picker:** after a **user-owned** copy of cob keys into root
  `config.toml` (`model_provider = "openai"`, `openai_base_url`,
  `model_catalog_json`), Desktop listed `ollama/deepseek-v4-flash:0731-cloud`.
  [openai/codex#19694](https://github.com/openai/codex/issues/19694) did **not**
  hide that slug on this build. OpenCodex `nativeAlias` (stealing a bare
  `gpt-5.6-*` id) is **not** the picker fix here and must not become cob
  default.
- **Desktop Ollama parent:** DeepSeek 0731 turns reach cob `target=ollama`.
  Simple chat ≈ one Ollama `/v1/responses`; a web-search turn ≈ two model
  calls plus a separate Codex `web search` meter. Codex Cloud usage attributes
  the slug (e.g. 68→72 on 0731). That is Codex request counting under provider
  `openai`, not proof of Ollama GPU/token billing.
- **Desktop `/compact` on 0731 (G7):** 2026-08-19 17:26 local. Log
  `compaction provider: ollama/deepseek-v4-flash:0731-cloud` (not native).
  Checkpoint `provenance.source = "ollama-summary"`, `isCompactionReplacement`,
  history length 1, Codex-facing `encrypted_content` starts `cob1.1.`. Archive
  under `cob-state/compact-archive/`. Post-compact 0731 turns ran (same
  thread, ~17:29). Isolated L5 and G8 `replay_ratio` are still open: Codex→cob
  bodies stayed tens of KB (tools dominate). The stored handoff on this run
  started as source-like text, not a conversation recap — summarizer quality,
  not envelope transport. `@thread` / `read_thread` is a Codex tool gap on the
  Ollama parent; cob compact does not load other Desktop threads.
- **Catalog without `--profile`:** once root `model_catalog_json` is set,
  `codex debug models` lists the Ollama rows.
- **0.1.3 live gateway (this machine):** global `cob 0.1.3` on `:18790`.
  Desktop 0731 ping thread (2026-08-20 02:37, `ping` then `second half: ping`,
  no web search): decoded **239324** bytes, **`b_tools=205709` (190 tools)**,
  `b_input=32200`, `b_instr=209`, `effort=high`, `prev_id=0`. Desktop
  `last_in` **60269** then **60300** (window 243200). `tools_sha=f9d25928`
  unchanged on the second turn. User-owned plugin trim (sites + office
  connectors off): new chat `ping 2` (02:43) **`last_in=52927`**,
  `b_tools=178642` / **168 tools**, `tools_sha=fd100211`. Same-minute native
  luna posts: `tools_n=0`, decoded ~42–43 KB. Ollama `usage` line did not
  appear. No body dump. `desktop overlay: ok`.
- **0731 `supports_search_tool` lever (2026-08-20 09:26):** hand-flipped only
  the 0731 catalog row to `true` (no `cob start`/`sync`). New Desktop ping
  thread: `tools_n=17`, `b_tools=15368`, `tools_sha=770cfd26`, Desktop
  `last_in=11819` (~12k / 243200). Direct set included `tool_search` (3306 B)
  and `exec_command`; `spawn_agent` was deferred.   Catalog restored to `false`
  afterward. 0.1.4 shipped the opt-in catalog flag + wire shim. **0.1.5 live
  gold (2026-08-20 11:05, new 0731 thread
  `rollout-2026-08-20T11-05-52-…`):** ping `last_in=11316` (~11k);
  Direct `ls` on `light-work-doc-viewer` `last_in=12332` (~13k); unaided
  `spawn_agent` (`namespace=multi_agent_v1`) opened child Pasteur
  (`11-08-12`, child `last_in` 10860→11535, ~12k), parent ended ~24k
  (`last_in=24279`), no `echo ok` loop. Gateway `promoted_n=8` then 16
  (`tools_n` 17→25→33, not 168); `multi_agent_v1__spawn_agent` on the
  Ollama wire. GitHub: first issue-list turn used `gh` CLI; after an
  explicit `_search_issues` / MCP prompt, `mcp__codex_apps__github/_search_issues`
  ran (twice). Spawn + MCP **dispatch** are gold. Unprompted MCP-over-`gh`
  preference is not.

Desktop may persist picker choice back into root `config.toml` (`model =`,
`model_reasoning_effort`). That is ChatGPT rewriting user config, not cob.

## Not proven / blocked

- **Native GPT** on this Desktop/CLI build after the 2026-08-19 Codex refresh.
  ChatGPT usage limit blocked a native `exec` (retry after 2026-08-20 09:10
  local). Do not treat picker success as native passthrough gold.
- **Native GPT parent → Ollama V1 child** (LIVE-TESTING L3–L5: G1–G2, G7–G8,
  G10). Earlier CLI harness spawn is not Desktop gold.
- **G8 follow-up shrink** (`replay_ratio << 1` on the Ollama `/v1/responses`
  cob emits). Post-compact Desktop turns exist; upstream item/byte counts
  were not captured. Isolated L5 harness still unrun. Native GPT compact
  stays ChatGPT passthrough and still needs credits.
- **Ollama parent → GPT child** — out of product; still unsupported.

## Desktop trial (this machine)

User-owned, reversible, **not** a cob product path:

- Overlay keys live in `~/.codex/config.toml` (before the first TOML table).
- Backup: `~/.codex/config.toml.pre-cob-desktop-20260819`
- Revert: copy the backup over `config.toml`, fully quit and reopen ChatGPT.
- Gateway must stay up on the port in `openai_base_url`.

## Durability (important, not done)

Must still work after:

1. **ChatGPT / Codex fully quit and reopen** — cob process is not the app;
   overlays and `cob-catalog.json` must still be the catalog Desktop loads;
   port in `openai_base_url` must be the live gateway (or `cob start` recovers
   it).
2. **`codex update` / Desktop auto-update** — new bundled `app-server` must
   keep listing `ollama/...` from `model_catalog_json` and routing through
   loopback. A 19694-style allowlist regression is a compatibility break, not
   a cob spawn-window bug. Pin/re-verify this ChatGPT build (26.810.52044)
   after any upgrade.
3. **Desktop config rewrite** — the app already persists `model` and
   `model_reasoning_effort`. It must not silently drop `openai_base_url` /
   `model_catalog_json`. If it does, that is the durability bug to fix
   (detect + user-owned restore path), not cob writing `config.toml` as a
   product default.

`cob status` **detects** that rewrite: it read-only inspects root
`model_provider`, `openai_base_url`, and `model_catalog_json` against the live
gateway port and cob catalog. Missing or mismatched keys print
`desktop overlay: broken` plus a user-owned restore hint. Gateway down with
keys still pointing at cob prints `desktop overlay: ready`. This is not live
quit/reopen or update proof.

`cob restore` remaining overlay-only is still correct; durability is “the
trial keeps working across app lifecycle,” not “cob owns root config.”

## Catalog polish (live 0.1.2)

Picker **list** order is `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, then
the spawnable Ollama slug (default `ollama/deepseek-v4-flash:0731-cloud`).
`display_name` matches that slug. Other native and discovered Ollama rows stay
in the catalog with `visibility=hide`. Thinking Ollama rows advertise `none` /
`low` / `high` / `max` (default `high`); cob maps leftover Codex `medium` /
`xhigh` to `high` on the Ollama wire. Advertised context is
`min(tag context_length, 256000)` (Desktop effective window = that × 95% →
243200 on 0731). `nativeAlias` remains out of product.

Desktop context **bar** is `used / advertised`, not a cob transcript merge.
Same ChatGPT Desktop 0.148.0-alpha.9, first short turn:

| Path | `input_tokens` | Advertised window | Bar |
| --- | --- | --- | --- |
| Native `gpt-5.6-luna` / `sol` | ~17–20k (ChatGPT usage; often some cache) | 258400 | ~7% |
| 0731 (2026-08-19, 1M catalog) | ~61557 | 996147 | ~6% |
| 0731 (2026-08-20, 256k cap) | ~61612 | 243200 | ~26% |

The ~61k 0731 first-turn meter was already there on 1M; 0.1.2 only shrank the
denominator. Gateway zstd bodies match the split (~17–19 KB native vs ~50 KB
0731). cob `base_instructions` on 0731 is 207 characters. Do not treat the
26% bar as previous-chat leakage.

## Next live work

0. **Durability** — ChatGPT quit–reopen and a Codex/Desktop update (or a
   documented pin + re-verify). Picker + 0731 + spawn still hit cob, or
   `cob status` explains the break.
1. **G8 on the compacted 0731 thread** — one follow-up message; capture
   Ollama input = handoff + later turns (`replay_ratio << 1`), no
   `encrypted_content` / `cob1.` on Ollama. Isolated L5 still useful as a
   recorded harness. Native GPT compact stays ChatGPT passthrough.
2. Native GPT through cob on this build, **when credits return** (G1, byte
   passthrough, no `store: false` force on native).
3. GPT parent → 0731 child on Desktop or isolated L3 harness (G1–G5).
