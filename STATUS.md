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
default-path gold. G11 is complete on live 0.1.12. G12's default-on live path
passed, while its explicit-false rollback exposed a namespace dialect gap in
0.1.12. The exact 0.1.13 tarball is now the live global after an authorized
cut. Its affected G12 rollback retrace, G14 long-cloud package, and G17
same-corpus acceptance subsequently passed without a code or release change.
No gate is inferred from installation alone. Source checkpoint `e932eb1`
preserves installed 0.1.12. PATH Codex is 0.149.0, the catalog regenerated
without native-row repair, Desktop was fully reopened, and the live gateway
and overlay remain healthy. A later read-only check reports catalog provenance
`stale` because the selected Desktop producer file identity changed; no live
sync was performed during Gate 1-3 research.

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
| cob gateway | global **0.1.13**, pid **35004**, `127.0.0.1:18790`, host-network health `ok`, overlay `ok`; catalog provenance currently `stale` after a Desktop producer file-identity change. Dev isolate `:18791` is down. |
| Packed live | **0.1.13**, 43-file tarball SHA-256 `81a99bad0f645bffcb0bb2551dae3a86dc5cb4dd8869d8a713fe210823fd1c72`; globally installed 2026-08-24. G12 rollback, G14, and G17 later passed on this exact listener/artifact. |
| Prior live | **0.1.12**, 43-file tarball SHA-256 `684db47f34cdafd246699639d1996c79b91a5fd8b048833b7aaa9d15f507dbb6`; G11 + G12 default-on + two-turn smoke. Do not repack. |
| Source checkpoint | `e932eb19c551fbda96dc83fe7fe34840afff2371` on `master`; clean tree at handoff. Rebuilt production JS matched the retained 0.1.12 tarball byte-for-byte. No tag/push/publish. |
| Codex CLI | **0.149.0** — `codex --profile cob` loads `~/.codex/cob.config.toml` |
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

Current live root-config baseline is SHA-256
`b6ec9273e7dc6bf6eed82d34b45a33a3b7bf4269cbd607bde1761f9ec67c752b`
(Desktop/user rewrite after Gate 1-5 `b976c134…`). cob did not write it.
The Gate 6-H harness pre/post hashes matched this value. Catalog remains
`9748309e…`.

## Locked disposition (Gate 6)

- Gate 6 is **open/blocked**.
- Blocker: `controller_sequencing_observed` (`transport_unmeasured`).
- Historical isolated verdict name `codex_0_149_native_scheduler_blocked` is
  stronger than the traces support and is no longer emitted.
- cob transport queue: **not measured**.
- cob product change: **must not** add a queue or a fourth Sol prompt canary.
- Isolated Gate 7–10 canaries ran 2026-08-25 on `:18791` (see Proven). They
  are not product gold. Gate 6-H remains pack-excluded (`npm run gate6h`).
  Desktop hop stays separately authorized.

Next work is cob-external **Upstream U1**: find or design a Codex
collaboration runtime driver that, without a model choosing tools, runs
`spawn → send1 → send2 → wait → followup1 → wait → followup2 → wait`.
When that surface exists, re-measure Gate 6 on isolated `:18791`. If it
does not, write a portable V2 / upstream change proposal.

A 2026-08-24 read of PATH Codex 0.149.0 `codex app-server generate-json-schema
--experimental` listed 150 `ClientRequest` methods. None dispatches
`collaboration.spawn_agent`, `send_message`, or `followup_task`. Nearby
surfaces are the wrong layer: `codex queue` / `thread/queue/*` / `turn/steer`
are user turns on a thread; `collabToolCall` items only observe
model-initiated collab tools; `thread/inject_items` injects history, it does
not live-dispatch a child. `codex exec-server` is a remote environment, not
a collaboration driver.

## Proven

- **Isolated Gate 10 nested V2 FAIL (workspace only, 2026-08-25):** parent
  `rollout-2026-08-25T00-17-38-01a035a2-d51d-7390-a45d-a240695284f2.jsonl`
  spawned one 0731 child `/root/gate10_nested`
  (`rollout-2026-08-25T00-17-49-01a035a2-ffab-7931-971d-469260aa7f97.jsonl`,
  depth 1). Isolated catalog 0731 stayed `multi_agent_version=v1`. The child
  issued two `tool_search` queries for collaboration spawn tools and received
  only the GitHub namespace; it never called `spawn_agent`. No depth-2
  session and no `LEAF_NONCE`. Sol ended `GATE10_FAIL`. This is fail-closed
  nested V2, not an Ollama V2 catalog change. After the 7–10 ladder, dev
  `:18791` was stopped, isolated `cob.toml` restored to `4e9992e6…`, and live
  pid 35004 / catalog `9748309e…` / root config `b6ec9273…` were unchanged.
