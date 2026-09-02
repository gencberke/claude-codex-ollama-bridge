# Status — 2026-09-02 (as of 17:11 +03)

This file is the current maintainer checkpoint: what is live, what exists only
in the workspace, what is blocked, and what may happen next. It is not a
chronological test log.

Canonical documents:

- Product contract: [README.md](./README.md)
- Active implementation plan: [IMPLEMENTATION-PLAN.md](./docs/IMPLEMENTATION-PLAN.md)
- Live-gate definitions and evidence: [LIVE-TESTING.md](./docs/LIVE-TESTING.md)
- Release procedure and artifact rules: [RELEASE.md](./docs/RELEASE.md)
- Version history: [CHANGELOG.md](./CHANGELOG.md)
- Gate 6 upstream proposal: [UPSTREAM-U1.md](./docs/UPSTREAM-U1.md)
- Agent constraints: [AGENTS.md](./AGENTS.md)

Those documents define the product, procedures, and history; this file is the
authority for the current live/workspace snapshot.

## Current snapshot

This is the sole current live/workspace snapshot authority. The facts below
are from the latest **real-environment** probe at 2026-09-02 17:07 +03 after
the authorized 0.3.0 global replacement. A sandboxed
loopback probe can falsely report the gateway as unreachable; live health
claims require a real-environment `cob status` probe.

| Surface | Current state as of 2026-09-02 17:11 +03 |
| --- | --- |
| Product scope | **cob Codex only.** Direct Ollama main and native GPT parent → Ollama V1 child are the validated product paths. |
| Live Codex gateway | Global cob **0.3.0**, pid **27409**, `127.0.0.1:18790`; real-environment `cob status --json`: health `ok`, overlay `ok`, catalog provenance `fresh`. |
| Live artifact | Exact 0.3.0 tarball, 91 entries, 186,931 bytes, SHA-256 `39e6eca95abdf9d7ca49621c7a6478bba26c2c54a6dbcf07f15b135d9da1aa51`. Installed and verified on 2026-09-02 17:07 +03; the installed `dist/cli.js` matched the tarball member. Source commit `762adf36c473dcc3e1aefaeb7566b6e6b3d9502a`, tag `v0.3.0`. Never repack these bytes. |
| Prior live artifact | Burned 0.2.4-preview.1 preview tarball, SHA-256 `4345c4a5c0de2467aa96f475e3ee7777d63ae77eaca65718220543f727265ed5`. Its 85 production `dist` files are byte-identical to 0.3.0 and retain the instrumented G26 evidence; history only. |
| Earlier preview | Burned 0.2.4-preview.0 tarball, SHA-256 `5f62556dacb2652654b0e1d338a0740eccb9771e6c3d9a09c192b8e7c4c879fd`. Its failed G26-B evidence remains historical. |
| Rollback artifact | Burned 0.2.3 tarball, SHA-256 `6152d1a59b18831a849851a58ac88b8160f1336bdac13edb1f806e6c191a238a`; history/rollback only. |
| Source checkout | Release source commit `762adf36c473dcc3e1aefaeb7566b6e6b3d9502a` is tagged `v0.3.0` and published. Post-release audit documentation may advance `master` without changing that tag or artifact. |
| Codex | PATH Codex **0.149.0**; current Desktop catalog producer **0.152.1**. |
| Ollama | Client/daemon **0.33.2**, re-probed at this checkpoint. Spawn preference remains DeepSeek 0731, GLM-5.3 Flash, then Kimi K3 overflow. |
| Desktop root overlay | `~/.codex/config.toml` remains user/Desktop-owned. Current real-environment SHA-256: `1a4ae0ea10a93cbb5ee7c5478f565227aabee08fba86159b1f89dcfa49f4b16c`; byte-identical before and after the instrumented G26 runs. Its change from the P3-era `f0e87913…` predates this canary and is not attributed to cob. |
| Live catalog | Current SHA-256 `2c603684a3866fbec396f09779e11e185b81fdca104aa27d2cec1b62c5bdcdfb`; meta SHA-256 `1ed55186e09ca292923796b6062b67aeac48bf26a2719500c80d10946d07f958` after the 0.3.0 start. Provenance is fresh from bundled Codex **0.152.1**, validators 2, Ollama discovery success. |
| Diagnostic sidecar | The mode-0600 canary sidecar remains historical evidence at `~/.codex/cob-diagnostics.jsonl`. The ordinary 0.3.0 restart did not claim a new instrumented canary; structured persistence remains opt-in and default-off. |
| Live experiments | `apply_patch = false`; `native_plaintext_spawn = false`. Ollama rows remain Multi-Agent V1. |
| Isolated dev port | No `:18791` listener after the authorized 2026-09-02 P1 cleanup. The temporary workspace gateway was stopped and its diagnostic JSONL removed. |
| cob Claude | No `:18792` listener at the 2026-09-01 23:36 read-only check. Claude feature work and live restart remain frozen pending explicit authorization. |

