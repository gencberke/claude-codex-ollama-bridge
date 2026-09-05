# Releases — global cob vs checkout

Live ChatGPT Desktop and daily `codex --profile cob` run the **globally
installed** `cob` binary. A git checkout is for `--dev` trials and for cutting
the next tarball. cob still does not write `~/.codex/config.toml`.

Current live version, health, overlay, workspace, and catalog authority are
recorded only in [STATUS.md](../STATUS.md). This file records release/install
events and the rollback procedure.

Prepared 0.4.0 install candidate (2026-09-05): the iteration-discipline cut.
The working tree was versioned as 0.4.0 and passed `npx tsc --noEmit`, 828 Node
tests (824 pass, 4 intentional skips), and `git diff --check`. Exactly one npm
artifact was packed: `codex-ollama-bridge-0.4.0.tgz`, 95 entries, 216,690
bytes, SHA-256
`a7f4968c177ae8aceaf881db47df59f9eb73edf41a67195454f6f6fd3b03889b`.
Tests, harnesses, `gate6h`, `eval-*`, the build-manifest writer, sources, IDE
files, and the separately built menu app are absent.

This is the first artifact that carries its own identity. Its shipped
`dist/build-manifest.json` reads: package version `0.4.0`, source commit
`29324969b13e33f44405c36587302d2a3a5c9c9b`, **`source_dirty: true`**, dist
digest `9e51d748f0f7…` (full value in the shipped manifest)
over 89 production files, diagnostic schema version 1. The dirty flag is
accurate and load-bearing: the source for this artifact is **not committed**,
so the named commit does not reproduce these bytes. `cob status` prints this
identity, and the artifact SHA above belongs here rather than inside the
artifact, which cannot contain its own digest.

**Not installed, started, or live-canary tested.** These bytes supersede an
earlier same-version pack that was never installed; a candidate may be
repacked before install, and the identity above is the one that counts. From
the moment it is installed the usual rule binds: do not repack 0.4.0 with
different bytes. Rollback from it is
`npm install -g ./codex-ollama-bridge-0.3.5.tgz` followed by
`COB_DEV_MODE=1 cob start`.

Completed 0.3.5 installation event (2026-09-05): a diagnostics cut made so a
live canary can answer two questions earlier artifacts could not — why Ollama
ended a turn, and what the final provider wire actually contained. It is
**not** instrumentation-only: it also carries the Ollama response ceiling,
which is on by default at 2.5 MiB and changes behaviour on every Ollama SSE
response. An earlier version of this entry described the cut as
instrumentation-only; that was wrong.
The working tree was versioned as 0.3.5 and passed `npx tsc --noEmit`, 822 Node
tests (818 pass, 4 intentional skips), and `git diff --check`. Exactly one npm
artifact was packed: `codex-ollama-bridge-0.3.5.tgz`, 93 entries, 210,542
bytes, SHA-256
`8f42fad753a10fc8470de16787e1b7ce2f9b05a1df367e02ded306539bb17005`.
Tests, harnesses, `gate6h`, `eval-*`, sources, IDE files, and the separately
built menu app are absent.

Installed globally under explicit live authorization and started with
`COB_DEV_MODE=1`. Post-install `cob status`: release 0.3.5 (global), gateway
pid 55031 on `127.0.0.1:18790`, health `ok`, overlay `ok`, dev mode on,
plaintext wire armed, catalog provenance fresh from Desktop `codex-cli
0.153.1`. Root `config.toml` stayed byte-identical across stop/install/start at
SHA-256 `4c815e0339a7228a20b3cd92a5d6d608e88dda4492c0a232015073e8e052c5d7`, and
`cob-catalog.json` was unchanged at
`2b37f6e1740582406243a440c20d87562a6c16b62ce1a574d864d5fe28539654`, so Desktop
needed no restart; only cob's own `cob-catalog.meta.json` was re-stamped to
`96e5f79c3a81a9c780a25a0319a76a6a88307ebcd37693c29832a630a2632b54`. Installed
`dist/cli.js` matches the tarball member at SHA-256
`3b5bfec38cdf82f6b80434aee29a9bf5302f73eb6b21a99f93d1179ebf3dd2ed`, and the two
modules that actually changed match their tarball members as well. The source
checkpoint is **not committed**; no tag or GitHub release. **No live canary has
run against it yet.** Do not repack 0.3.5 with different bytes.