- **Isolated Gate 9 compact+continuation FAIL (workspace only, 2026-08-25):**
  isolated catalog 0731 window was lowered to 8192 for this drill only (live
  catalog stayed 256k / `9748309e…`). Parent
  `rollout-2026-08-25T00-15-31-01a035a0-e4a4-7d73-80d0-2595439e6547.jsonl`
  spawned `/root/gate9_compact`
  (`rollout-2026-08-25T00-15-40-01a035a1-0824-7870-9542-de871fad1ebc.jsonl`).
  The child `cat` of an 81k filler produced a truncated 20250-token exec
  output; Codex then sent `compaction_trigger`. cob routed it to the Ollama
  summarizer (`tools_n=0`); the first three attempts failed closed
  `compaction_summary_incomplete`. A later attempt logged `ollama compact ok`
  (`latency_ms=6444`, `summary_bytes=2056`, `cob1.` replacement history) and
  the follow-up `SECOND_NONCE` reached the same child, but the parent still
  observed compact errors on both waits and ended `GATE9_FAIL`. Spawn nonce
  `COB_GATE9_SPAWN_20260825_A1` never appeared in a child final. This is not
  live G8 and not `replay_ratio << 1` gold. The 8k window was reverted before
  Gate 10.
- **Isolated Gate 8 mid-flight cob restart PASS (workspace only,
  2026-08-25):** the valid canary is parent
  `rollout-2026-08-25T00-10-47-01a0359c-8d7f-7fa1-841d-2ad0a8f226e2.jsonl`
  and child
  `rollout-2026-08-25T00-10-55-01a0359c-abd1-7ce0-a19f-38ca69bc52d0.jsonl`
  (`/root/gate8b_replay`). After `wait_agent` and `/bin/sleep 55` were
  in-flight, workspace `cob stop --dev` / `cob start --dev` moved `:18791`
  from pid 24384 to 24903. The same child session then continued: sleep
  finished, `/bin/pwd` ran, nonce `COB_GATE8_20260825_R2` returned, and
  `wait_agent` completed `timed_out: false`. An earlier attempt restarted
  cob before `wait_agent` (not this proof); a first harness invoked
  `cli.js` with Python and never restarted cob. This is not L6
  `previous_response_id` expand after a completed turn, and not compact
  replay.
- **Isolated Gate 7 worktree FAIL `worktree_not_distinct` (workspace only,
  2026-08-25):** parent
  `rollout-2026-08-25T00-04-08-01a03596-7565-7623-9b57-7219b1d1dc91.jsonl`
  spawned one 0731 child
  `rollout-2026-08-25T00-04-19-01a03596-a3a8-7b01-a583-5f568a98f92c.jsonl`
  (`/root/gate7_worktree`). The child issued two native `apply_patch` calls
  plus matching outputs; fixtures `.cob-gate7-a.txt` / `.cob-gate7-b.txt`
  received the AFTER bytes at stable inodes. cwd stayed the parent repo
  (`/Users/gencberke/Documents/github/codex-ollama-bridge`); Codex 0.149
  did not give the child a distinct git worktree. Sol ended `GATE7_FAIL
  worktree_not_distinct`. Two child-native patches in the **shared** repo
  are a weaker observation, not Gate 7 gold. Fixtures were deleted after
  the ladder.
