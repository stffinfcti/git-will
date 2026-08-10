# ⚰️ git-will

**Your repo has no will. If you vanish tomorrow, the code dies with you.**

`git-will` analyzes your repository's ownership structure and writes `WILL.md` — the succession plan for your code: who knows what, who gets the keys, your wishes, and an AI-readable handoff section for the next maintainer.

> 65% of popular projects have a bus factor ≤ 2 ([Wikipedia, citing a 2015/16 study of 133 popular GitHub projects](https://en.wikipedia.org/wiki/Bus_factor)). One person holds the knowledge. If that person disappears, the project stalls and the code dies with them. Write the will while you're still alive.

## Install

```bash
npx git-will scan      # no install — runs instantly
npm i -g git-will      # or install globally
```

Zero dependencies. Runs locally on your git history. Nothing leaves your machine.

## Usage

```bash
git-will scan              # Analyze ownership + bus factor (git blame)
git-will scan --json       # Machine-readable analysis (versioned schema: git-will@1)
git-will scan --fast       # Faster approximate analysis via git log --numstat
git-will draft             # Interactively write WILL.md
git-will draft --yes       # Write WILL.md with defaults (CI-safe)
git-will draft --force     # Overwrite existing WILL.md (backs up to WILL.md.bak)
git-will --dir <path> …    # Run against another repo without cd
```

### `git-will scan`

```
┌──────────────────────────────────────────┐
│  GIT WILL — example-app                   │
└──────────────────────────────────────────┘

repo https://github.com/example/example-app.git
branch main  ·  commits 449  ·  repo bus factor ~2

Authors
───────
  ✓ alex                    224439 ██████████████████████████████
  ✓ sam                      86230 ██████████████
  ✓ jordan                    7787 █

Bus factor 1 — files only one person understands
───────────────────────────────────────────────
  ⚠ src/core/engine.js                        96% by sam
  ⚠ src/core/runner.js                        99% by alex

Most dangerous — highest single-owner share
──────────────────────────────────────────
  ✗ src/core/engine.js              15836 lines, 96% by sam
  ✗ src/core/runner.js              10864 lines, 99% by alex

Next: git-will draft — write the will while you're still alive.
```

### `git-will draft`

Walks you through the succession document interactively:

```
▸ Who's the main maintainer? [alex]
▸ Who's the backup (the person who'd take over)? []
▸ Who gets the keys (repo access, npm/pypi publish, domain, CI)? []
▸ Your wishes if you can't maintain this anymore? []
▸ Anything future maintainers should know? []
```

Writes `WILL.md` to the repo root — ownership snapshot, succession plan, first-48-hours checklist for the successor, and an **AI-readable machine section** so tooling and future maintainers can act on it programmatically.

Works with piped input too (CI/scripts):

```bash
printf "alex\nsam\nalex + sam\ntake the good parts, archive the rest\n\n" | git-will draft
```

## What it detects

- **Per-file line ownership** — who authored each file (default: `git blame --use-mailmap`; honors `.mailmap`)
- **Bus factor (per file)** — files where ONE author holds ≥ 80% of the lines
- **Repo bus factor (~N)** — truck-factor style heuristic: greedy removal of knowledge owners until ≤ 50% of owned files retain an owner (documented estimate, not a research metric)
- **Danger files** — bus-factor-1 files where one author holds ≥ 85% of the lines (sorted by size; no minimum line count)
- **Knowledge map** — which files each author dominates by line ownership
- **Generated junk** — lockfiles, binaries, build output (auto-skipped so they don't pollute the analysis)

`--fast` trades blame accuracy for speed: ownership is approximated from `git log --numstat` (lines added per author), which is better for huge repos and CI timeouts.

## The WILL.md

```markdown
# WILL.md — succession plan for example-app

## The short version
- **Maintainer:** alex
- **Backup / successor:** sam
- **Keys go to:** alex + sam
- **Wishes:** take the good parts, archive the rest

## Succession plan
### If I can't maintain this anymore
1. **Wishes:** take the good parts, archive the rest
2. **Hand off to:** sam
3. **Keys:** alex + sam

### First 48 hours for the successor
1. Read the knowledge map — those files are the core.
2. Run `npx git-will scan` yourself.
3. Open a PR within a week to confirm you have access.

## AI-readable handoff (machine section)
### Critical files
- `src/core/engine.js` — bus factor 1, 96% by sam (15836 lines)
```

## Why

- The internet's software is one missed email away from the next event-stream.
- Standard tooling tells you **you have** a bus factor problem. Nothing writes the **will**.
- Every repo deserves a successor, even the small ones. Especially the small ones.

## License

MIT. Go write your will.
