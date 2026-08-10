#!/usr/bin/env node
/**
 * git-will — analyze a repository's ownership structure.
 *
 * Discovers:
 *  - Per-file line ownership (who authored the most lines)
 *  - Bus factor (files where ONE author holds ≥ 80% of lines)
 *  - Repo-level bus factor estimate (truck-factor style heuristic)
 *  - Expertise map (which files each author dominates)
 *  - Danger files (bus-factor-1 files with ≥ 85% single-author share)
 *
 * Modes:
 *  - blame (default): accurate line ownership via git blame --use-mailmap
 *  - fast: approximate ownership via git log --numstat (better for huge repos)
 *
 * Pure git commands, zero dependencies. All analysis is local and offline.
 */

"use strict";

const { execFile, execFileSync } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const BLAME_CONCURRENCY = 8;

const SKIP_PATTERNS = [
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock|composer\.lock|go\.sum|Pipfile\.lock|mix\.lock)$/,
  /(^|\/)\.(gitmodules|env|env\.\w+)$/,
  /\.(min\.js|min\.css|map)$/,
  /(^|\/)(dist|build|out|coverage|\.next|\.nuxt|\.cache|\.parcel-cache|\.turbo|\.vite|node_modules|vendor|\.venv|venv|__pycache__|\.pytest_cache|target|\.gradle)(\/|$)/,
  /(^|\/)(backup|backups|\.bak|old|archive)[-_]?[\w.-]*(\/|$)/i,
  /(^|\/)\.(idea|vscode|svelte-kit|docusaurus|github|gitlab|husky|circleci)(\/|$)/,
  /\.(png|jpg|jpeg|gif|webp|ico|svg|woff|woff2|ttf|otf|eot|pdf|zip|tar|gz|pyc|so|dll|exe|lockb|node|wav|mp3|mp4|mov|avi|webm|ogg|flac)$/i,
];

function shouldSkipFile(file) {
  return SKIP_PATTERNS.some((re) => re.test(file));
}

/** Run a git command in the repo dir, return stdout. */
function git(repoDir, args) {
  try {
    return execFileSync("git", args, {
      cwd: repoDir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const stderr = (err.stderr || "").trim();
    throw new Error(`git ${args.join(" ")} failed: ${stderr || err.message}`);
  }
}

/** Async git — used for parallel blame workers. */
async function gitAsync(repoDir, args) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoDir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const stderr = (err.stderr || "").trim();
    throw new Error(`git ${args.join(" ")} failed: ${stderr || err.message}`);
  }
}

/**
 * Run blame with mailmap when supported; fall back if the flag is unknown.
 * Git ≥ 2.23 understands --use-mailmap on blame.
 */
async function blamePorcelain(repoDir, file) {
  try {
    return await gitAsync(repoDir, ["blame", "HEAD", "--use-mailmap", "--line-porcelain", "--", file]);
  } catch (err) {
    if (/use-mailmap|unknown option|invalid option/i.test(err.message)) {
      return await gitAsync(repoDir, ["blame", "HEAD", "--line-porcelain", "--", file]);
    }
    throw err;
  }
}

function isRepo(repoDir) {
  try {
    git(repoDir, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/** True when HEAD resolves to at least one commit. */
function hasCommits(repoDir) {
  try {
    const count = git(repoDir, ["rev-list", "--count", "HEAD"]).trim();
    return count !== "" && count !== "0";
  } catch {
    return false;
  }
}

/** Strip surrounding <> from porcelain author-mail values. */
function stripMailAngles(email) {
  const s = (email || "").trim();
  if (s.startsWith("<") && s.endsWith(">")) return s.slice(1, -1).trim();
  return s;
}

/** Normalize author identity: merge email aliases; casefold display names. */
function normalizeAuthor(name, email) {
  const cleanName = (name || "").trim();
  const cleanEmail = stripMailAngles(email).toLowerCase();
  // GitHub noreply addresses: 12345678+user@users.noreply.github.com -> user
  const noreplyMatch = cleanEmail.match(/^\d+\+([^@]+)@users\.noreply\.github\.com$/);
  if (noreplyMatch) return noreplyMatch[1].toLowerCase();
  // Local noreply: user@users.noreply.github.com
  const localNoreply = cleanEmail.match(/^([^@]+)@users\.noreply\.github\.com$/);
  if (localNoreply) return localNoreply[1].toLowerCase();
  // Prefer the display name if present and not garbage — casefold for stable merge
  if (cleanName && cleanName !== "(no author)" && !/^\d+$/.test(cleanName)) {
    return cleanName.toLocaleLowerCase("en-US");
  }
  // Fall back to email local part
  return (cleanEmail.split("@")[0] || "unknown").toLowerCase();
}

/** Run async work over items with a fixed concurrency cap. */
async function mapPool(items, concurrency, workerFn, onProgress) {
  const total = items.length;
  if (total === 0) return [];
  const results = new Array(total);
  let nextIndex = 0;
  let completed = 0;

  async function runWorker() {
    while (true) {
      const index = nextIndex++;
      if (index >= total) return;
      results[index] = await workerFn(items[index], index);
      completed++;
      if (onProgress) onProgress(completed, total);
    }
  }

  const poolSize = Math.min(concurrency, total);
  await Promise.all(Array.from({ length: poolSize }, () => runWorker()));
  return results;
}

function reportBlameProgress(done, total) {
  if (!process.stderr.isTTY) return;
  process.stderr.write(`\r${done}/${total} files`);
  if (done === total) process.stderr.write("\n");
}

/**
 * Parse one file's --line-porcelain blame into author line counts.
 * Returns null when the file has no countable lines.
 */
function parseBlamePorcelain(text) {
  const counts = {};
  let total = 0;
  const entries = text.split("\n");
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].startsWith("author ")) {
      const name = entries[i].slice(7);
      let email = "";
      if (i + 1 < entries.length && entries[i + 1].startsWith("author-mail ")) {
        email = entries[i + 1].slice(12);
      }
      const id = normalizeAuthor(name, email);
      counts[id] = (counts[id] || 0) + 1;
      total++;
    }
  }
  if (total === 0) return null;
  return { counts, total };
}

