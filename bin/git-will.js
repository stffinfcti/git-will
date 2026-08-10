#!/usr/bin/env node
/**
 * git-will — the repo succession will.
 *
 *   git-will scan            Analyze ownership + bus factor of the current repo
 *   git-will draft           Interactively write WILL.md
 *   git-will draft --yes     Write WILL.md with sensible defaults (CI-safe)
 *   git-will paper           Print the analysis as a human report
 *
 * Zero dependencies. Runs locally on git history only.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { analyze } = require("../src/analyze");
const { draftWill } = require("../src/will");

const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const BRAND = "\x1b[38;2;59;130;246m";
const GREEN = "\x1b[38;2;16;185;129m";
const YELLOW = "\x1b[38;2;245;158;11m";
const RED = "\x1b[38;2;239;68;68m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[38;2;6;182;212m";
const NO_COLOR = process.env.NO_COLOR !== undefined || process.env.TERM === "dumb";

function c(code, text) {
  return NO_COLOR ? text : code + text + RESET;
}

function usage() {
  console.log(c(BRAND + BOLD, "git-will"));
  console.log(c(DIM, "Your repo has no will. This writes it.\n"));
  console.log("Usage:");
  console.log("  " + c(CYAN, "git-will scan") + "            " + c(DIM, "Analyze ownership + bus factor"));
  console.log("  " + c(CYAN, "git-will scan --json") + "    " + c(DIM, "Same analysis as machine-readable JSON"));
  console.log("  " + c(CYAN, "git-will draft") + "           " + c(DIM, "Interactively write WILL.md"));
  console.log("  " + c(CYAN, "git-will draft --yes") + "     " + c(DIM, "Write WILL.md with defaults (CI-safe)"));
  console.log("  " + c(CYAN, "git-will --version") + "      " + c(DIM, "Show version"));
}

function pct(share) {
  return Math.round(share * 100) + "%";
}

function renderPaper(result) {
  const meta = result.meta;
  const lines = [];
  const repoLabel = meta.remote
    ? meta.remote.replace(/^.*[\/:]([^\/:]+?)(\.git)?$/, "$1")
    : "this repo";
  const title = "GIT WILL — " + repoLabel;
  const boxW = Math.max(42, title.length + 4);
  const bar = "─".repeat(boxW - 2);
  const pad = (s) => "│  " + s + " ".repeat(Math.max(0, boxW - 6 - s.length)) + "  │";
  lines.push(c(BRAND + BOLD, "┌" + bar + "┐"));
  lines.push(c(BRAND + BOLD, pad(title)));
  lines.push(c(BRAND + BOLD, "└" + bar + "┘"));
  lines.push("");
  if (meta.remote) lines.push(c(DIM, "repo ") + c(CYAN, meta.remote));
  lines.push(c(DIM, "branch ") + meta.branch + c(DIM, "  ·  commits ") + meta.commitCount);
  lines.push("");

  // Authors table
  lines.push(c(BOLD, "Authors"));
  lines.push(c(DIM, "───────"));
  for (const author of result.authors.slice(0, 8)) {
    const barLen = Math.max(1, Math.round((author.lines / result.authors[0].lines) * 30));
    const bar = "█".repeat(barLen);
    lines.push(
      `  ${c(GREEN, "✓")} ${author.name.padEnd(22)} ${String(author.lines).padStart(7)} ${c(CYAN, bar)}`
    );
  }
  lines.push("");

  // Bus factor files
  lines.push(c(BOLD, "Bus factor 1 — files only one person understands"));
  lines.push(c(DIM, "───────────────────────────────────────────────"));
  const lonely = result.lonelyFiles;
  if (lonely.length === 0) {
    lines.push("  " + c(GREEN, "✓ No single-owner files detected. Healthy."));
  } else {
    for (const f of lonely.slice(0, 10)) {
      lines.push(
        `  ${c(YELLOW, "⚠")} ${f.file.padEnd(40)} ${pct(f.topShare)} ${c(DIM, "by " + f.topAuthor)}`
      );
    }
    if (lonely.length > 10) lines.push(`  ${c(DIM, `…and ${lonely.length - 10} more`)}`);
  }
  lines.push("");

  // Danger files
  if (result.dangerFiles.length > 0) {
    lines.push(c(BOLD, "Most dangerous — single owner, meaningful size"));
    lines.push(c(DIM, "──────────────────────────────────────────────"));
    for (const f of result.dangerFiles.slice(0, 5)) {
      lines.push(`  ${c(RED, "✗")} ${f.file.padEnd(40)} ${f.total} lines, ${pct(f.topShare)} by ${f.topAuthor}`);
    }
    lines.push("");
  }

  lines.push(c(DIM, "Next: ") + c(CYAN, "git-will draft") + c(DIM, " — write the will while you're still alive."));
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "usage";
  const repoDir = process.cwd();

  if (command === "--version" || command === "-v") {
    console.log(require("../package.json").version);
    return;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    usage();
    return;
  }

  let result;
  try {
    result = analyze(repoDir);
  } catch (err) {
    console.error(c(RED, "✗ " + err.message));
    console.error(c(DIM, "  Hint: run inside a git repository."));
    process.exit(1);
  }

  if (command === "scan") {
    if (args.includes("--json")) {
      console.log(JSON.stringify({ schema: "git-will@1", generated: new Date().toISOString(), ...result }, null, 2));
      return;
    }
    console.log(renderPaper(result));
    return;
  }

  if (command === "paper") {
    // Back-compat alias for scan --json (used to be a separate command)
    console.log(JSON.stringify({ schema: "git-will@1", generated: new Date().toISOString(), ...result }, null, 2));
    return;
  }

  if (command === "draft") {
    const yesMode = args.includes("--yes") || args.includes("-y");
    const outPath = path.join(repoDir, "WILL.md");
    let md;
    if (yesMode) {
      // CI-safe defaults: no interactivity
      const defaults = {
        maintainer: result.authors[0] ? result.authors[0].name : "you",
        backup: "",
        keys: "",
        wishes: "",
        notes: "",
        blessed: result.lonelyFiles.length === 0,
      };
      md = await draftWill({
        repoName: path.basename(repoDir),
        analysis: result,
        answers: defaults,
        skipPrompts: true,
      });
    } else {
      md = await draftWill({
        repoName: path.basename(repoDir),
        analysis: result,
      });
    }
    fs.writeFileSync(outPath, md, "utf8");
    console.log(c(GREEN, "✓ Wrote ") + c(CYAN, outPath));
    console.log(c(DIM, "  Read it. Then write the will you want to leave."));
    return;
  }

  usage();
}

main().catch((err) => {
  console.error(c(RED, "✗ " + (err.message || err)));
  process.exit(1);
});
