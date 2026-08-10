#!/usr/bin/env node
/**
 * git-will — analyze a repository's ownership structure.
 *
 * Discovers:
 *  - Per-file line ownership (who authored the most lines)
 *  - Bus factor (files where ONE author holds the knowledge)
 *  - Expertise map (which files each author uniquely understands)
 *  - Danger windows (files with high churn + concentrated ownership)
 *
 * Pure git commands, zero dependencies. All analysis is local and offline.
 */

"use strict";

const { execFileSync } = require("child_process");

/** Run a git command in the repo dir, return stdout trimmed. */
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

function isRepo(repoDir) {
  try {
    git(repoDir, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/** Normalize author identity: merge email aliases under a display name. */
function normalizeAuthor(name, email) {
  const cleanName = (name || "").trim();
  const cleanEmail = (email || "").trim();
  // GitHub noreply addresses: 12345678+user@users.noreply.github.com -> user
  const noreplyMatch = cleanEmail.match(/^\d+\+([^@]+)@users\.noreply\.github\.com$/);
  if (noreplyMatch) return noreplyMatch[1];
  // Local noreply: user@users.noreply.github.com
  const localNoreply = cleanEmail.match(/^([^@]+)@users\.noreply\.github\.com$/);
  if (localNoreply) return localNoreply[1];
  // Prefer the display name if present and not garbage
  if (cleanName && cleanName !== "(no author)" && !/^\d+$/.test(cleanName)) return cleanName;
  // Fall back to email local part
  return cleanEmail.split("@")[0] || "unknown";
}

/**
 * Build a per-file line-ownership map using git blame.
 * Returns: { file: { author: lineCount, total: N } }
 * Skips lockfiles, binaries, and generated files.
 */
function blameOwnership(repoDir) {
  // Files tracked in HEAD, excluding obvious generated junk
  const tracked = git(repoDir, ["ls-files", "-z"])
    .split("\0")
    .filter(Boolean);

  const SKIP = [
    /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock|composer\.lock|go\.sum|Pipfile\.lock|mix\.lock)$/,
    /(^|\/)\.(gitmodules|env|env\.\w+)$/,
    /\.(min\.js|min\.css|map)$/,
    /(^|\/)(dist|build|out|coverage|\.next|\.nuxt|\.cache|\.parcel-cache|\.turbo|\.vite|node_modules|vendor|\.venv|venv|__pycache__|\.pytest_cache|target|\.gradle)(\/|$)/,
    /(^|\/)(backup|backups|\.bak|old|archive)[-_]?[\w.-]*(\/|$)/i,
    /(^|\/)\.(idea|vscode|svelte-kit|docusaurus|github|gitlab|husky|circleci)(\/|$)/,
    /\.(png|jpg|jpeg|gif|webp|ico|svg|woff|woff2|ttf|otf|eot|pdf|zip|tar|gz|pyc|so|dll|exe|lockb|node|wav|mp3|mp4|mov|avi|webm|ogg|flac)$/i,
  ];

  const files = tracked.filter((f) => !SKIP.some((re) => re.test(f)));
  const ownership = {};
  const skipped = tracked.length - files.length;

  for (const file of files) {
    let lines;
    try {
      // Blame HEAD, not the working tree — otherwise uncommitted edits
      // produce a phantom "Not Committed Yet" author.
      lines = git(repoDir, ["blame", "HEAD", "--line-porcelain", "--", file]);
    } catch {
      continue; // binary or unblamable — skip
    }
    const counts = {};
    let total = 0;
    // --line-porcelain emits "author <name>" then "author-mail <email>" per line
    const entries = lines.split("\n");
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
    if (total > 0) {
      ownership[file] = { counts, total };
    }
  }

  return { ownership, skippedFiles: skipped };
}

/**
 * Compute bus factor per file: 1 if a single author owns >= 80% of lines.
 * Returns { file: { topAuthor, topShare, busFactor, total } }
 */
function busFactorAnalysis(ownership) {
  const result = {};
  for (const [file, { counts, total }] of Object.entries(ownership)) {
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
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
 * Also flags "lonely files": bus factor 1 AND no other author over 10%.
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

/** Full analysis pipeline. */
function analyze(repoDir) {
  if (!isRepo(repoDir)) {
    throw new Error(`${repoDir} is not a git repository`);
  }
  const { ownership, skippedFiles } = blameOwnership(repoDir);
  const analysis = busFactorAnalysis(ownership);
  const totals = authorTotals(ownership);
  const { map, lonelyFiles } = expertiseMap(analysis);
  const meta = repoMeta(repoDir);

  // Danger files: bus factor 1 + small (hard to hand off, single owner)
  const dangerFiles = lonelyFiles
    .filter((f) => f.topShare >= 0.85)
    .sort((a, b) => b.total - a.total);

  return {
    meta,
    authors: Object.entries(totals)
      .map(([name, lines]) => ({ name, lines }))
      .sort((a, b) => b.lines - a.lines),
    busFactorFiles: Object.entries(analysis)
      .filter(([, info]) => info.busFactor === 1)
      .map(([file, info]) => ({ file, ...info }))
      .sort((a, b) => b.total - a.total),
    lonelyFiles: lonelyFiles.sort((a, b) => b.total - a.total),
    dangerFiles,
    expertise: map,
    skippedFiles,
    totals: {
      files: Object.keys(ownership).length,
      totalLines: Object.values(ownership).reduce((s, f) => s + f.total, 0),
    },
  };
}

module.exports = { analyze, isRepo, blameOwnership, busFactorAnalysis, authorTotals, normalizeAuthor };
