# Releases — global cob vs checkout

Live ChatGPT Desktop and daily `codex --profile cob` run the **globally
installed** `cob` binary. A git checkout is for `--dev` trials and for cutting
the next tarball. cob still does not write `~/.codex/config.toml`.

Current state (2026-08-24): live global is **0.1.13** on `:18790` (pid **35004**)
after an authorized install of the exact tarball SHA-256
`81a99bad0f645bffcb0bb2551dae3a86dc5cb4dd8869d8a713fe210823fd1c72`.
Health, overlay, and provenance are `ok`/`fresh`. Install-time root SHA was
`70b10957…`; Desktop/user rewrites later established `d24f79f…` for the live
closeout gates and current baseline `b976c134…` before Gate 1-5. cob did not
make either rewrite; the corresponding gates preserved their baselines and
catalog SHA `9748309e…`. Do not repack 0.1.11, 0.1.12, or 0.1.13. G11 passed; G12
default-on passed on 0.1.12 and the affected false rollback passed on exact
global 0.1.13. G14 long-cloud/continuation/abort and G17 same-corpus acceptance
also passed on 0.1.13. G13 is cloud-partial, G15 is WP5A-only, and G16 is
isolated-pass.

Source checkpoint `e932eb19c551fbda96dc83fe7fe34840afff2371` reproduces the
0.1.12 production JS byte-for-byte against that tarball. PATH Codex is 0.149.0,
catalog provenance is fresh, and host-network `cob status` is `ok` on pid 35004.
No tag, push, npm publish, or repack accompanied the checkpoint.

Live **0.1.13** is that namespace-qualified tool-identity fix. Merge gate,
isolated real MCP + V1 rollback, and tarball inspection passed before the
authorized global install. The affected rollback was then repeated against
the exact global artifact and passed with zero promotions/aliases. G14 and
G17 also closed without a code change. No commit, tag, push, or publish
accompanied the cut or closeout.

## Two homes

| | Live | Develop |
| --- | --- | --- |
| Install | `npm install -g ./codex-ollama-bridge-<version>.tgz` | git checkout + `npm run build` |
| Command | `cob start` | `node dist/cli.js start --dev` |
| Codex home | `~/.codex` | `~/.codex-cob-dev` |
| Port | `18790` | `18791` |
| Desktop | Yes (root `openai_base_url` → `:18790`) | No. Desktop ignores `--profile` and only reads `~/.codex/config.toml` |
| CLI test | `codex --profile cob` | `CODEX_HOME=~/.codex-cob-dev codex --profile cob` |

`cob version` prints `cob <version> (global|workspace)`. `cob status` repeats
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
6. Replace the live gateway (see below). Do not `npm publish` while
   `"private": true`.
7. Git tag only if the user asked (`v0.1.0` matching the version).

Do not pack from a global install. Do not point Desktop at `dist/cli.js`.

## First global install (or replace a checkout daemon)

The live listener on `127.0.0.1:18790` must become the global `cob`, or
Desktop keeps talking to whatever process already bound that port.

```bash
# From the checkout, if a workspace cob still owns ~/.codex:
node dist/cli.js stop --live-home

npm install -g ./codex-ollama-bridge-0.1.13.tgz   # only after explicit live authorization
cob version    # expect: cob 0.1.13 (global)
cob start
cob status     # health/overlay ok; provenance fresh, or explained fail-closed skew
```

`cob restore` still does not revert a user-owned Desktop overlay in
`config.toml`. If `cob status` says `desktop overlay: broken`, fix that overlay
by hand (backup on this machine:
`~/.codex/config.toml.pre-cob-desktop-20260819`). Snapshot SHA before any
real-home config experiment.

After a live catalog write, fully quit and reopen ChatGPT Desktop before
judging picker changes. `cob status` `stale` or `unknown` means regenerate
with `cob sync` or `cob start`; it is not fixed by restarting the gateway
alone if the producer/consumer binaries still disagree.

After this, further product work uses `cob start --dev`. Bump + pack +
`npm install -g` only when the live Desktop/CLI gateway should move.

## What a release is not

- Not proof of G1–G10. [STATUS.md](./STATUS.md) is the live checkpoint.
- Not a ChatGPT.app patch and not OpenCodex `nativeAlias`.
- Not cob owning root `config.toml`.
