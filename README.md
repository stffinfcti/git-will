# git-will

**Your repo has no will. If you vanish tomorrow, the code dies with you.**

`git-will` is a zero-dependency Node CLI that reads your git history, shows who actually owns the code, and writes `WILL.md` — a succession plan for the next maintainer.

Most tools stop at “you have a bus-factor problem.” This one makes you write the will.

> About 65% of popular projects have a bus factor ≤ 2 ([Wikipedia](https://en.wikipedia.org/wiki/Bus_factor)). Write the plan while you’re still here.

## Quick start

```bash
npx git-will scan          # see ownership + risk
npx git-will draft         # write WILL.md interactively
```

Requirements: **Node 18+** and **git**. No npm dependencies. Analysis stays on your machine.

```bash
npm i -g git-will          # optional global install
```

## What you get

| Command | Result |
|--------|--------|
| `scan` | Terminal report: authors, single-owner files, danger list, repo bus-factor estimate |
| `scan --json` | Same data as versioned JSON (`git-will@1`) for scripts/CI |
| `draft` | Interactive `WILL.md`: maintainer, backup, keys, wishes, handoff checklist |
| `draft --yes` | Non-interactive defaults (safe for CI) |

## Usage

```bash
git-will scan                 # blame-based ownership (accurate)
git-will scan --json          # machine-readable output
git-will scan --fast          # faster approx via git log --numstat
git-will draft                # interactive WILL.md
git-will draft --yes          # CI-friendly defaults
git-will draft --force        # overwrite WILL.md (backs up to WILL.md.bak)
git-will --dir path/to/repo … # analyze another repo without cd
git-will --version
```

### Example `scan`

```
┌──────────────────────────────────────────┐
│  GIT WILL — example-app                  │
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

### Example `draft`

```
▸ Who's the main maintainer? [alex]
▸ Who's the backup (the person who'd take over)? []
▸ Who gets the keys (repo access, npm/pypi publish, domain, CI)? []
▸ Your wishes if you can't maintain this anymore? []
▸ Anything future maintainers should know? []
```

Pipe answers for scripts:

```bash
printf "alex\nsam\nalex + sam\narchive if unused\n\n" | git-will draft
```

## How ownership is measured

Defaults are **honest heuristics**, not academic truck-factor research.

| Signal | Rule |
|--------|------|
| Per-file ownership | Line authorship via `git blame` (honors `.mailmap`) |
| Bus factor 1 (file) | One author holds **≥ 80%** of counted lines |
| Danger files | Bus-factor-1 files with **≥ 85%** single-author share (sorted by size) |
| Repo bus factor (~N) | Greedy removal of knowledge owners until ≤ 50% of owned files retain an owner |
| Skipped noise | Lockfiles, binaries, build output, common generated dirs |

**`--fast`** skips blame and approximates ownership from `git log --numstat` (lines added). Use it on huge repos or tight CI budgets; prefer default blame when accuracy matters.

## What’s in WILL.md

A practical handoff doc, not a manifesto:

- Maintainer, backup, who gets the keys, wishes
- Ownership snapshot from the last scan
- First-48-hours checklist for a successor
- Structured “machine section” for tooling / future maintainers

Never put real secrets in `WILL.md` — names of people and systems only.

## Why this exists

Bus-factor dashboards are common. Succession documents are not.

If the person who knows `src/core/` disappears, a chart won’t ship a patch. A will might.

## License

MIT