/**
 * Build a per-file line-ownership map using git blame (parallel, capped).
 * Honors .mailmap via --use-mailmap when available.
 */
async function blameOwnership(repoDir) {
  const tracked = git(repoDir, ["ls-files", "-z"]).split("\0").filter(Boolean);
  const files = tracked.filter((f) => !shouldSkipFile(f));
  const ownership = {};
  const skipped = tracked.length - files.length;

  await mapPool(
    files,
    BLAME_CONCURRENCY,
    async (file) => {
      let text;
      try {
        // Blame HEAD, not the working tree — otherwise uncommitted edits
        // produce a phantom "Not Committed Yet" author.
        text = await blamePorcelain(repoDir, file);
      } catch {
        return; // binary or unblamable — skip
      }
      const parsed = parseBlamePorcelain(text);
      if (parsed) ownership[file] = parsed;
    },
    reportBlameProgress
  );

  return { ownership, skippedFiles: skipped };
}

/**
 * Fast approximate ownership from git log --numstat (added lines per author/file).
 * Less accurate than blame, much faster on large repos. Honors mailmap when possible.
 */
function numstatOwnership(repoDir) {
  let raw;
  try {
    raw = git(repoDir, [
      "log",
      "HEAD",
      "--use-mailmap",
      "--numstat",
      "--pretty=format:AUTHOR\t%aN\t%aE",
    ]);
  } catch (err) {
    if (/use-mailmap|unknown option|invalid option/i.test(err.message)) {
      raw = git(repoDir, ["log", "HEAD", "--numstat", "--pretty=format:AUTHOR\t%aN\t%aE"]);
    } else {
      throw err;
    }
  }

  const ownership = {};
  let currentAuthor = "unknown";
  let trackedApprox = 0;

  for (const line of raw.split("\n")) {
    if (!line) continue;
    if (line.startsWith("AUTHOR\t")) {
      const parts = line.split("\t");
      currentAuthor = normalizeAuthor(parts[1] || "", parts[2] || "");
      continue;
    }
    // numstat: adds \t dels \t path  (binary: - \t - \t path)
    const tab1 = line.indexOf("\t");
    const tab2 = tab1 === -1 ? -1 : line.indexOf("\t", tab1 + 1);
    if (tab1 === -1 || tab2 === -1) continue;
    const addsStr = line.slice(0, tab1);
    const file = line.slice(tab2 + 1);
    if (!file || addsStr === "-") continue;
    if (shouldSkipFile(file)) continue;
    const adds = parseInt(addsStr, 10);
    if (!Number.isFinite(adds) || adds <= 0) continue;
    if (!ownership[file]) {
      ownership[file] = { counts: {}, total: 0 };
      trackedApprox++;
    }
    ownership[file].counts[currentAuthor] = (ownership[file].counts[currentAuthor] || 0) + adds;
    ownership[file].total += adds;
  }

  // skippedFiles unknown precisely in fast mode — report 0 (we never listed all tracked)
  return { ownership, skippedFiles: 0 };
}

/**
 * Compute bus factor per file: 1 if a single author owns >= 80% of lines.
 * Returns { file: { topAuthor, topShare, busFactor, total } }
 */