## Active scope and invariants

- `cob start` remains the Codex gateway. Do not steal that default for Claude.
- The shipped orchestration path is V1. Do not advertise Ollama V2, add a cob
  message queue, or implement `agentControl/*` inside cob.
- Do not use `nativeAlias` to impersonate native GPT model ids.
- cob does not write the user-owned root `~/.codex/config.toml`.
- Keep 0.2.3 only as the exact rollback/history artifact; do not repack it or
  any historical 0.1.11–0.2.2 artifact.
- The installed 0.3.0 release is Codex-scoped, not a new whole-product or cob
  Claude readiness claim. Any next version cut, live replacement, or touch to
  Claude requires separate authorization.
- Gate 5 `apply_patch` and native-plaintext collaboration remain isolated,
  default-off experiments; neither is enabled on live 0.3.0.
- Source tests and workspace fixtures are evidence, not live gold.

## G26 canary history

The current 0.2.4-preview.1 real-environment run completed both supported
surfaces: direct Ollama main and one native parent → one Ollama V1 child →
same-child follow-up. Across 64 Ollama requests it recorded 64 successful
proper-header SSE decodes, one provider attempt per request, zero gateway
retries, zero invalid JSON, zero duplicate fingerprints, and one exact hosted
tool drop per request. Functional routing, continuity, the A1 filter, and
observable transport reliability are **PASS**. Authoritative controller
retry/reconnect, no-progress, and agent-local retry counters remain
unavailable, so strict G26 is **AUDIT INCOMPLETE / NOT GOLD**. The historical
0.2.4-preview.0 G26-B remains immutable failed reliability evidence. Complete
content-free receipts and interpretation boundaries are in the G26 section of
[LIVE-TESTING.md](./docs/LIVE-TESTING.md).

## Release checkpoint

The reviewed batch is published as the Codex-scoped `v0.3.0` release. The
source commit, annotated tag, global install, and GitHub release all resolve to
the exact artifact recorded above. The GitHub asset was downloaded again and
proved byte-identical to the local/live-installed tarball. Its production
`dist` tree is byte-identical to the canaried 0.2.4-preview.1 runtime; only
version/package and release-document metadata changed. This carries forward
the scoped G26 evidence without claiming a new canary or whole-product Gold.

### Post-preview workspace source: bounded diagnostic sidecar

After the 0.2.4-preview.0 cut, workspace source added a new opt-in bounded
diagnostic sidecar. Default human logging is unchanged. The sidecar provides
private, bounded request start/end correlation only; it adds no model,
provider, retry, or queue behavior. It is installed in burned
0.2.4-preview.1 and supplied the new G26-A/G26-B receipt; it cannot
retroactively alter the historical preview.0 result.

Main outcomes:

- Ollama compaction uses transcript V2 with one untrusted user transcript,
  deterministic settings, and no cloud JSON schema.
- Cloud structured output is rejected before dispatch using the verified
  catalog route, including `remote_host` evidence.
- Request, decoded tool-search JSON, and upstream response traversal are
  bounded at depth 128 / 100,000 nodes. Overflow fails closed.
- SSE overflow emits exactly one `response.failed` terminal and one `[DONE]`,
  including held-completed and held-non-success paths.
- `cob status --json`, catalog provenance, and `cob state verify [--json]`
  now share fail-closed, content-free evidence rules.
- The Codex contract sentinel and G8/G9 scorers reject incomplete, duplicate,
  caller-asserted, cyclic, or cross-run evidence.
