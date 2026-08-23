# Status — 2026-08-23

Living checkpoint. Product contract stays in [README.md](./README.md). Live
gold standards stay in [LIVE-TESTING.md](./LIVE-TESTING.md). Agents start at
[AGENTS.md](./AGENTS.md). Release cut: [RELEASE.md](./RELEASE.md). History:
[CHANGELOG.md](./CHANGELOG.md).

Priority: **stability and throughput** of the working Desktop+cob path.
Picker polish, native GPT, GPT→0731 V1 spawn, and the 26.818 app hop are
recorded below. Next live gap is G8 compact shrink.

**This Desktop hop is proven** (26.810.52044 → **26.818.22352**, bundled
`codex-cli` 0.148.0-alpha.9 → **alpha.21**, 2026-08-20 evening). Picker still
lists 0731, native parent and V1 child still hit cob **0.1.6**, overlay keys
and user-owned `[agents]` defaults survived the app rewrite. cob pid did not
change (gateway is not the app). A later update can still drop overlay or
hide `ollama/...` (19694-class); then `cob status` must say why. Reboot
recovery stays `cob start` — no launchd. Do not patch ChatGPT.app or steal
native slugs to “survive” an update.

## Surfaces

| Surface | Version / note |
| --- | --- |
| cob gateway | loopback `127.0.0.1:18790` (live global **0.1.7**, pid **49194**), Ollama-thread summarize compact. Dev isolate: `cob start --dev` → `~/.codex-cob-dev` port **18791**. |
| Codex CLI | 0.147.0 — `codex --profile cob` loads `~/.codex/cob.config.toml` |
| ChatGPT Desktop | **26.818.41509** (WP0 2026-08-23), bundled `codex-cli 0.149.0-alpha.4.1`. Earlier gold hop: 26.818.22352 / alpha.21 |
| Ollama | **0.32.15** (`/v1/responses`; tags `deepseek-v4-flash:0731-cloud` + `:cloud`). 0.32.14→0.32.15 on 2026-08-21; cob unchanged. |
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
  hide that slug on 26.810.52044 or on **26.818.22352**. OpenCodex
  `nativeAlias` (stealing a bare `gpt-5.6-*` id) is **not** the picker fix
  here and must not become cob default.
- **Desktop update hop (2026-08-20 evening):** ChatGPT **26.818.22352** /
  bundled `codex-cli 0.148.0-alpha.21` on live cob **0.1.6**. `cob: ok`,
  overlay still `openai_base_url` + `model_catalog_json`, `[agents]`
  `default_subagent_model` / `default_subagent_reasoning_effort` still
  present, `multi_agent_v2 = false`. Desktop rewrote `config.toml` (SHA
  changed; persisted `model = ollama/deepseek-v4-flash:0731-cloud` and
  `model_reasoning_effort = "high"`). User: main chat, picker, and subagent
  create still work. Wire: luna parent `target=native`; 0731 child
  `target=ollama` first turn `input_n=3` `effort=high` `tools_n=15`
  `instr_sha=a46b8e00`. Gateway pid **39122** unchanged across the app
  update.
- **Desktop native GPT (luna high, 2026-08-20 afternoon):** after ChatGPT
  credits returned, a `gpt-5.6-luna` `effort=high` thread hit cob
  `target=native` (`tools_n=0`, `b_tools=0`). Native body is byte-forwarded
  (cob does not force `store: false`). Desktop tools on that path show up as
  `custom_tool_call` in `input_by`, not cob `tools[]`. Isolated CLI `exec` is
  still a separate trace. Picker success alone remains insufficient; this
  wire trace is the native gold that quota had blocked.
- **Desktop GPT parent → 0731 V1 child (luna xhigh, 2026-08-20 evening):**
  parent `gpt-5.6-luna` `effort=xhigh` `target=native` (stable zstd magic
  `…80c37`, `tools_n=0`, `custom_tool_call` growing ~16→27 while decoded
  ~220k→293k). Child `ollama/deepseek-v4-flash:0731-cloud` `target=ollama`,
  `b_instr=17947` / `instr_sha=a46b8e00` / `tools_n=14` / `tools_sha=1d7fd3c9`
  (Direct set, no 168-tool flatten). First child turn `input_n=3`; later
  child turns used `function_call`. `[cob] ollama wire` published
  (`promoted_n=0`); no `encrypted_content_unsupported`. Child `effort` was
  `high` then `max` (spawn thinking, not cob mapping of parent `xhigh`).
  Child `prev_id=0` (Desktop sent full child `input`, cob DAG unused).
  Codex sidebar `threadId` is the luna parent; the child is an `agent_id`
  observed via parent `send_input` / `wait_agent`, not `list_threads`.
  Closing then reopening the same `agent_id` 404 is Codex lifecycle, not
  cob. `agents/*.toml` was not required. Isolated L3 harness and G3 packet
  dump of Ollama headers remain separate traces; cob still allowlists
  Ollama headers in code.
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

- **Isolated L3 harness** and a header dump of the Ollama upstream request
  (LIVE-TESTING G3) for this same GPT→0731 topology. Desktop cob logs already
  show G1 + G2 + child tools and no encrypted Ollama reject. G7–G8 on the
  **child** thread were not this run.
- **G8 follow-up shrink** (`replay_ratio << 1` on the Ollama `/v1/responses`
  cob emits). **2026-08-23 20:15 Desktop auto-compact** on 0731 (live cob
  `0.1.6`, thread `edd` long-read goal) failed before a handoff: Codex sent
  `compaction_trigger` on `input_n=365` (`function_call:146` /
  `function_call_output:146`, decoded ~1.14MB, `effort=max`). The summarizer
  wire was correct (`tools_n=0`, `wire_bytes=1121005`, no trigger). 0731
  still emitted a tool call; cob returned
  `compaction_summary_invalid` / `requires_full_context` and Desktop stalled
  with that message. No envelope, no follow-up, no `replay_ratio`. Isolated
  L5 harness still unrun. Native GPT compact stays ChatGPT passthrough.
