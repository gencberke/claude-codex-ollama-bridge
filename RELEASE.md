# Releases — global cob vs checkout

Live ChatGPT Desktop and daily `codex --profile cob` run the **globally
installed** `cob` binary. A git checkout is for `--dev` trials and for cutting
the next tarball. cob still does not write `~/.codex/config.toml`.

Current state (2026-08-27): source on `master` is **0.2.0** and the live global
CLI/gateway on `:18790` is also **0.2.0**. The stabilization and
architecture-refactor series is committed on `master` but stays workspace-only:
no tarball has been packed or installed since the existing 0.2.0 cut, and its
tests and isolated checks are not proof that the live global artifact contains
those changes. cob Claude remains a separate `:18792` surface. Do not
repack 0.1.11–0.1.16 or overwrite the existing 0.2.0 version with different
bytes; cut a new version before any future authorized install. `package.json`
stays `"private": true`; do not `npm publish`.

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
3. Add a `## x.y.z` section at the top of [CHANGELOG.md](./CHANGELOG.md).
4. `npm run pack` (or `cob pack` from the checkout). This is
   `tsc -p tsconfig.build.json` then `npm pack`. Tests and harnesses stay out
   of the tarball (`files` in `package.json`).
5. Confirm `cob version` in the tarball name matches `package.json`.
6. Replace the live gateway (see below) only when authorized. Do not
   `npm publish` while `"private": true`. GitHub public source is clone +
   `npm run pack` + `npm install -g` the tarball.
7. Git tag only if the user asked (`v0.1.0` matching the version).

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

- Not proof of G1–G10. [STATUS.md](./STATUS.md) is the live checkpoint.
- Not a ChatGPT.app patch and not OpenCodex `nativeAlias`.
- Not cob owning root `config.toml`.
- Not Multi-Agent V2 on Ollama children. [UPSTREAM-U1.md](./UPSTREAM-U1.md)
  stays cob-external.