Prepared 0.3.4 global-install candidate (2026-09-04) — **superseded**: it was
installed later that day and then replaced by 0.3.5 on 2026-09-05. The record
below is the state as of the date it was written. Prepared 0.3.4 candidate:
source checkpoint
`cdcdf6d629f985f25b0545268e1fb7ae024821fe` was committed and pushed to
`origin/master`. The exact source passed `npx tsc --noEmit`, 818 Node tests
(814 pass, 4 intentional skips), and `git diff --check`. Exactly one npm
artifact was produced: `codex-ollama-bridge-0.3.4.tgz`, 93 entries, 207,181
bytes, SHA-256
`74614984714cc9ca91445a9bf728b560bf637b164ca328543f5e0bed0ef56237`.
The tarball identifies version 0.3.4 and excludes tests, harnesses, `gate6h`,
`eval-*`, sources, IDE files, and the separately built menu app. It is ready
for an explicitly authorized global replacement but has not been installed,
started, or live-canary tested. Live remains the burned 0.3.3 artifact.

Completed 0.3.3 installation event (2026-09-04): the working tree was versioned
as 0.3.3 and passed `npx tsc --noEmit`, 804 Node tests (800 pass, 4 intentional
skips), and `git diff --check`. Exactly one npm artifact was packed:
`codex-ollama-bridge-0.3.3.tgz`, 92 entries, 200,584 bytes, SHA-256
`e3a111a3cc53b1217a771d619bdfdfa536fc4d8193fa0a22080331bd9f33d480`. Tests,
harnesses, `gate6h`, `eval-*`, sources, IDE files, and the separately built
menu app are absent. The user installed it globally and started it with
`COB_DEV_MODE=1`; `cob status` reported release 0.3.3 (global), health `ok`,
dev mode on, and the plaintext wire armed. Its source checkpoint is **not
committed**: `RELEASE.md`'s basic cut does not require a commit and none was
authorized. No tag or GitHub release. Do not repack 0.3.3 with different bytes.

Completed 0.3.2 installation event (2026-09-04): same gates at 803 Node tests
(799 pass, 4 skips). Artifact `codex-ollama-bridge-0.3.2.tgz`, 92 entries,
199,522 bytes, SHA-256
`a0893e950731054c405f5da5d1cd20229d95104e86a50ed9f9701c953532f802`. Installed
globally and started with the plaintext wire initially disarmed, then armed
with a pinned digest after a clean post-install status. Superseded by 0.3.3 the
same day; history/rollback only. Do not repack 0.3.2 with different bytes.

Rollback from either 0.3.2 or 0.3.3 is `npm install -g
./codex-ollama-bridge-0.3.1.tgz` followed by `cob start`; that artifact still
hashes to its recorded SHA-256
`0456a310dc839c00d1cd15909279fa5fccaa5d2dbb8afbf4e45beff30f87c4d2` and its
source checkpoint is on `master`.

Completed 0.3.1 installation-candidate event (2026-09-03, 16:57 local): the
working tree was versioned as 0.3.1 and passed `npx tsc --noEmit`, 802 Node
tests (798 pass, 4 intentional skips), and six Swift menu-app tests. Exactly
one npm artifact was packed: `codex-ollama-bridge-0.3.1.tgz`, 92 entries
(86 production `dist` files plus the six allowlisted package files), 195,596
bytes, SHA-256
`0456a310dc839c00d1cd15909279fa5fccaa5d2dbb8afbf4e45beff30f87c4d2`.
Tests, harnesses, `gate6h`, `eval-*`, sources, IDE files, and the separately
built menu app are absent. Do not repack 0.3.1 with different bytes.

The user installed that exact candidate globally and started it. Read-only
post-install status reported cob **0.3.1**, gateway pid **212** healthy on
`127.0.0.1:18790`, overlay `ok`, and fresh catalog provenance from Desktop
`codex-cli 0.153.0-alpha.5` with two validators and successful Ollama
discovery. Installed `dist/cli.js` matches the tar member at SHA-256
`3b5bfec38cdf82f6b80434aee29a9bf5302f73eb6b21a99f93d1179ebf3dd2ed`.
Current post-install root config/catalog/meta hashes are recorded in STATUS;
there is no claimed before/after install hash receipt. Desktop picker/chat and
menu-driven sync validation remain pending. This documentation reconciliation
occurred after the immutable candidate was packed. The source checkpoint was
then committed and pushed on `master`; no tag or GitHub release was created.