- G24, memory, WebSocket-fallback, and outage harnesses use bounded,
  content-free receipts and cleanup proofs.
- The eval run guard is concurrency-safe and fails closed if a child remains
  alive after its bounded shutdown wait, even when it owns no port.

### Post-review correction batch (2026-09-01)

Narrow eval-only corrections on top of the checkpoint above; no product
runtime change and no live action.

- G24 live-SHA scorer plumbing: both G24 scorer snapshots now receive all
  three live hashes (`configSha256`, `catalogSha256`, `catalogMetaSha256`).
  The receipt snapshot type now requires `catalogMetaSha256: string`, so a
  typed snapshot that omits metadata fails compilation. Runtime checks remain
  fail-closed: missing/invalid hashes are still
  `live_sha_snapshot_incomplete`, changed hashes are still
  `post_run_sha_mutation`. The root cause of every otherwise-passing G24 run
  degrading to `live_sha_snapshot_incomplete` was this plumbing gap, not a
  live-observation defect. At the time of this correction batch, real G24 had
  not yet run; the later fresh transcript-V2 result is the authoritative
  disposition in the gate table below.
- G24 retained success evidence no longer carries the raw model slug: the
  receipt `run` object now keeps `modelSha8 = idSha8(model)` (8 lowercase hex
  chars), matching the existing child/request identity-hash convention. The G9
  scorer's raw `EvalRunIdentity.model` equality is unchanged.
- WP14 outage canary and WP15 state-scan now use the repository's direct-entry
  guard (`import.meta.url === pathToFileURL(process.argv[1]).href`), so
  importing the compiled modules no longer starts the canary or benchmark.
  Direct CLI execution is unchanged.
- WS-fallback and memory eval CLIs fail closed on malformed arguments:
  `parseWsArgs` supports only `--out <path>` and `--turns <csv>`, rejecting
  unknown arguments, dangling flags, and explicitly empty `--turns`; the
  `[1, 10, 20]` default applies only when `--turns` is absent. `parseLaneArgs`
  now rejects a dangling `--out` (and a dangling `--lane`) instead of silently
  ignoring them.
- Contract evaluator child output is bounded: schema generation ignores both
  stdout and stderr (no pipe that a noisy binary can fill and block on), and
  `readVersion()` caps version output at 4096 bytes and settles with the
  stable empty/unknown representation on overflow. The receipt field is
  renamed `binary_path_sha256` → `binary_sha256` (it hashes binary file
  bytes, not the path string); no compatibility alias was added and no
  external consumer exists.
- Run-lock documentation now states the actual invariant: guard-owned temp
  homes are removed, while the exclusive run-ID lock remains as a tombstone so
  duplicate run IDs stay rejected.
- Benchmark behavior is unchanged. Read-only re-verification of the canonical
  benchmark receipts at their exact recorded paths succeeds and the recorded
  hashes are intact: memory `7a545f6c864b5c95e1c0075ee0acfd56978590194f48d753c3795e2220ff56f7`,
  WebSocket `874fe4285e4b41c2a9146dfb15ea25911e56942bf2eec5f024c5cbb6a7ea09e1`.
  Nothing was regenerated, moved, or overwritten.

Second post-review batch (2026-09-01), same-day follow-up review findings:

- WP14 fixture server listen failures are now Promise-owned: `TagsServer`
  binds the async `error` event to the listen promise (EPERM/EMFILE rejects
  instead of an unhandled crash that could skip the cleanup proof), removes
  the error listener on a successful listen, and leaves the server stopped and
  safely stoppable after a failure. `stop()` stays idempotent. A fake-server
  seam mirrors the run-guard `serverFactory` pattern.
- WP15 lookup lane no longer converts every exception into a measured `miss`:
  only `ConversationStateError` with `state_checkpoint_missing` is a
  deterministic miss; conflicts, incompatible checkpoints, and I/O or
  programming errors now fail the benchmark path. The empty-population miss is
  preserved, and the conflict fixture is locked by a focused test. Production
  `ConversationStateStore` behavior is unchanged.
- WS-fallback and memory eval CLIs reject `--out` values that are empty or
  option-shaped (`--out ""`, `--out --turns`, `--out --lane`), so a receipt
  can no longer be silently skipped or written to a flag-named file. Valid
  paths still pass.
