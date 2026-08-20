# Releases — global cob vs checkout

Live ChatGPT Desktop and daily `codex --profile cob` run the **globally
installed** `cob` binary. A git checkout is for `--dev` trials and for cutting
the next tarball. cob still does not write `~/.codex/config.toml`.

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
2. Set `package.json` `"version"` (semver). `0.x` until STATUS durability is
   proven. Do not jump to `1.0.0` to look finished.
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

npm install -g ./codex-ollama-bridge-0.1.5.tgz   # use the version you packed
cob version    # expect: cob 0.1.5 (global)
cob start
cob status     # gateway health ok; desktop overlay ok or ready
```

`cob restore` still does not revert a user-owned Desktop overlay in
`config.toml`. If `cob status` says `desktop overlay: broken`, fix that overlay
by hand (backup on this machine:
`~/.codex/config.toml.pre-cob-desktop-20260819`). Snapshot SHA before any
real-home config experiment.

After this, further product work uses `cob start --dev`. Bump + pack +
`npm install -g` only when the live Desktop/CLI gateway should move.

## What a release is not

- Not proof of G1–G10. [STATUS.md](./STATUS.md) is the live checkpoint.
- Not a ChatGPT.app patch and not OpenCodex `nativeAlias`.
- Not cob owning root `config.toml`.