Prepared 0.3.0 source cut (2026-09-02): package and lock metadata now identify
`0.3.0`, the canonical G26 receipts and release procedure are frozen, and the
complete workspace gate passed before the exact source commit. This is a source
event only: global live remains the burned 0.2.4-preview.1 artifact until a
single tarball built from that commit is installed and validated. No 0.3.0
artifact identity, tag, push, or GitHub release is claimed here before those
steps actually complete.

Completed 0.3.0 artifact/install/publish event (2026-09-02, 17:09 local):
source commit `762adf36c473dcc3e1aefaeb7566b6e6b3d9502a` passed the 791-test
workspace gate and is the target of annotated tag `v0.3.0`. Exactly one
tarball was packed from that commit: `codex-ollama-bridge-0.3.0.tgz`, 91
entries, 186,931 bytes, SHA-256
`39e6eca95abdf9d7ca49621c7a6478bba26c2c54a6dbcf07f15b135d9da1aa51`.
It contains 85 production `dist` files plus the six allowlisted package files;
tests, harnesses, `gate6h`, `eval-*`, receipts, sources, and IDE files are
absent. Its production `dist` tree is byte-identical to the instrumented
0.2.4-preview.1 artifact.

The user stopped global preview.1, confirmed `:18790` closed, installed the
exact 0.3.0 tarball, and started global cob. Independent post-install checks
reported pid **27409**, health and overlay `ok`, catalog provenance `fresh`
from bundled Codex **0.152.1**, validators 2, Ollama discovery success, and
`/v1/models` HTTP 200. Root `config.toml` stayed byte-identical at SHA-256
`1a4ae0ea10a93cbb5ee7c5478f565227aabee08fba86159b1f89dcfa49f4b16c`;
the catalog stayed at `2c603684…` and catalog meta was re-stamped to
`1ed55186e09ca292923796b6062b67aeac48bf26a2719500c80d10946d07f958`.
The installed `dist/cli.js` matched the tarball member at SHA-256
`3b5bfec38cdf82f6b80434aee29a9bf5302f73eb6b21a99f93d1179ebf3dd2ed`.