- **Isolated Gate 6-H harness FAIL / scheduler blocked (workspace only,
  2026-08-24):** `src/gate6h.ts` plus pack-excluded `src/gate6h.harness.ts`
  (`npm run gate6h`) reduce parent/child rollout JSONL and kill an attempt on
  `controller_sequencing_fail`. Three same-fixture isolated `:18791` attempts
  all failed that check: attempts 1–2 called `wait_agent` after the first
  `send_message` (parents
  `rollout-2026-08-24T23-44-02-01a03584-0e97-73a3-b30f-49c2ad7fc553.jsonl` and
  `rollout-2026-08-24T23-44-24-01a03584-65d6-7631-a423-957e87c43c8e.jsonl`);
  attempt 3 called `list_agents` before send2
  (`rollout-2026-08-24T23-44-46-01a03584-bdc1-73a0-817d-122badd02aae.jsonl`).
  Verdict `codex_0_149_native_scheduler_blocked`. This separates Sol
  controller sequencing from cob transport: cob was not asked to queue, and
  the second in-flight send was never issued. Wait for upstream portable V2
  or a direct collaboration driver. Do not add a cob queue. At that cut
  Gate 7–10 were not opened. Dev `:18791` was stopped; isolated `cob.toml` restored to
  `4e9992e6…`. Live pid 35004 and catalog `9748309e…` were unchanged. Root
  config during this harness was SHA-256
  `b6ec9273e7dc6bf6eed82d34b45a33a3b7bf4269cbd607bde1761f9ec67c752b` (a later
  Desktop/user rewrite after the Gate 1-5 `b976c134…` baseline); cob did not
  write it, and the harness pre/post hashes matched.
- **Isolated Gate 6 queued messaging FAIL (workspace only, 2026-08-24):**
  two isolated `:18791` canaries on PATH Codex 0.149.0 / `gpt-5.6-sol` /
  `ollama/deepseek-v4-flash:0731-cloud` did not prove two `send_message`
  deliveries while the same child stayed active, then two idle
  `followup_task` turns on that id. First parent
  `rollout-2026-08-24T22-05-06-01a03529-7d86-7d63-89f2-ae793696c96e.jsonl`
  spawned `/root/gate6_queue` once and did call two `send_message` plus two
  `followup_task` tools, but it inserted `wait_agent` after the first send;
  the child
  `rollout-2026-08-24T22-05-18-01a03529-abb7-7d41-9985-b0ff370d29ba.jsonl`
  emitted `FINAL_ANSWER` after only `SEND1`, and `SEND2` landed as `MESSAGE`
  at the same millisecond as `FOLLOW1` `NEW_TASK`. A stricter retry parent
  `rollout-2026-08-24T22-08-35-01a0352c-abd5-72f3-9a13-5bee891adf81.jsonl`
  called `wait_agent` after the first send instead of the second
  `send_message`; child
  `rollout-2026-08-24T22-08-47-01a0352c-da60-7552-8165-60bb888287a4.jsonl`
  completed after `SEND1` only. Sol ended `GATE6_FAIL` both times. Same
  child id, no second spawn, no nonce/alias leak in `cob-gateway.log`. This
  is not a cob drop of a second in-flight send: the second send was either
  issued after the child had already completed or never issued. Gate 2/3
  one-shot send/follow-up still stand. Dev `:18791` was stopped; isolated
  `cob.toml` restored to SHA-256 `4e9992e6…`; live pid 35004, root config
  `b976c134…`, and catalog `9748309e…` were unchanged. Gate 7–10 were not
  started.
- **Isolated Gate 5 child-native `apply_patch` PASS (workspace only,
  2026-08-24):** after an earlier negative control exposed a shell/temp-binary
  bypass, the separately authorized default-off `[catalog] apply_patch = true`
  lane advertised `apply_patch_tool_type=freeform` only on the configured 0731
  spawn row. cob translated the declared Codex custom tool to the fixed Ollama
  function alias and restored the custom call/output identity. Sol's real 0731
  child session `rollout-2026-08-24T19-02-15-01a03482-1557-7823-9e46-42952a784afa.jsonl`
  contains exactly one completed `custom_tool_call(name="apply_patch")` and
  its matching `custom_tool_call_output`; its only two `exec_command` calls
  were the exact read-only `sed` checks. The fixture inode stayed constant and
  its nonce/Unicode content changed from the expected BEFORE bytes to the
  expected AFTER SHA-256 `a020cf6b…`. The Sol root session
  `rollout-2026-08-24T19-02-06-01a03481-f125-7bb0-990f-a52f371c577e.jsonl`
  spawned once, waited once, verified once, and returned `GATE5_PASS`.
  The clean gateway log slice contained zero nonce, patch body, alias,
  heredoc, guard-error, or upstream-error matches. Dev `:18791` was stopped,
  the fixture was deleted, and the dev policy was restored byte-for-byte
  (`4e9992e6…`); live pid 35004, root config `b976c134…`, and catalog
  `9748309e…` were unchanged. This proves one child-native edit, not worktree,
  restart/replay, nested V2, or Desktop behavior.