- `readVersion()` now enforces the exact 4096-byte bound with a byte counter:
  a chunk that would exceed the limit is not appended, the stdout stream is
  destroyed, the child is terminated, and the stable `""` result settles
  once; no post-settlement appends occur. Single settlement across
  timeout/error/close is preserved, and the noisy-binary test locks the real
  bound with an infinite version writer plus a wall-clock assertion.

Final workspace gates:

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | PASS |
| `npm test` | PASS — **791 total, 787 pass, 4 skip, 0 fail** (rerun against the 0.3.0 source cut on 2026-09-02; no live mutation) |
| `npm run build` | PASS |
| `node dist/cli.js version` | PASS — `cob 0.3.0 (workspace)` |
| `git diff --check` | PASS |
| `npm pack --dry-run --json` | PASS — 91 production entries; no test, harness, `gate6h`, `eval-*`, or receipt. Dry-run only; no 0.3.0 tarball or release yet. |

### G26 Track A Phase P1 isolated smoke (2026-09-02)

The authorized workspace build ran only on `~/.codex-cob-dev` / `:18791` with
the opt-in diagnostic sidecar. One buffered JSON request and one streaming SSE
request both completed with HTTP 200, one provider attempt, zero cob retries,
and one exact hosted-tool drop. Their final diagnostic tuples were respectively
`false/json/json/1` and `true/sse/sse_header/1` for outbound stream,
content-type class, decoder, and hosted-drop count. The two start/end pairs
matched; the mode-0600 sidecar contained no retained prompt/output/tool/model
content. Cleanup stopped `:18791` and removed the sidecar. Live `:18790`
remained global 0.2.4-preview.0, healthy on pid 98662; root config, catalog, and
catalog-meta SHA values were byte-identical before and after. This is isolated
workspace evidence, not preview or live G26 gold.

The 0.2.4-preview.0 global install and real-environment G26 canary occurred
after the pre-preview checkpoint above and before the opt-in logging source
change. No Claude mutation, commit, push, tag, or production promotion
occurred. The exact preview, rollback, root-config, catalog, and catalog-meta
hashes are recorded in the current snapshot above.

### G26 Track A Phase P2 immutable preview cut (2026-09-02)

The user-authorized cut followed `docs/RELEASE.md`: version bumped to
`0.2.4-preview.1` in `package.json`/`package-lock.json` (no tag, no commit),
the `0.2.4-preview.1` CHANGELOG entry added, and the four workspace gates
re-run before packing.

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | PASS |
| `npm test` | PASS — 788 total, 784 pass, 4 skip, 0 fail |
| `npm run build` | PASS |
| `git diff --check` | PASS |
| `npm run pack` | PASS — one 91-entry tarball, 184,558 bytes |

Artifact: repo-root `codex-ollama-bridge-0.2.4-preview.1.tgz`, SHA-256
`4345c4a5c0de2467aa96f475e3ee7777d63ae77eaca65718220543f727265ed5`. Tarball
verification: 91 entries = 85 production `dist` files plus `package.json`,
`README.md`, `CHANGELOG.md`, `docs/RELEASE.md`, `LICENSE`, `NOTICE`; zero
test, harness, `gate6h`, or `eval-*` entries and no IDE files.

Live isolation proof across the cut: global install stayed 0.2.4-preview.0
(`cob version`, `cob status` health `ok`), `:18790` stayed pid 98662, and
SHA-256 values were byte-identical before and after for root `config.toml`
(`f0e87913…`), `cob-catalog.json` (`f2ba2980…`), `cob-catalog.meta.json`
(`74de0180…`), and the burned 0.2.3 rollback tarball. No `cob
stop/start/sync/restore`, no global install, no Claude mutation, and no
commit, push, or tag occurred. This cut is not a live-gold claim; G26-A
remains PENDING / UNPROVEN and Phase P3 is separately authorization-gated.

### G26 Track A Phase P3 live gateway replacement (2026-09-02)

The user-authorized replacement followed `docs/RELEASE.md` exactly. Preflight
proved the exact tarball (name, package version, 91 entries, SHA-256
`4345c4a5…`) and rollback tarball (`6152d1a5…`, package 0.2.3) matched their
recorded identities, and that the `:18790` listener (pid 98662) was owned by
global cob (`/opt/homebrew/bin/cob serve --port 18790`, correlated by global
`cob status --json`).

