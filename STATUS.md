# Status — 2026-08-24

Living checkpoint. Product contract stays in [README.md](./README.md). Live
gold standards stay in [LIVE-TESTING.md](./LIVE-TESTING.md). Agents start at
[AGENTS.md](./AGENTS.md). Release cut: [RELEASE.md](./RELEASE.md). History:
[CHANGELOG.md](./CHANGELOG.md).

Priority: **stability and throughput** of the working Desktop+cob path.
Picker polish, native GPT, GPT→0731 V1 spawn, and the 26.818 app hop are
recorded below. WP8 Ollama response integrity shipped in cob **0.1.11**
(isolated G19 **25/25**). The first G11–G17 cut exposed two 0.1.11 Ollama
0.32.15 continuation gaps: DONE-less completed SSE, and string-history replay
into `input[]`. Both are fixed in live global cob **0.1.12** after an
authorized install-only cut plus a live two-turn Ollama smoke. G18 remains the
cob **0.1.9** hosted-search gold and live G8 remains the cob **0.1.7**
default-path gold. G11–G17 stay blocked/partial/unrun except the G14
stream/continuation smoke recorded below. No remaining gate is inferred from
installation. A later read-only check found pid 21099 stale and `:18790`
closed; 0.1.12 remains globally installed, but the listener must be recovered
with global `cob start` before further live gates.

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
| cob gateway | global **0.1.12** is installed; the last smoke used pid **21099**, but a later check found that pid stale, `127.0.0.1:18790` closed, and health unreachable. Recovery: global `cob start`. Dev isolate: `cob start --dev` → `~/.codex-cob-dev` port **18791**. |
| Packed candidate | **0.1.12**, 43-file tarball SHA-256 `684db47f34cdafd246699639d1996c79b91a5fd8b048833b7aaa9d15f507dbb6`; globally installed 2026-08-24; live two-turn Ollama smoke PASS. |
| Source checkpoint | **Pending user authorization.** Git `HEAD` is `64a0274` (0.1.8); current 0.1.12 source is a dirty worktree with 35 tracked modifications and four untracked source/test files. Exact 0.1.9–0.1.12 tarballs remain local. |
| Codex CLI | 0.147.0 — `codex --profile cob` loads `~/.codex/cob.config.toml` |
| ChatGPT Desktop | **26.818.41509** (WP0 2026-08-23), bundled `codex-cli 0.149.0-alpha.4.1`. Earlier gold hop: 26.818.22352 / alpha.21 |
| Ollama | **0.32.15** (`/v1/responses`; tags `deepseek-v4-flash:0731-cloud` + `:cloud`). 0.32.14→0.32.15 on 2026-08-21; cob unchanged. |
| Spawn slot | `cob.toml` `[subagents].models` → `ollama/deepseek-v4-flash:0731-cloud` |

Live 0.1.9 contains the exact native-only `POST /v1/alpha/search`
compatibility route required by Codex `web.run` when `openai_base_url` points
at cob. G18 passed after the packed global install; `supports_search_tool`
remains the separate deferred-tool mechanism.