- **Isolated native V2 Gate 4 interrupt PASS (workspace only, 2026-08-24):**
  no new shim or alias was needed; exact-fingerprint request preparation kept
  canonical `collaboration.interrupt_agent` and `list_agents` in the native
  namespace. Sol spawned one 0731 child with
  `COB_GATE4_INTERRUPT_ACTIVE_20260824_F19C`, delayed five seconds, and
  interrupted that same `/root/gate4_interrupt` identity exactly once. The
  interrupt returned `previous_status: running`; the one roster check returned
  `agent_status: interrupted`; Sol ended `GATE4_PASS`. The child session shows
  `/bin/sleep 60` beginning before the interrupt and returning `aborted by
  user`; `/bin/pwd` and `UNEXPECTED_CHILD_COMPLETION` never occurred. A
  host-process check found no matching orphan sleep. Dev `:18791` was stopped
  afterward; no catalog, live gateway, root overlay, package, or commit changed.
  This proves one active-child interrupt, not repeated/racing interrupts or
  restart/replay recovery.
- **Isolated native-plaintext V2 Gate 3 PASS (workspace only, 2026-08-24):**
  the exact Gate 1 fingerprint additionally exposed only
  `collaboration.followup_task` as a third non-reserved plaintext alias. Sol
  spawned one real 0731 child, waited for its first task to complete, then
  called `followup_task` exactly once on the same `/root/gate3_child` identity.
  The completed child resumed with
  `COB_GATE3_FOLLOWUP_SECOND_20260824_D82F`, preserved
  `Uyandır — İğüş 😀`, and ran a second `/bin/pwd`; both completed turns
  returned the repository path and Sol ended `GATE3_PASS`. The child session
  contains two plaintext `agent_message` inputs and the gateway trace grows to
  `agent_message:2`; no second spawn or active-child `send_message` occurred.
  Post-review hardening rejects a drifted `send_message` target schema and
  bare JSON mislabeled as SSE or malformed streaming `data:` before an alias or
  upstream snippet can leak. Final `npm test`
  reported 361 tests, 358 passed, 3 intentional skips, and 0 failures. The dev
  listener was stopped; live 0.1.13 pid 35004 stayed healthy and untouched,
  and root `config.toml` remained SHA-256
  `b976c13447c729fef9d984d9e64825debfe0729c46db0a89b52471626bd2654a`.
  This proves one completed-child follow-up, not repeated/queued follow-ups or
  the remaining lifecycle matrix.
- **Isolated native-plaintext V2 Gate 2 PASS (workspace only, 2026-08-24):**
  the same default-off policy and exact Gate 1 fingerprint additionally
  exposed only `collaboration.send_message` as a second non-reserved
  plaintext alias; `followup_task` and the other collaboration leaves stayed
  canonical/encrypted. Sol spawned exactly one real 0731 child and sent
  exactly one second message to that returned child id. The child opened an
  eight-second `/bin/sleep` tool window from its initial task, then received
  `COB_GATE2_SECOND_20260824_B73E` plus the exact Unicode line, ran
  `/bin/pwd`, returned both first/second marker sets and the repository path,
  and Sol ended `GATE2_PASS`. Structural traces show the same child history
  growing from `agent_message:1` to `agent_message:2`, then completing both
  tool-output turns without an Ollama guard/upstream rejection. `npm test`
  reported 359 tests, 356 passed, 3 intentional skips, and 0 failures. The
  dev listener was stopped afterward. Live `:18790` remained global 0.1.13
  pid 35004; root `config.toml` stayed at pre/post-trial SHA-256
  `b976c13447c729fef9d984d9e64825debfe0729c46db0a89b52471626bd2654a`.
  This proves one active-child second message, not idle/completed-child
  follow-up or the remaining lifecycle matrix.