`master` and the tag were pushed atomically. GitHub release
[`v0.3.0`](https://github.com/gencberke/claude-codex-ollama-bridge/releases/tag/v0.3.0)
is public with the exact tarball attached; GitHub reports the same SHA-256 and
size, and a fresh download was byte-identical. No rebuild occurred after the
single pack. The release inherits the byte-identical preview runtime's scoped
G26 transport/continuity evidence; strict Gold remains audit-incomplete due
to unavailable controller-owned counters. cob Claude remains frozen.

Completed preview artifact/install event (2026-09-01, 17:20 local): the global
install serving Codex `:18790` was cob **0.2.4-preview.0**, a preview cut of
that workspace. Its exact 90-entry tarball SHA-256 is
`5f62556dacb2652654b0e1d338a0740eccb9771e6c3d9a09c192b8e7c4c879fd`.
The post-install `cob status` check at that time was `ok`: health and Desktop
overlay were `ok`, catalog provenance was fresh from bundled Codex
`0.151.0-alpha.7.2`, `/v1/models` answered `200`, and root `config.toml`
stayed user-owned at SHA-256 `b5fbacda…` across install and start. This is a
historical install record, not current health authority; see [STATUS.md](../STATUS.md).

Completed preview cut event (2026-09-02, 11:29 local): the workspace was cut
as cob **0.2.4-preview.1** per the authorized G26 Track A Phase P2. The exact
91-entry tarball is `codex-ollama-bridge-0.2.4-preview.1.tgz` at the repo
root, 184,558 bytes, SHA-256
`4345c4a5c0de2467aa96f475e3ee7777d63ae77eaca65718220543f727265ed5`.
Tarball verification: no test, harness, `gate6h`, or `eval-*` entries; 85
production `dist` files plus `package.json`, `README.md`, `CHANGELOG.md`,
`docs/RELEASE.md`, `LICENSE`, and `NOTICE`. At the instant of this cut it was
**not installed**: the live `:18790` gateway remained global 0.2.4-preview.0
(pid 98662), and root config, catalog, and catalog-meta SHA values were
byte-identical before and after. There is no tag or commit for this cut. It
was installed only in the separately recorded event below. Do not repack
these bytes; the next authorized changed cut is **0.3.0**.

Completed preview install event (2026-09-02, 11:36 local): the exact
0.2.4-preview.1 tarball recorded above was installed globally from its repo
path with `npm install -g <tarball>` after the user-authorized Phase P3. The
previous global owner 0.2.4-preview.0 (pid 98662) was stopped with global
`cob stop`; `:18790` closed and the process exited. Post-install
`cob status --json`: `kind ok`, install `global` **0.2.4-preview.1**, gateway
healthy on `:18790` with pid **2121**, overlay `ok`, catalog provenance
`fresh` (producer desktop `codex-cli 0.151.0-alpha.7.2`, validators 2, Ollama
discovery success, 4 tags). Root `config.toml` stayed byte-identical at
SHA-256 `f0e879138d1f962d98d7a4d4bdb693723a12d30a37f13eef1a7f9caedea42bfa`;
`cob-catalog.json` stayed byte-identical at `f2ba2980…`; `cob-catalog.meta.json`
was re-stamped by the 0.2.4-preview.1 `cob start`
(`74de0180…` → `2845aeee293aa0f7794a979a0f7b2cb071eb57b3a94fa16209649660687f1238`,
`generated_at`/`observed_at` 2026-09-02T08:36:06Z; producer/validator
identities and the recorded catalog SHA are unchanged). The installed
`dist/cli.js` matched the tarball member byte-for-byte. Phase P4 Desktop /
G26-A / G26-B canaries were **not** part of this authorization and did not
run. Rollback was not needed; the exact burned 0.2.3 rollback tarball
(`6152d1a5…`) remains untouched at the repo root. Do not repack
0.2.4-preview.0 or 0.2.4-preview.1 with different bytes.

Completed post-install validation event (2026-09-02): the exact burned
0.2.4-preview.1 install was restarted with the opt-in bounded diagnostic
sidecar and exercised by the authorized G26-A direct-main and G26-B
native-parent→same-child canaries. No artifact was repacked and no package,
tag, commit, or source identity changed. Observable transport, exact
hosted-tool removal, and functional continuity passed; the strict gate remains
audit-incomplete because controller-owned counters were unavailable. The
canonical content-free matrix and current disposition live in
[LIVE-TESTING.md](./LIVE-TESTING.md) and [STATUS.md](../STATUS.md); do not copy
their volatile request/timing snapshot into this release history.

Rollback is `npm install -g ./codex-ollama-bridge-0.2.3.tgz` followed by
`cob start`; that repo-root artifact still hashes to its burned live SHA-256
`6152d1a59b18831a849851a58ac88b8160f1336bdac13edb1f806e6c191a238a`. The
prior live install was cob **0.2.3** (pid **25824**, 2026-08-30 22:25 local),
stopped via `cob stop` before this replace. Both artifacts are now burned and
must not be repacked with different bytes. The cob Claude `:18792` gateway was
not restarted during this install event and was observed stopped; its last
recorded live state at that event was 0.2.1 (pid 78004, tarball SHA-256
`efca05567eced642907707cc8c1f164e58361b03875aeeb9c5e2be1fab364d69`, cut from
commit `7899077` / tag `v0.2.1`). Do not repack 0.1.11–0.1.16, 0.2.0, 0.2.1,
0.2.2, 0.2.3, 0.2.4-preview.0, or 0.2.4-preview.1 with different bytes; cut a
new version before any future authorized install.
`package.json` stays `"private": true`; do not `npm publish`.

Active release work is **Codex-scoped**. cob Claude stays frozen at its current
source/live behavior until the user explicitly reopens that surface; do not
fold deferred Claude hardening into a Codex cut or treat a Codex approval as a
whole-product production approval.

0.1.14 is a scoped fail-closed cut (Ollama JSON raw-relay closed, encrypted
prefixes rejected, live experimental lock). It does not re-prove G12/G14/G17
(those remain 0.1.13 traces) and does not enable V2 or Gate 5 on live.

Prior live **0.1.13** tarball SHA-256
`81a99bad0f645bffcb0bb2551dae3a86dc5cb4dd8869d8a713fe210823fd1c72`.
Source checkpoint `e932eb19c551fbda96dc83fe7fe34840afff2371` still reproduces
0.1.12 production JS. PATH Codex is 0.149.0.

## Two homes

| | Live Codex | Live cob Claude | Develop |
| --- | --- | --- | --- |
| Install | `npm install -g ./codex-ollama-bridge-<version>.tgz` | same global `cob` | git checkout + `npm run build` |
| Command | `cob start` | `cob claude start` | `node dist/cli.js start --dev` / `claude start --dev` |
| Home | `~/.codex` | `~/.claude-cob` | `~/.codex-cob-dev` / `~/.claude-cob-dev` |
| Port | `18790` | `18792` | `18791` / `18793` |
| Desktop | ChatGPT Desktop (root `openai_base_url` → `:18790`) | Claude Desktop 3P `--desktop` → `:18792` | No ChatGPT Desktop. Claude `--dev --desktop` is isolated trial |

`cob version` prints `cob <version> (global|workspace|unknown)`. `cob status` repeats
that plus `cli:` path. A workspace mutating command against live `~/.codex`
exits with the live-home refusal unless `--live-home`.

`--dev` copies `~/.codex/auth.json` into the isolated home if missing. It does
not copy `config.toml`.

## Cut a release

1. Merge-gate on the checkout: `npx tsc --noEmit` and `npm test`.
2. Set `package.json` `"version"` (semver). Stay on `0.x`. The 26.818 Desktop
   hop is in STATUS; do not jump to `1.0.0` to look finished.
3. Add a `## x.y.z` section at the top of [CHANGELOG.md](../CHANGELOG.md).
4. `npm run pack` (or `cob pack` from the checkout). This is
   `tsc -p tsconfig.build.json` then `npm pack`. Tests and harnesses stay out
   of the tarball (`files` in `package.json`).
5. Confirm `cob version` in the tarball name matches `package.json`.
6. Replace the live gateway (see below) only when authorized. Do not
   `npm publish` while `"private": true`. GitHub public source is clone +
   `npm run pack` + `npm install -g` the tarball.
7. Cut a git tag only if the user asked; when cut, its version must match
   `package.json` (for example, `v0.1.0`).

For a user-authorized GitHub release, strengthen that sequence as follows:

1. Complete the version/changelog/source work and all workspace gates.
2. Commit the exact intended source checkpoint; require a clean tracked tree.
3. Pack once from that commit, record the tarball name, entry count, byte size,
   SHA-256, and package version, and verify excluded tests/harnesses/evals.
4. Install that exact tarball globally using the replacement procedure below
   and run the bounded post-install health/provenance/smoke checks. Do not
   rebuild between validation and publication.
5. Tag the same source commit with the matching `vX.Y.Z`, push the commit and
   tag, then create the GitHub release and attach the exact verified tarball.
6. Record the immutable artifact/install/publish event here. A failed live
   validation stops before tag/release and requires a new version for changed
   bytes.

Do not pack from a global install. Do not point Desktop at `dist/cli.js`.

## First global install (or replace a checkout daemon)

The live listener on `127.0.0.1:18790` must become the global `cob`, or
Desktop keeps talking to whatever process already bound that port.

```bash
# From the checkout, if a workspace cob still owns ~/.codex:
node dist/cli.js stop --live-home

npm install -g ./codex-ollama-bridge-<version>.tgz   # only after explicit live authorization
cob version    # expect: cob <version> (global)
cob start
cob status     # health/overlay ok; provenance fresh, or explained fail-closed skew
```

`cob restore` still does not revert a user-owned Desktop overlay in
`config.toml`. If `cob status` says `desktop overlay: broken`, fix that overlay
by hand (backup on this machine:
`~/.codex/config.toml.pre-cob-desktop-20260819`). Snapshot SHA before any
real-home config experiment.

After a live catalog *byte* write, fully quit and reopen ChatGPT Desktop before
judging picker changes. `cob status` `stale` or `unknown` means regenerate
with `cob sync` or `cob start`; it is not fixed by restarting the gateway
alone if the producer/consumer binaries still disagree.

After this, further product work uses `cob start --dev`. Bump + pack +
`npm install -g` only when the live Desktop/CLI gateway should move.

## What a release is not

- Not proof of G1–G10. [STATUS.md](../STATUS.md) is the live checkpoint.
- Not a ChatGPT.app patch and not OpenCodex `nativeAlias`.
- Not cob owning root `config.toml`.
- Not Multi-Agent V2 on Ollama children. [UPSTREAM-U1.md](./UPSTREAM-U1.md)
  stays cob-external.