Sequence: global `cob stop` → `:18790` closed and pid 98662 exited →
`npm install -g <exact preview.1 tarball path>` → `cob version` reported
`0.2.4-preview.1 (global)` → global `cob start`.

| Check | Result |
| --- | --- |
| `:18790` listener | PASS — pid **2121** listening |
| `cob status --json` | PASS — `kind ok`, `needs_action false` |
| Install kind / version | PASS — `global` / `0.2.4-preview.1` |
| Health / overlay | PASS — `ok` / `ok` |
| Catalog provenance | PASS — `fresh`, producer desktop `0.151.0-alpha.7.2`, Ollama discovery success (4 tags) |
| Root `config.toml` SHA | PASS — byte-identical `f0e87913…` |
| `cob-catalog.json` SHA | Byte-identical `f2ba2980…` |
| `cob-catalog.meta.json` SHA | Changed `74de0180…` → `2845aeee…`: start re-stamp (`generated_at`/`observed_at` 2026-09-02T08:36:06Z); identities and recorded catalog SHA unchanged |
| Installed `dist/cli.js` | Byte-identical to the tarball member |
| Rollback | Not needed; exact burned 0.2.3 tarball untouched |

The previous global 0.2.4-preview.0 gateway (pid 98662) was stopped by global
`cob stop`; no process was signaled by hand. No root-config byte change, no
Claude mutation, no Desktop canary, no commit, push, or tag occurred.
At this P3 checkpoint, G26-A/G26-B (Phase P4) were **not** yet authorized and
did not run; the later separately authorized Phase P4 result is recorded
immediately below. Historical 0.2.4-preview.0 evidence remains attributed to
the burned preview.0 bytes.

The workspace is still dirty and uncommitted. This document is a logical
checkpoint, not a durable Git checkpoint.

### G26 Track A Phase P4 instrumented live canary (2026-09-02)

After the user-authorized diagnostic restart, global 0.2.4-preview.1 remained
the owner of `:18790`. The bounded mode-0600 sidecar captured the direct-main
G26-A lane followed by the one-parent/one-child/same-child-follow-up G26-B
lane. Account screenshot deltas exactly matched the content-free sidecar:
45 Ollama requests in A and 19 in B.

| Check | G26-A | G26-B |
| --- | ---: | ---: |
| Ollama outcomes | 45/45 `200/200/completed` | 19/19 `200/200/completed` |
| Provider attempts / gateway retry | 1 each / 0 | 1 each / 0 |
| Decoder / hosted drop | 45× `true/sse/sse_header` / 45×1 | 19× `true/sse/sse_header` / 19×1 |
| Invalid JSON / duplicate fingerprints | 0 / 0 | 0 / 0 |
| Exact successful usage | 2,033,002 input; 68,837 output | 934,997 input; 77,725 output |
| Continuity | direct initial + falsification continuation | 1 spawn, 1 child, 1 same-child follow-up, 0 fallback |

Every start/end pair matched. Targeted privacy scans retained no workload
terms, task label, raw model slug, or prompt/tool/output content. No GYMBLE
repository file changed during either task window. The A main agent used
temporary scratch storage outside the repository and exceeded its requested
file budget by one; this is a task-policy deviation, not a gateway transport
failure. The exact full matrix, timings, privacy boundary, and historical
comparison live only in `docs/LIVE-TESTING.md`.

Disposition: **OBSERVABLE TRANSPORT PASS / FILTER CONFIRMED / FUNCTIONAL
CONTINUITY PASS / AUDIT INCOMPLETE / NOT GOLD**. No A2 response sniff is
opened because D5 was not observed. No further cob runtime fix is indicated
by this canary. The new pack-excluded `src/eval-g26.ts` freezes the dynamic,
content-free aggregation method without hard-coding this run or claiming
controller-owned counters. It accepts the active and rotated sidecars under a
single bounded input budget; replaying both official windows reproduced the
checked-in receipt bytes exactly.

### Safe-lane benchmark measurements (2026-08-31)

Safe local fixture runs only: in-process gateway, fake upstream, dynamic
loopback ports, temp homes. These are **workspace measurements, not G-gates,
not canaries, not live gold** — and they authorize no runtime policy change.