- **Ollama parent → GPT child** — out of product; still unsupported.

## Desktop trial (this machine)

User-owned, reversible, **not** a cob product path:

- Overlay keys live in `~/.codex/config.toml` (before the first TOML table).
- Backup: `~/.codex/config.toml.pre-cob-desktop-20260819`
- Revert: copy the backup over `config.toml`, fully quit and reopen ChatGPT.
- Gateway must stay up on the port in `openai_base_url`.

## Durability

**26.810.52044 → 26.818.22352 is done** on this machine (picker, native
parent, 0731 V1 child, overlay keys kept). Pin/re-verify the **current**
ChatGPT build after the next upgrade.

Still true:

1. **ChatGPT / Codex fully quit and reopen** (without an update) — cob is
   not the app; this hop already relaunched Desktop while cob pid **39122**
   stayed. A later cold quit is optional confirmation, not a blocker.
2. **The next `codex update` / Desktop auto-update** — new bundled
   `app-server` must keep listing `ollama/...` from `model_catalog_json`. A
   19694-style allowlist regression is a compatibility break, not a cob
   spawn-window bug.
3. **Desktop config rewrite** — this hop persisted `model` /
   `model_reasoning_effort` and **did not** drop `openai_base_url` /
   `model_catalog_json` or the user-owned `[agents]` spawn defaults. If a
   later rewrite drops those keys, that is the durability bug (detect +
   user-owned restore), not cob writing `config.toml` as a product default.

Reboot / a dead cob process is **not** an autostart product. Run `cob start`.

`cob status` **detects** overlay rewrite and a stopped gateway: first line
`cob: ok|ready|broken|absent|unreadable`, exit 1 when this Codex home needs
action. It read-only inspects root `model_provider`, `openai_base_url`, and
`model_catalog_json` against the live gateway port and cob catalog. Missing
or mismatched keys print `desktop overlay: broken` plus a user-owned restore
hint. Gateway down with keys still pointing at cob prints
`desktop overlay: ready` (`cob: ready`). Default `cob status` does not spawn
Codex or probe Ollama.

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
Same ChatGPT Desktop 0.148.0-alpha.9 (pre-26.818), first short turn:

| Path | `input_tokens` | Advertised window | Bar |
| --- | --- | --- | --- |
| Native `gpt-5.6-luna` / `sol` | ~17–20k (ChatGPT usage; often some cache) | 258400 | ~7% |
| 0731 (2026-08-19, 1M catalog) | ~61557 | 996147 | ~6% |
| 0731 (2026-08-20, 256k cap) | ~61612 | 243200 | ~26% |

The ~61k 0731 first-turn meter was already there on 1M; 0.1.2 only shrank the
denominator. Gateway zstd bodies match the split (~17–19 KB native vs ~50 KB
0731). cob `base_instructions` on 0731 is cob-owned
(`OLLAMA_BASE_INSTRUCTIONS`, 290 characters). Do not treat the
26% bar as previous-chat leakage.

## Next live work

0. **G8 on the compacted 0731 thread** — cob **0.1.7** is installed
   globally (pid **49194**, health ok; recut same evening to drop Codex
   `client_metadata` / `stream_options`). Live `cob status` is `unknown`:
   PATH Codex 0.147.0 rejects the Desktop 0.149 candidate (native row
   missing `supports_parallel_tool_calls`). cob kept the last catalog and
   wrote no sidecar. Overlay still `ok`. Do not repair native rows. G8 is
   still the WP7 broker, now with a named failure stage: **summarizer
   extract**, not tools leak or envelope leak.
   2026-08-23 20:15 auto-compact: inbound `compaction_trigger` after ~1.14MB
   / 146 tool pairs; outbound summarizer `tools_n=0`; 0731 called a tool;
   cob refused the handoff. cob **0.1.7** flattens those tool items to notes
   and accepts mixed text+tool output. Prompt, effort, 256k cap, and
   threshold are unchanged. Isolated L5 still useful as a recorded harness.
   Native GPT compact stays ChatGPT passthrough. WP0 2026-08-23 evening:
   Desktop is now `26.818.41509` / bundled `0.149.0-alpha.4.1`. Root-config
   SHA `1c4bacffddc1679d11f1c8b8c3623f0876eb1dd577936f1517f7a9ce6c809839`
   was recorded and not written by cob. A later same-evening read-only check
   saw `996771deaf2f8aa28ce8c24ff505ed72d70ea53f0c9e2b978fa8e49c3f93147c`
   after the 0731 auto-compact stall (Desktop/user rewrite).
1. **G11 catalog provenance / G12 search default / G13 Ollama boundary /
   G14 timeouts / G15 hot-path** — shipped in cob **0.1.7** as isolated
   coverage. Search defaults on for new/missing cob.toml; existing explicit
   false is preserved. Live-proven only after the G11–G16 procedures in
   LIVE-TESTING. G17/WP7 stays blocked on live G8 compact shrink.
   Research on 2026-08-23 saw Desktop `26.818.41509` / bundled
   `0.149.0-alpha.4.1` vs this file's 26.818.22352 / alpha.21 snapshot;
   refresh WP0 before calling those gates shipped.
2. **The next Desktop/Codex update** — re-verify picker + 0731 + spawn, or
   `cob status` explains the break. Do not pack cob for an app update that
   already kept overlay.
