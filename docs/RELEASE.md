# Releases — global cob vs checkout

Live ChatGPT Desktop and daily `codex --profile cob` run the **globally
installed** `cob` binary. A git checkout is for `--dev` trials and for cutting
the next tarball. cob still does not write `~/.codex/config.toml`.

Current live version, health, overlay, workspace, and catalog authority are
recorded only in [STATUS.md](../STATUS.md). This file records release/install
events and the rollback procedure.

Prepared 0.3.0 source cut (2026-09-02): package and lock metadata now identify
`0.3.0`, the canonical G26 receipts and release procedure are frozen, and the
complete workspace gate passed before the exact source commit. This is a source
event only: global live remains the burned 0.2.4-preview.1 artifact until a
single tarball built from that commit is installed and validated. No 0.3.0
artifact identity, tag, push, or GitHub release is claimed here before those
steps actually complete.

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