Memory (`node dist/eval-gateway-memory.js --lane default`, Node v26.7.0,
fixture SHA `7322494a9d733636…`, 30 iterations/lane, 0 rejected):

| Lane | RSS delta | Amplification ratio | Loop p50/p95 | Output hash (16) |
| --- | --- | --- | --- | --- |
| 1 MiB, c1, plain | 592,134,144 B | 564.7x | 111/199 ms | `e5c008f7502d5aa6` |
| 1 MiB, c3, stream+tool+cont | 455,720,960 B | 144.9x | 635/1307 ms | `afb47269446e01a5` |

Receipt SHA-256: `7a545f6c864b5c95e1c0075ee0acfd56978590194f48d753c3795e2220ff56f7`.

WebSocket fallback (`node dist/eval-ws-fallback.js`, 0 failed turns). After the
determinism fix, fallback and direct HTTP produce **identical output hashes**
for the same turn count — 1 turn `0b612c4401b10cf2`, 10 turns
`55d48c3593de5f2d`, 20 turns `0a492dedfdfa4407`. The 426-handshake tax is
small: handshake p50 0.28–3.2 ms, 336 B per attempt (6,720 B over 20 turns).

Receipt SHA-256: `874fe4285e4b41c2a9146dfb15ea25911e56942bf2eec5f024c5cbb6a7ea09e1`.

## Gate disposition

Detailed commands, fixtures, compact metrics, and historical traces live in
[LIVE-TESTING.md](./docs/LIVE-TESTING.md). Historical PASS entries below belong to
the artifact and environment where they were measured; G26 is the current
preview-canary record and is not a production promotion.

| Gate | Disposition | Meaning |
| --- | --- | --- |
| Gate 1–3 | Isolated PASS | Exact fingerprinted native-plaintext spawn/send/followup schemas worked in isolation. Not an Ollama V2 product claim. |
| Gate 4 | Isolated PASS | Canonical interrupt leaf worked; no restart/replay claim. |
| Gate 5 | **NOT GOLD (fresh isolated)** | The latest clean opt-in run created a real Ollama V1 child, but that child emitted no custom call/output and made no filesystem edit. The 2026-08-24 PASS is historical evidence only. Live catalog remains disabled. |
| Gate 6 | **BLOCKED** | `controller_sequencing_observed`, `transport_unmeasured`. Next work is external Upstream U1, not a cob queue. |
| Gate 7 | **FAIL** | `worktree_not_distinct`. |
| Gate 8-M | Isolated PASS | Same-child continuation survived a mid-flight dev gateway restart. |
| Gate 8-R | Fixture only | Completed-checkpoint replay scorer exists; no live replay gold. |
| Gate 9 / G24 | **NOT GOLD / INCONCLUSIVE** | The latest transcript-V2 run produced valid seven-section handoffs, then repeated the same tool-heavy post-compact turn and re-entered compaction until bounded termination. The terminal `codex_exec_failed` was not root cause; no two-continuation gold. |
| Gate 10 | **FAIL** | The Ollama child had no nested collaboration spawn leaf. |
| G26 | **TRANSPORT PASS / FILTER CONFIRMED / AUDIT INCOMPLETE / NOT GOLD** | 0.2.4-preview.1 direct-main and native-parent→V1-child lanes completed 64/64 proper SSE requests with zero invalid JSON, duplicate fingerprints, or cob retries. Required controller/no-progress/agent-local counters remain unavailable. See [LIVE-TESTING.md](./docs/LIVE-TESTING.md). |
| G11 | PASS | Catalog provenance gate passed on its recorded artifact. |
| G12 | PASS | Search default and rollback passed on the recorded 0.1.13 artifact. |
| G13 | Partial | Cloud lanes and request boundary passed; no local-model lane was available. |
| G14 | PASS | Timeout/backpressure gate passed on its recorded artifact. |
| G15 | Partial | Catalog cache improvement measured; no blanket performance pass. |
| G16 | Isolated PASS | Checkpoint identity/tamper matrix failed closed correctly. Not Desktop-live proof. |
| G17 | Same-corpus PASS | Quality comparison passed; shipped defaults did not change. |
| G18 / G19 | Historical PASS | Search compatibility and response integrity belong to their recorded artifacts, not a current preview retrace. |