- **Isolated native-plaintext V2 Gate 1 PASS (workspace only, 2026-08-24):**
  PATH Codex 0.149.0 ran a real `gpt-5.6-sol` root through
  `~/.codex-cob-dev` / `:18791`. The captured full `collaboration` namespace
  fingerprint was
  `5c58ad23b9b5d932368394cea56b157451a33226c0b6018971bebd146fc9b6f3`.
  With the default-off experiment enabled for that exact fingerprint, cob
  exposed only `spawn_agent` as a non-reserved plaintext alias, restored the
  native V2 identity plus `encrypted_function_args: []`, and projected the
  resulting plaintext `agent_message` to Ollama-safe `user` / `input_text`.
  Sol spawned one real `ollama/deepseek-v4-flash:0731-cloud` Codex child. The
  child received multiline nonce `COB_GATE1_20260824_E7B4A91C` plus Unicode
  fidelity text, executed the `/bin/pwd` harness tool, returned the exact
  markers/path, and Sol ended `GATE1_PASS`. The child also completed its
  tool-output continuation; no `agent_message` or non-empty
  `encrypted_content` reached Ollama. `npm test` reported 358 tests, 355
  passed, 3 intentional skips, and 0 failures. The dev listener was stopped
  afterward. Live `:18790` stayed global 0.1.13 pid 35004; root
  `config.toml` stayed at the pre/post-trial SHA-256
  `b976c13447c729fef9d984d9e64825debfe0729c46db0a89b52471626bd2654a`.
  This proves only the narrow spawn boundary. Ollama catalog rows remain V1;
  long-lived `send_message` / idle `followup_task`, interrupt, restart,
  replay/compact, worktree, nested V2, and Desktop activation are not claimed.
- **Live 0.1.13 install-only (2026-08-24):** exact tarball SHA-256
  `81a99bad0f645bffcb0bb2551dae3a86dc5cb4dd8869d8a713fe210823fd1c72`
  (43 files, 37 production JS) replaced global 0.1.12 after `cob stop`
  closed pid 21099. `cob version` is `cob 0.1.13 (global)`. Gateway pid
  **35004** on `127.0.0.1:18790` reports health `ok`; Desktop overlay is `ok`;
  provenance is fresh (Desktop `0.149.0-alpha.4.1` + PATH 0.149.0); `:18791`
  stayed down. At install time root `config.toml` SHA-256 remained
  `70b109578a83de533fa40e433efb5a4a08892cd675e62a18adbda8f2cf22e776`.
  Catalog SHA-256 remained
  `9748309ea0e42c278d9e07dc71eef9c7b1c4a2fb3cb4cff84c026aa1624a3de9`.
  Installation alone was not G12/G14/G17 evidence. Before those later tests,
  Desktop/user activity changed the root file to current baseline
  `d24f79f474efab36f1f9d4120d276f6e064875120a50de17db5fef1dcf24fc2e`;
  no cob live-home operation made that change, and those closeout gates
  preserved it. Later Desktop/user activity established the Gate 1-5 baseline
  `b976c13447c729fef9d984d9e64825debfe0729c46db0a89b52471626bd2654a`;
  every isolated research gate preserved that newer value.
- **0.1.12 source/catalog/Desktop recovery (2026-08-24 ~04:05 +03):** source
  checkpoint `e932eb19c551fbda96dc83fe7fe34840afff2371`; production JS matched
  tarball `684db47f…` byte-for-byte. Homebrew Codex moved 0.147.0→0.149.0.
  Global `cob sync` wrote 11 rows (3 Ollama) from Desktop producer
  `0.149.0-alpha.4.1` and validators Desktop plus PATH 0.149.0. Catalog SHA is
  `9748309ea0e42c278d9e07dc71eef9c7b1c4a2fb3cb4cff84c026aa1624a3de9`;
  provenance is fresh without native-row repair. After a full Desktop
  quit/reopen the user confirmed native + `ollama/...` picker visibility.
  Host-network `cob status` is `ok`; pid 21099 health and overlay are `ok`.
  Root config SHA baseline is now
  `70b109578a83de533fa40e433efb5a4a08892cd675e62a18adbda8f2cf22e776`;
  this rewrite was Desktop/user-owned, not cob.
- **Post-release artifact audit (2026-08-24):** exact tarballs 0.1.9 through
  0.1.12 are present locally and match the recorded hashes; the claim that
  later tarballs were absent was false. The source risk found by this audit is
  resolved by checkpoint `e932eb1` above. A sandboxed localhost probe can
  report the live listener unreachable; only the subsequent host-network
  `cob status` is operational evidence, and it reports health `ok`.