function busFactorAnalysis(ownership) {
  const result = {};
  for (const [file, { counts, total }] of Object.entries(ownership)) {
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0 || total <= 0) continue;
    const [topAuthor, topLines] = entries[0];
    const topShare = topLines / total;
    const busFactor = topShare >= 0.8 ? 1 : topShare >= 0.6 ? 2 : 3;
    result[file] = { topAuthor, topLines, topShare, busFactor, total };
  }
  return result;
}

/** Aggregate authorship: total lines per author across all files. */
function authorTotals(ownership) {
  const totals = {};
  for (const { counts } of Object.values(ownership)) {
    for (const [author, n] of Object.entries(counts)) {
      totals[author] = (totals[author] || 0) + n;
    }
  }
  return totals;
}

/**
 * Expertise map: files where an author is the dominant owner.
 * lonelyFiles = bus-factor-1 files (top author owns ≥ 80% of lines).
 */
function expertiseMap(analysis) {
  const map = {};
  const lonelyFiles = [];
  for (const [file, info] of Object.entries(analysis)) {
    if (info.busFactor === 1) {
      lonelyFiles.push({ file, ...info });
    }
    if (!map[info.topAuthor]) map[info.topAuthor] = [];
    map[info.topAuthor].push({ file, share: info.topShare, lines: info.topLines });
  }
  return { map, lonelyFiles };
}

/**
 * Repo-level bus factor estimate (truck-factor style heuristic).
 * A contributor "owns" a file when they hold ≥ 50% of its counted lines.
 * Authors are removed greedily (most owned files first) until ≤ 50% of
 * owned files retain an owner. The number removed is the estimate.
 * Documented heuristic — not a research-grade truck-factor implementation.
 */
function estimateRepoBusFactor(fileAnalysis) {
  const owned = [];
  const authorFiles = new Map();
  for (const [file, info] of Object.entries(fileAnalysis)) {
    if (info.topShare < 0.5) continue;
    owned.push(file);
    if (!authorFiles.has(info.topAuthor)) authorFiles.set(info.topAuthor, []);
    authorFiles.get(info.topAuthor).push(file);
  }
  if (owned.length === 0) return 0;

  const ranking = [...authorFiles.entries()].sort((a, b) => b[1].length - a[1].length);
  const remaining = new Set(owned);
  const half = owned.length / 2;
  let removed = 0;
  for (const [, files] of ranking) {
    if (remaining.size <= half) break;
    for (const f of files) remaining.delete(f);
    removed++;
  }
  return Math.max(removed, 1);
}

/** Top-level repo metadata. */
function repoMeta(repoDir) {
  const remote = (() => {
    try {
      return git(repoDir, ["config", "--get", "remote.origin.url"]).trim();
    } catch {
      return "";
    }
  })();
  const branch = (() => {
    try {
      return git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    } catch {
      return "HEAD";
    }
  })();
  const commitCount = (() => {
    try {
      return git(repoDir, ["rev-list", "--count", "HEAD"]).trim();
    } catch {
      return "?";
    }
  })();
  return { remote, branch, commitCount };
}

/**
 * Full analysis pipeline.
 * opts: { mode?: "blame" | "fast" }
 */
async function analyze(repoDir, opts = {}) {
  if (!isRepo(repoDir)) {
    throw new Error(`${repoDir} is not a git repository`);
  }
  if (!hasCommits(repoDir)) {
    throw new Error("no commits to analyze");
  }

  const mode = opts.mode === "fast" ? "fast" : "blame";
  const { ownership, skippedFiles } =
    mode === "fast" ? numstatOwnership(repoDir) : await blameOwnership(repoDir);

  const analysis = busFactorAnalysis(ownership);
  const totals = authorTotals(ownership);
  const { map, lonelyFiles } = expertiseMap(analysis);
  const meta = repoMeta(repoDir);
  const repoBusFactor = estimateRepoBusFactor(analysis);

  // Danger files: bus-factor-1 files with ≥ 85% single-author share (no size floor)
  const dangerFiles = lonelyFiles
    .filter((f) => f.topShare >= 0.85)
    .sort((a, b) => b.total - a.total);

  const lonelySorted = lonelyFiles.sort((a, b) => b.total - a.total);

  return {
    meta: { ...meta, mode, repoBusFactor },
    authors: Object.entries(totals)
      .map(([name, lines]) => ({ name, lines }))
      .sort((a, b) => b.lines - a.lines),
    lonelyFiles: lonelySorted,
    dangerFiles,
    expertise: map,
    skippedFiles,
    repoBusFactor,
    totals: {
      files: Object.keys(ownership).length,
      totalLines: Object.values(ownership).reduce((s, f) => s + f.total, 0),
    },
  };
}

module.exports = {
  analyze,
  isRepo,
  hasCommits,
  blameOwnership,
  numstatOwnership,
  busFactorAnalysis,
  authorTotals,
  normalizeAuthor,
  stripMailAngles,
  estimateRepoBusFactor,
  shouldSkipFile,
};