## Known blockers and unproven claims

- **Current Gate 5 gold:** the latest clean isolated run proved catalog opt-in
  and real-child creation, but no child-native custom call/output or edit. New
  content-safe observations distinguish declaration/alias/model/restoration/
  execution boundaries; they have not yet been exercised by another canary.
- **Real G24 gold:** the fresh transcript-V2 run compacted successfully but
  entered a repeated tool-heavy post-compact/recompact cycle and never reached
  two same-child continuations. The pack-excluded harness now uses an 8192
  window, correlated compact episodes, exact-token window-floor evidence, and
  an owned stop before a second post-compact summarizer reaches upstream. When
  exact floor evidence is absent, that stop is reported neutrally as
  `g24_postcompact_retrigger_before_completion`; these corrections have not
  yet been exercised by another canary.
- **Gate 6 control plane:** current Codex exposes no public deterministic
  `agentControl/*` driver. Follow [UPSTREAM-U1.md](./docs/UPSTREAM-U1.md); do not
  build the scheduler or queue in cob.
- **Worktree isolation:** Gate 7 remains failed.
- **Nested Ollama orchestration:** Gate 10 remains failed and out of the V1
  product claim.
- **Whole-product readiness:** cannot be newly claimed while cob Claude is
  frozen and its listener is stopped.
- **Desktop durability:** the next Desktop/Codex update can still remove the
  overlay or hide `ollama/...`; that requires revalidation.
- **G13 local lane:** unavailable on this machine because the observed Ollama
  roster is cloud-only.
- **G26 strict audit:** observable transport and continuity now pass on
  0.2.4-preview.1, but the upstream controller still does not expose
  authoritative retry/reconnect, no-progress, or agent-local retry counters.
  Repeating the same canary cannot manufacture those fields; keep them
  unavailable and keep strict G26 NOT GOLD.
- **Production promotion:** the scoped Codex runtime is now released and live
  as 0.3.0. This does not promote the frozen Claude surface, unavailable G26
  audit counters, or unrelated gate dispositions.
- **Active implementation plan:** [IMPLEMENTATION-PLAN.md](./docs/IMPLEMENTATION-PLAN.md)
  G26 Track A workspace package (WP1 exact hosted-tool filter, WP2 outbound/
  decoder diagnostics, WP3 documentation reconciliation, WP4 verification) is
  implemented and verified in the workspace. Phase P1 isolated smoke passed,
  the Phase P2 immutable 0.2.4-preview.1 artifact is cut and recorded in
  `docs/RELEASE.md`, and Phase P3 installed it globally on `:18790` with all
  post-install checks passing. Phase P4 G26-A/G26-B canaries completed with
  observable transport and continuity PASS, A2 closed, and the strict audit
  incomplete because controller-owned counters were unavailable. The
  byte-identical production runtime is now installed and published as 0.3.0.

## Next decisions

1. **0.3.0 complete:** source commit, workspace gates, single immutable
   artifact, clean global install, health/models smoke, annotated tag, atomic
   push, GitHub release, and downloaded-asset equality check all passed.
2. **Gate 5/G24 rerun:** each real isolated 0731 canary requires separate
   explicit authorization. Results remain isolated evidence unless separately
   promoted by the live-gate standard.
3. **Gate 6:** wait for or contribute a Codex-side deterministic driver, then
   remeasure on isolated `:18791` only.
4. **Next Desktop update:** revalidate picker visibility, the 0731 route, and
   native-parent → Ollama-V1-child spawn.

## Ownership and recovery

- Reboot or a dead gateway is not autostart failure: run `cob start`.
- Desktop reads the root config, not the named CLI profile. The root overlay
  remains user-owned; `cob restore` does not revert it.
- Fully quit and reopen ChatGPT Desktop after a catalog byte change. Do not
  claim hot reload.
- `cob status` is read-only: it checks runtime, overlay, and catalog
  provenance without spawning Codex or probing Ollama.
- Restarting or changing the Claude `:18792` surface requires explicit user
  authorization.
- Historical evidence should be updated in `docs/LIVE-TESTING.md` or
  `CHANGELOG.md`, not appended here as another long chronology.