Desktop starts `codex app-server` **without** `--profile cob`. Named-profile
activation is CLI/TUI only. There is no `CODEX_CONFIG_PROFILE` (see
[openai/codex#38104](https://github.com/openai/codex/issues/38104)).

`cob` still does not write `~/.codex/config.toml`. `cob restore` does not
revert a user-owned Desktop trial.

## Proven

- **Post-release reproducibility/liveness audit (2026-08-24):** exact tarballs
  0.1.9 through 0.1.12 are present locally and match the recorded hashes; the
  claim that later tarballs were absent was false. Git still ends at the 0.1.8
  checkpoint (`64a0274`), while 35 tracked and four untracked files contain the
  later source, so a user-authorized source checkpoint is now the first process
  priority. A read-only live recheck found `cob 0.1.12 (global)` but no listener
  on `:18790`; pid 21099 was stale and health was unreachable. This does not
  invalidate the timestamped install smoke below, but it is the current
  operational state.

- **Live 0.1.12 install + two-turn Ollama smoke (2026-08-24):** exact tarball
  SHA-256 `684db47f34cdafd246699639d1996c79b91a5fd8b048833b7aaa9d15f507dbb6`
  (43 files, 37 production JS) replaced global cob after the 0.1.11 listener
  was already down. `cob version` is `cob 0.1.12 (global)`. Gateway pid
  **21099** on `127.0.0.1:18790` reports health `ok`; Desktop overlay is `ok`;
  `:18791` stayed down. Root `config.toml` SHA-256 remained
  `6ae7ff46867ae81073af18106b49a82f3d19aafc642e80eb263764dd03a9b418`.
  `cob status` first line is still fail-closed `unknown` (PATH 0.147 vs Desktop
  0.149 near `supports_parallel_tool_calls`); last-good catalog was retained
  and not repaired. Live smoke through `:18790` to
  `ollama/deepseek-v4-flash:0731-cloud`: streamed first turn HTTP 200 with
  `response.completed` and exactly one client `[DONE]`, no
  `upstream_stream_error`; JSON continuation HTTP 200 with no
  `cannot unmarshal string`; checkpoints 6→8; Ollama access-log
  `POST "/v1/responses"` 295→297. This is not G11–G17 closeout and not a
  Desktop reopen.
- **Packed 0.1.12 real-Ollama compatibility gate (2026-08-24):** exact
  43-file tarball SHA-256
  `684db47f34cdafd246699639d1996c79b91a5fd8b048833b7aaa9d15f507dbb6`;
  `npx tsc --noEmit` passed and `npm test` reported 340 tests, 337 passed,
  3 intentional skips, 0 failures. The extracted packed runtime ran on an
  isolated random loopback port and private state directory against real
  Ollama 0.32.15 / `deepseek-v4-flash:0731-cloud`. The upstream closed the
  valid SSE after `response.completed` with no `[DONE]`; cob produced no
  `upstream_stream_error`, published one checkpoint before emitting exactly
  one client `[DONE]`, promoted archived string shorthand to a typed user item,
  and completed the real `previous_response_id` follow-up with HTTP 200. The
  Ollama access-log counter increased by 2 and the checkpoint count by 1→2.
  Live `:18790` stayed cob 0.1.11 pid 7869, `:18791` stayed down, and root
  config SHA remained
  `6ae7ff46867ae81073af18106b49a82f3d19aafc642e80eb263764dd03a9b418`.

- **Live 0.1.11 install-only cut (2026-08-24):** exact tarball SHA-256
  `71b4e3f1963182d73097e5bac0e3ac67cd536e9f7ad5f4301dbca510fdc458db`
  (43 files) replaced global cob after the previous 0.1.9 listener was already
  down. `cob version` is `cob 0.1.11 (global)`. Gateway pid **7869** on
  `127.0.0.1:18790` reports health `ok`; Desktop overlay is `ok`; `:18791`
  stayed down. Root `config.toml` SHA-256 remained
  `6ae7ff46867ae81073af18106b49a82f3d19aafc642e80eb263764dd03a9b418`.
  `cob status` first line is still fail-closed `unknown` (PATH 0.147 vs Desktop
  0.149 near `supports_parallel_tool_calls`); last-good catalog was retained.
  This is not G11–G17, not a Desktop reopen, and not a new G19 live claim.
- **Packed WP8/G19 (2026-08-24):** cob **0.1.11** passed
  `npx tsc --noEmit`; `npm test` reported 337 tests, 334 passed, 3 intentional
  skips, and 0 failures. The inspected 43-file tarball SHA-256 is
  `71b4e3f1963182d73097e5bac0e3ac67cd536e9f7ad5f4301dbca510fdc458db`.
  G19 passed 21 protocol-conformance lanes, 3 packed live-route lanes, and 1
  real Codex task-effectiveness lane: declared direct/search/V1/MCP aliases
  continued, every undeclared or malformed lane failed closed without state,
  success `[DONE]` followed durable publication, and logs disclosed no tool
  name/schema/arguments/content/auth. The dev evidence manifest SHA-256 is
  `50f5e240fed1dfaac68a02cddbea6ffd84370d842df5345e0ca8bc57b7b78d7a`;
  port 18791 was stopped afterward. Root `config.toml` stayed
  `6ae7ff46867ae81073af18106b49a82f3d19aafc642e80eb263764dd03a9b418`.
  Candidate **0.1.10** was rejected when G19 found clear tool names in standard
  request/wire diagnostics; it was never installed. 0.1.11 retains aggregate
  byte/count/SHA metrics but exposes only sorted tool-definition byte sizes.
- **CLI overlay:** `codex exec --profile cob` against real `$CODEX_HOME` hits
  `http://127.0.0.1:18790/v1` (`gpt-5.6-sol` logged `target=native`).
- **Standalone hosted search (G18, 2026-08-23 22:44–22:50 release window):** global cob
  **0.1.9** pid **86967** served a narrow native `web__run` docs search and
  opened the usable official OpenAI web-search page. The live log recorded
  only content-free `POST /v1/alpha/search ... target=native-search` metrics;
  no query, result body, authorization, or account ID. `/alpha/search`,
  `/v1/alpha/search/`, and `/v1/alpha/search/child` each returned 404 with a
  fake local credential and did not increment the native-search counter.
  Search never routed to Ollama. Root `config.toml` SHA-256 remained
  `6ae7ff46867ae81073af18106b49a82f3d19aafc642e80eb263764dd03a9b418`
  across stop/install/start, G18, and the live smoke set. This proves G18,
  not G12 or G11–G17 generally.
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
  thread, ~17:29). The stored handoff on that 2026-08-19 run started as
  source-like text, not a conversation recap — summarizer quality, not
  envelope transport. `@thread` / `read_thread` is a Codex tool gap on the
  Ollama parent; cob compact does not load other Desktop threads.
- **Desktop auto-compact follow-up shrink (G8):** 2026-08-23 20:29 local,
  live cob **0.1.7** pid **49194**, 0731, checkpoint
  `cob_cmp_6bebd81b54f9377ddb3de5bcac3647ff`. Last pre-compact turn
  `b_input=1152853` / `input_n=360` / `wire_bytes=1167851`. Trigger inbound
  `b_input=1121805` / `input_n=365` / 146 tool pairs. 0.1.6 same-thread
  retries still logged `wire_bytes=1121005` `tools_n=0` then fail-closed.
  0.1.7 flatten summarizer `wire_bytes=266304` `tools_n=0`. Codex-facing
  archive is SSE with `cob1.` on `output_item.added` / `done` /
  `response.completed`; no Fernet / `ocx1`. Checkpoint
  `provenance.source=ollama-summary`, `isCompactionReplacement`, replacement
  history length 1, `requestInput` ~1.12MB (archive only; not replayed).
  First continuation inbound `b_input=32885` / `input_n=7` /
  `input_by=compaction:1,message:developer:1,message:user:5`. Next Ollama
  wire `wire_bytes=48206` `tools_n=17`, then later turns kept `compaction:1`
  and grew new tool pairs. `replay_ratio` `32885/1121805 ≈ 0.029` (inbound
  input) and `48206/1167851 ≈ 0.041` (first logged follow-up wire). Upstream
  exact tokens were omitted (`ollama usage` line absent). User continued
  after compact. Isolated L5 harness still unrun. G17 quality is not this
  gate.
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

- **G11:** controlled sidecar/status/rollback lanes passed, but live
  regeneration is blocked because PATH Codex 0.147 rejects the Desktop 0.149
  catalog near `supports_parallel_tool_calls`. Last-good catalog is retained;
  native rows were not repaired. Desktop picker/routing after a successful
  regeneration therefore remains unproven.
- **G12:** blocked before the required full Desktop quit/reopen and three-turn
  deferred MCP + V1 execution trace. The explicit-false rollback was not
  credited. G18 hosted search remains separate.
- **G13:** cloud low/high/max and the deterministic request/error boundary
  passed; the Ollama daemon access log independently confirms the three real
  `/v1/responses` calls. The local-model lane is unavailable because this
  machine has cloud tags only.
- **G14:** controlled headers, idle, disconnect, and backpressure lanes passed.
  Live 0.1.11 failed valid DONE-less SSE publication; packed 0.1.12 fixes and
  passes a real two-turn stream/continuation. The full long-cloud live gate is
  still pending after an authorized global 0.1.12 install.
- **G15:** WP5A catalog cache showed identical output and a repeatable win;
  WP5B metrics was ~9% slower and WP5C SSE was equal in the measured fixture.
  No blanket G15 performance pass is claimed.
- **G16:** isolated three-turn/compact continuation and value/provenance/
  identity tamper matrix passed; each tamper failed closed without a new
  checkpoint and valid restore continued. This is isolated evidence, not a
  Desktop live claim.
- **G17:** not run. Defaults remain the G8 path; no effort/context toggle is
  promoted.
- **Isolated L3 harness** and a header dump of the Ollama upstream request
  (LIVE-TESTING G3) for this same GPT→0731 topology. Desktop cob logs already
  show G1 + G2 + child tools and no encrypted Ollama reject. G7–G8 on the
  **child** thread were not this run.
- **G8 follow-up shrink** is recorded on live cob **0.1.7** (see Proven). The
  earlier **2026-08-23 20:15** 0.1.6 auto-compact on 0731 is a named
  extract failure (`tools_n=0`, `wire_bytes=1121005`, tool call, no
  envelope). Isolated L5 harness still unrun. Native GPT compact stays
  ChatGPT passthrough.
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
`cob: ok|ready|stale|unknown|broken|absent|unreadable`, exit 1 when this Codex
home needs action. It read-only inspects root `model_provider`, `openai_base_url`, and
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

0. **0.1.12 is globally installed; its recorded smoke passed, but the listener
   is currently down** —
   live G8 passed on cob **0.1.7**
   (20:29 flatten handoff + follow-up shrink). cob **0.1.8** packed Stages
   2–4; live **0.1.9** hardens failed catalog provenance, `tool_choice`,
   compact skeleton validation, repeated-ID state merge, alias telemetry, and
   exact hosted-search routing. Its isolated merge gate and live install are
   not a G11–G17 claim. G18 is separately proven above. WP8 now rejects
   client tool calls absent from the exact final outbound catalog before
   relay/checkpoint publication. Packed G19 passed on 0.1.11. The attempted
   G11–G17 cut then found the DONE-less completed-SSE and string-replay gaps.
   Packed and now-installed 0.1.12 fixes both; the live two-turn smoke passed.
   That does not close G11–G17.
   Defaults stay on the G8 path: omitted summarizer effort (wire `high`),
   256k active cap, no cloud max advertisement, no
   `auto_compact_token_limit`. Incomplete skeletons fail closed
   (`compaction_summary_incomplete`) without resending history. Isolated
   L5 still useful as a recorded harness.
   Native GPT compact stays ChatGPT passthrough.
   Current `cob status` is intentionally non-ready `unknown` (exit 1): PATH Codex
   0.147.0 rejects the Desktop 0.149 candidate near
   `supports_parallel_tool_calls`. Live 0.1.12 retains the last-good catalog
   (`07c189597516…`) and recorded the rejection redacted in
   `cob-catalog.meta.json` schema v2 with both validator identities. Gateway
   health is currently unreachable; the Desktop overlay keys remain configured
   and are reported ready once the gateway is recovered. Do not repair native
   rows. WP0 2026-08-23 evening: Desktop `26.818.41509` /
   bundled `0.149.0-alpha.4.1`. The release window root-config SHA was
   `6ae7ff46867ae81073af18106b49a82f3d19aafc642e80eb263764dd03a9b418`
   before and after every cob operation. Earlier historical SHAs remain in
   the baseline section above as Desktop/user rewrites.
1. **Preserve the 0.1.12 source checkpoint with explicit user authorization** —
   verify the rebuilt production payload against the retained exact tarball,
   record the intentional post-release documentation delta, then commit the
   TypeScript, tests, and documentation. Do not tag, push, publish, or
   manufacture retroactive release-source commits from production tarballs.
2. **Recover the listener and align consumers** — before live work, use the
   globally installed `cob start`, not a workspace start against live home.
   Resolve PATH 0.147 vs Desktop 0.149 by aligning the consumers; do not repair
   native catalog rows and do not weaken `unknown`/exit-1 readiness semantics.
3. **Rerun and close the remaining gates honestly** — do not repack 0.1.12.
   Fully quit/reopen ChatGPT Desktop where a gate needs picker/catalog judgment.
   The short two-turn smoke is not the full G14 long-cloud gate. G11 waits for
   compatible catalog validators; G12 waits for a full Desktop restart and real
   deferred-tool execution; G13 local lane waits for a local model; G15 has only
   WP5A as a measured win; G16 is isolated-pass; G17 still needs the same 0731 corpus.
   Keep defaults unchanged until G17. Do not add Chat Completions, a generic
   provider registry, speculative terminal repair, or an unsafe opt-out.
4. **The next Desktop/Codex update** — re-verify picker + 0731 + spawn, or
   `cob status` explains the break. Do not pack cob for an app update that
   already kept overlay.
