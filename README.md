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
git-will scan              # Analyze ownership + bus factor
git-will scan --json       # Machine-readable analysis (versioned schema: git-will@1)
git-will draft             # Interactively write WILL.md
git-will draft --yes       # Write WILL.md with defaults (CI-safe)
```

### `git-will scan`

```
┌──────────────────────────────────────────┐
│  GIT WILL — codiev                        │
└──────────────────────────────────────────┘

repo https://github.com/stffinfcti/codiev.git
branch main  ·  commits 449

Authors
───────
  ✓ Ford Openclaw           224439 ██████████████████████████████
  ✓ stffinfcti               86230 ██████████████
  ✓ Viktor Ai                 7787 █

Bus factor 1 — files only one person understands
───────────────────────────────────────────────
  ⚠ codiev-core/codiev/agents.py              96% by stffinfcti
  ⚠ codiev-core/codiev/run_agent.py           99% by Ford Openclaw

Most dangerous — single owner, meaningful size
──────────────────────────────────────────────
  ✗ codiev-core/codiev/agents.py    15836 lines, 96% by stffinfcti
  ✗ codiev-core/codiev/run_agent.py  10864 lines, 99% by Ford Openclaw

Next: git-will draft — write the will while you're still alive.
```

### `git-will draft`

Walks you through the succession document interactively:

```
▸ Who's the main maintainer? [Ford Openclaw]
▸ Who's the backup (the person who'd take over)? []
▸ Who gets the keys (repo access, npm/pypi publish, domain, CI)? []
▸ Your wishes if you can't maintain this anymore? []
▸ Anything future maintainers should know? []
```

Writes `WILL.md` to the repo root — ownership snapshot, succession plan, first-48-hours checklist for the successor, and an **AI-readable machine section** so tooling and future maintainers can act on it programmatically.

Works with piped input too (CI/scripts):

```bash
printf "waxhy\nmarco\nwaxhy + marco\ntake the good parts, archive the rest\n\n" | git-will draft
```

## What it detects

- **Per-file line ownership** — who actually authored each file (via `git blame`)
- **Bus factor** — files where ONE author holds ≥ 80% of the lines
- **Danger files** — bus-factor-1 files where one author holds ≥ 85% of the lines (sorted by size; no minimum line count)
- **Knowledge map** — which files each author dominates by line ownership
- **Generated junk** — lockfiles, binaries, build output (auto-skipped so they don't pollute the analysis)

## The WILL.md

```markdown
# WILL.md — succession plan for codiev

## The short version
- **Maintainer:** waxhy
- **Backup / successor:** marco
- **Keys go to:** waxhy + marco
- **Wishes:** take the good parts, archive the rest

## Succession plan
### If I can't maintain this anymore
1. **Wishes:** take the good parts, archive the rest
2. **Hand off to:** marco
3. **Keys:** waxhy + marco

### First 48 hours for the successor
1. Read the knowledge map — those files are the core.
2. Run `npx git-will scan` yourself.
3. Open a PR within a week to confirm you have access.

## AI-readable handoff (machine section)
### Critical files
- `codiev-core/codiev/agents.py` — bus factor 1, 96% by stffinfcti (15836 lines)
```

## Why

- The internet's software is one missed email away from the next event-stream.
- Standard tooling tells you **you have** a bus factor problem. Nothing writes the **will**.
- Every repo deserves a successor, even the small ones. Especially the small ones.

## License

MIT. Go write your will.