- **G11 live PASS (0.1.12, 2026-08-24):** the fresh sidecar names Desktop
  `0.149.0-alpha.4.1` as producer and Desktop plus PATH 0.149.0 as validators;
  the fully reopened picker lists native and `ollama/...` rows. A real luna
  request logged `target=native`; a real 0731 request logged `target=ollama`,
  `tools_n=11`, and Ollama wire `declared_n=10`. In an isolated sidecar copy,
  changing only one validator `mtime_ms` moved baseline `cob: ok` to
  `cob: stale`, exit 1. A marker binary proved status did not spawn Codex.
  Live catalog SHA `9748309e…` and root config SHA `70b10957…` stayed unchanged.
- **G12 live PASS (0.1.12 default-on + 0.1.13 rollback, 2026-08-24):** live 0.1.12
  completed a real deferred GitHub MCP leaf and one V1 0731 child across
  continued parent turns. The discovery turn grew `tools_n` 11→25,
  `promoted_n=14`, `alias_added=14`, `alias_sha=8904ffcc`, with zero removed,
  replaced, or missing used aliases; later turns kept the same catalog hash.
  An isolated explicit-false replay correctly advertised false on all three
  Ollama rows but exposed 0.1.12's WP8 mismatch: Ollama 0.32.15 qualified the
  declared namespace leaf as `namespace.function`, while cob guarded the bare
  leaf, producing `ollama_undeclared_tool_call`. Candidate 0.1.13 now snapshots
  the dot-qualified wire name and restores Codex name/namespace separately.
  The corrected real rollback completed GitHub MCP plus a V1 child and returned
  `G12_FALSE_OK`; `promoted_n=0`, `alias_sha=-`, and
  `used_alias_missing=0`. The same rollback was then retraced through exact
  global 0.1.13 on isolated `:18791`: one read-only GitHub MCP leaf and one V1
  0731 child completed with `G12_FALSE_OK`; every parent/child wire reported
  `promoted_n=0`, zero alias mutations, and no guard/upstream error. The final
  43-file tarball SHA-256 is `81a99bad…`; its 37
  production JS files match the built workspace byte-for-byte and it contains
  no test/harness JS. Root `d24f79…` and live catalog `9748309e…` remained
  unchanged; `:18791` was stopped afterward.
- **G14 live PASS (global 0.1.13, 2026-08-24):** the prior controlled header,
  idle, backpressure, and disconnect lanes remain green. A finite 20-check
  0731 cloud reasoning stream completed in 10.731s with headers/first event at
  961/962ms, max inter-event gap 270ms, one `response.completed`, one client
  `[DONE]`, and usage 582 input / 2981 output. Its continuation completed in
  710ms (600/22 tokens). A separate client abort received a first chunk, left
  the gateway healthy, and kept state-file count 21→21. Earlier 59.2s
  output-limited traffic also terminated as `response.incomplete`, not a false
  success or hung gateway.
- **G17 same-corpus PASS (isolated global 0.1.13, 2026-08-24):** all executed
  variants used corpus SHA-256 `554c6ece4cdd13fba93e28be323fdc4ba89f23fe51b97ba90060ab41426361a9`
  (134 items, 51,671-byte compact request), produced all seven required
  handoff sections, and retained both constraint/pending-work continuations.
  Baseline high was 3297ms, 830 summary bytes, 13,896/561 compact tokens.
  `low` regressed to 4703ms and 13,817/1131, so it is rejected. `none` passed
  at 1488ms, 780 bytes, and 13,817/225 and is the only Stage-3 opt-in candidate;
  0.1.13 defaults do not change. Cloud-max advertisement passed both Desktop
  0.149-alpha and PATH 0.149 parsers with active 256,000 and max 1,048,576,
  but remains off by default. The current native skeletons omit
  `auto_compact_token_limit`, so candidate D was correctly not emitted and is
  not claimed as a run.

- **Live 0.1.12 install + two-turn Ollama smoke (2026-08-24):** exact tarball
  SHA-256 `684db47f34cdafd246699639d1996c79b91a5fd8b048833b7aaa9d15f507dbb6`
  (43 files, 37 production JS) replaced global cob after the 0.1.11 listener
  was already down. `cob version` is `cob 0.1.12 (global)`. Gateway pid
  **21099** on `127.0.0.1:18790` reports health `ok`; Desktop overlay is `ok`;
  `:18791` stayed down. Root `config.toml` SHA-256 remained
  `6ae7ff46867ae81073af18106b49a82f3d19aafc642e80eb263764dd03a9b418`.
  Before the later PATH alignment, `cob status` was fail-closed `unknown`
  (PATH 0.147 vs Desktop 0.149 near `supports_parallel_tool_calls`); the
  last-good catalog was retained and not repaired. The current status is the
  fresh/`ok` recovery recorded above. Live smoke through `:18790` to
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
  down. `cob version` was `cob 0.1.11 (global)`. Gateway pid **7869** on
  `127.0.0.1:18790` reported health `ok`; Desktop overlay was `ok`; `:18791`
  stayed down. Root `config.toml` SHA-256 remained
  `6ae7ff46867ae81073af18106b49a82f3d19aafc642e80eb263764dd03a9b418`.
  `cob status` was fail-closed `unknown` (PATH 0.147 vs Desktop
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

- **Native-plaintext V2 expansion / Upstream U1:** Gate 6 remains
  open/blocked on `controller_sequencing_observed` (`transport_unmeasured`).
  cob transport queue was not measured; do not add a cob queue or a fourth Sol canary.
  Isolated Gate 7–10 canaries are recorded in Proven; they are not product
  and do not reopen a cob queue. Next Gate 6 work is a Codex-side driver for
  `spawn → send1 → send2 → wait → followup1 → wait → followup2 → wait`
  without model scheduling. 0.149 experimental app-server `ClientRequest`
  has no such method; if none appears, prepare a portable V2 / upstream
  proposal and only then re-run Gate 6 on isolated cob. Recovery-hop
  transcription remains consent-only and was not implemented.
- **G13:** cloud low/high/max and the deterministic request/error boundary
  passed; the Ollama daemon access log independently confirms the three real
  `/v1/responses` calls. The local-model lane is unavailable because this
  machine has cloud tags only.
- **G15:** WP5A catalog cache showed identical output and a repeatable win;
  WP5B metrics was ~9% slower and WP5C SSE was equal in the measured fixture.
  No blanket G15 performance pass is claimed.
- **G16:** isolated three-turn/compact continuation and value/provenance/
  identity tamper matrix passed; each tamper failed closed without a new
  checkpoint and valid restore continued. This is isolated evidence, not a
  Desktop live claim.
- **G17 default promotion:** the gate passed, but one synthetic corpus is not
  authority to change the shipped default. `none` remains an explicit
  experiment candidate; `low` is rejected, cloud max remains presentation-only
  opt-in, and auto-limit remains capability-gated/omitted.
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

0. **0.1.13 live closeout is complete** —
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
   G11 and G12's default-on lane are closed. G12's false rollback found
   the namespace-qualified Ollama call gap; 0.1.13 fixes it and passed the
   isolated real MCP + V1 replay. Exact 0.1.13 is globally installed
   (pid 35004), and the affected real MCP + V1 rollback retrace subsequently
   passed on that exact global artifact.
   Defaults stay on the G8 path: omitted summarizer effort (wire `high`),
   256k active cap, no cloud max advertisement, no
   `auto_compact_token_limit`. Incomplete skeletons fail closed
   (`compaction_summary_incomplete`) without resending history. Isolated
   L5 still useful as a recorded harness.
   Native GPT compact stays ChatGPT passthrough.
   Current host-network `cob status` is `ok`; producer is Desktop 0.149 and
   PATH validator is 0.149.0. Catalog `9748309e…` is fresh and unmodified by
   compatibility repair. Current root baseline is `b6ec9273…` (Desktop/user
   rewrite after Gate 1-5 `b976c134…`); cob operations must not change it.
   The source checkpoint is `e932eb1`; no tag, push, publish, or repack
   occurred.
1. **Retain the proven defaults** — G12 rollback, G14, and G17 are closed on
   the fixed cut. Keep compact effort omitted (wire `high`), active context
   256k, cloud-max off, and auto-limit omitted. `none` is an isolated opt-in
   candidate for a future, broader quality corpus; `low` is rejected. Do not
   repack 0.1.12 or 0.1.13.
2. **Remaining evidence is scoped** — G13 local remains unavailable; G15 stays
   WP5A-only; G16 stays isolated-pass. None requires a 0.1.13 fix.
3. **The next Desktop/Codex update** — re-verify picker + 0731 + spawn, or
   `cob status` explains the break. Do not pack cob for an app update that
   already kept overlay.
