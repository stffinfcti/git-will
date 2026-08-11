#!/usr/bin/env node
/**
 * git-will — the repo succession will.
 *
 *   git-will scan              Analyze ownership + bus factor of the current repo
 *   git-will scan --json       Same analysis as machine-readable JSON
 *   git-will scan --fast       Faster approximate analysis (git log --numstat)
 *   git-will draft             Interactively write WILL.md
 *   git-will draft --yes       Write WILL.md with defaults (CI-safe)
 *   git-will draft --force      Overwrite existing WILL.md (backs up to .bak)
 *   git-will paper             Alias of scan --json (back-compat)
 *
 * Zero dependencies. Runs locally on git history only.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { analyze } = require("../src/analyze");
const { draftWill } = require("../src/will");

const pkg = require("../package.json");

// Chrome palette — cool steel, ice accent (no purple)
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const STEEL = "\x1b[38;2;156;163;175m"; // chrome mid
const BRIGHT = "\x1b[38;2;229;231;235m"; // polished highlight
const ICE = "\x1b[38;2;125;211;252m"; // ice accent
const GREEN = "\x1b[38;2;52;211;153m";
const YELLOW = "\x1b[38;2;251;191;36m";
const RED = "\x1b[38;2;248;113;113m";

const USE_COLOR =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb" &&
  Boolean(process.stdout.isTTY);

function c(code, text) {
  return USE_COLOR ? code + text + RESET : text;
}

function usage() {
  const w = 52;
  console.log(chromeFrame("git-will", "v" + pkg.version, w));
  console.log(c(DIM, "  Your repo has no will. This writes it.\n"));
  console.log(c(BOLD, "Usage:"));
  const rows = [
    ["git-will scan", "Analyze ownership + bus factor"],
    ["git-will scan --json", "Machine-readable JSON (git-will@1)"],
    ["git-will scan --fast", "Faster approximate analysis (numstat)"],
    ["git-will draft", "Interactively write WILL.md"],
    ["git-will draft --yes", "Write WILL.md with defaults (CI-safe)"],
    ["git-will draft --force", "Overwrite WILL.md (backs up to .bak)"],
    ["git-will --dir <path>", "Analyze a repo at <path> instead of cwd"],
    ["git-will --version", "Show version"],
  ];
  for (const [cmd, desc] of rows) {
    console.log("  " + c(ICE, cmd.padEnd(26)) + c(DIM, desc));
  }
}

function pct(share) {
  return Math.round(share * 100) + "%";
}

/** Truncate path in the middle if longer than width. */
function truncPath(file, width) {
  if (file.length <= width) return file.padEnd(width);
  if (width < 8) return file.slice(0, width);
  const keep = width - 1;
  const head = Math.ceil(keep * 0.4);
  const tail = keep - head;
  return (file.slice(0, head) + "…" + file.slice(-tail)).padEnd(width);
}

/** Chrome double-line frame with title + optional right badge. */
function chromeFrame(title, badge, width) {
  const inner = width - 2;
  const label = " " + title + " ";
  const right = badge ? " " + badge + " " : "";
  const fill = Math.max(0, inner - label.length - right.length);
  const t =
    c(STEEL + BOLD, "╔") + c(BRIGHT, "═".repeat(inner)) + c(STEEL + BOLD, "╗");
  const m =
    c(STEEL + BOLD, "║") +
    c(BRIGHT + BOLD, label) +
    " ".repeat(fill) +
    c(ICE, right) +
    c(STEEL + BOLD, "║");
  const b =
    c(STEEL + BOLD, "╚") + c(STEEL, "═".repeat(inner)) + c(STEEL + BOLD, "╝");
  return [t, m, b].join("\n");
}

function section(title) {
  return (
    c(STEEL, "── ") +
    c(BRIGHT + BOLD, title) +
    " " +
    c(STEEL, "─".repeat(Math.max(4, 40 - title.length)))
  );
}

function meter(ratio, width) {
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  const empty = width - filled;
  // metallic bar: solid + shaded rest
  return c(ICE, "▓".repeat(filled)) + c(STEEL + DIM, "░".repeat(empty));
}

/** Parse argv into { command, flags, dir }. */
function parseArgs(argv) {
  const flags = new Set();
  let command = null;
  let dir = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir" || a === "-C") {
      dir = argv[++i];
      if (!dir) throw new Error("--dir requires a path argument");
      continue;
    }
    if (a.startsWith("--dir=")) {
      dir = a.slice("--dir=".length);
      if (!dir) throw new Error("--dir requires a path argument");
      continue;
    }
    if (a.startsWith("-") && a !== "-v" && a !== "-h" && a !== "-y") {
      flags.add(a);
      continue;
    }
    if (a === "-v" || a === "-h" || a === "-y") {
      flags.add(a === "-v" ? "--version" : a === "-h" ? "--help" : "--yes");
      continue;
    }
    if (!command) {
      command = a;
      continue;
    }
    flags.add("__extra__:" + a);
  }
  return { command: command || "usage", flags, dir };
}

function riskBanner(result) {
  const lonely = result.lonelyFiles.length;
  const bf = result.repoBusFactor;
  if (lonely === 0) {
    return { label: "HEALTHY", tone: GREEN, detail: "no single-owner files detected" };
  }
  if (bf <= 1) {
    return {
      label: "CRITICAL",
      tone: RED,
      detail: `${lonely} single-owner file${lonely === 1 ? "" : "s"} · bus factor ~${bf}`,
    };
  }
  if (bf === 2) {
    return {
      label: "ELEVATED",
      tone: YELLOW,
      detail: `${lonely} single-owner file${lonely === 1 ? "" : "s"} · bus factor ~${bf}`,
    };
  }
  return {
    label: "WATCH",
    tone: ICE,
    detail: `${lonely} single-owner file${lonely === 1 ? "" : "s"} · bus factor ~${bf}`,
  };
}

function renderPaper(result) {
  const meta = result.meta;
  const lines = [];
  const repoLabel = meta.remote
    ? meta.remote.replace(/^.*[\/:]([^\/:]+?)(\.git)?$/, "$1")
    : "this repo";
  const width = 56;

  lines.push(chromeFrame("GIT WILL", repoLabel.slice(0, 22), width));
  lines.push("");

  const risk = riskBanner(result);
  lines.push(
    "  " +
      c(STEEL, "┌ risk ") +
      c(risk.tone + BOLD, " " + risk.label + " ") +
      c(STEEL, "┐")
  );
  lines.push("  " + c(DIM, risk.detail));
  lines.push("");

  if (meta.remote) {
    lines.push("  " + c(STEEL, "repo") + "   " + c(ICE, meta.remote));
  }
  const metaBits = [
    c(STEEL, "branch") + " " + meta.branch,
    c(STEEL, "commits") + " " + meta.commitCount,
    c(STEEL, "files") + " " + String(result.totals.files),
  ];
  if (meta.mode === "fast") metaBits.push(c(STEEL, "mode") + " fast");
  lines.push("  " + metaBits.join(c(DIM, "  ·  ")));
  lines.push("");

  // Authors
  const totalLines = result.totals.totalLines || 1;
  lines.push(section("AUTHORS"));
  if (result.authors.length === 0) {
    lines.push("  " + c(DIM, "No authorship data."));
  } else {
    const top = result.authors[0].lines || 1;
    for (const author of result.authors.slice(0, 8)) {
      const share = author.lines / totalLines;
      lines.push(
        "  " +
          c(BRIGHT, author.name.padEnd(18)) +
          c(DIM, String(author.lines).padStart(7)) +
          "  " +
          c(STEEL, pct(share).padStart(4)) +
          "  " +
          meter(author.lines / top, 22)
      );
    }
  }
  lines.push("");

  // Bus factor files
  lines.push(section("BUS FACTOR 1"));
  const lonely = result.lonelyFiles;
  if (lonely.length === 0) {
    lines.push("  " + c(GREEN, "✓") + c(DIM, "  No single-owner files. Looking good."));
  } else {
    for (const f of lonely.slice(0, 10)) {
      lines.push(
        "  " +
          c(YELLOW, "▸") +
          " " +
          truncPath(f.file, 34) +
          " " +
          c(BRIGHT, pct(f.topShare).padStart(4)) +
          "  " +
          c(DIM, f.topAuthor)
      );
    }
    if (lonely.length > 10) {
      lines.push("  " + c(DIM, `…and ${lonely.length - 10} more`));
    }
  }
  lines.push("");

  // Danger files
  if (result.dangerFiles.length > 0) {
    lines.push(section("HOT FILES"));
    for (const f of result.dangerFiles.slice(0, 5)) {
      lines.push(
        "  " +
          c(RED, "●") +
          " " +
          truncPath(f.file, 32) +
          " " +
          c(DIM, String(f.total).padStart(5) + " ln") +
          "  " +
          c(BRIGHT, pct(f.topShare)) +
          " " +
          c(DIM, f.topAuthor)
      );
    }
    lines.push("");
  }

  lines.push(c(STEEL, "─".repeat(width)));
  lines.push(
    "  " +
      c(DIM, "next") +
      "  " +
      c(ICE + BOLD, "git-will draft") +
      c(DIM, "  — write the will while you're still alive")
  );
  return lines.join("\n");
}

/** Ask a single yes/no on stdin when TTY. */
function confirmOverwrite(outPath) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(c(STEEL, "WILL.md exists. Overwrite? [y/N] "), (answer) => {
      rl.close();
      resolve(/^y|yes/i.test((answer || "").trim()));
    });
  });
}

async function prepareWillWrite(outPath, { yesMode, force }) {
  if (!fs.existsSync(outPath)) return;

  let proceed = false;
  if (force) {
    proceed = true;
  } else if (!yesMode && Boolean(process.stdin.isTTY)) {
    proceed = await confirmOverwrite(outPath);
    if (!proceed) {
      throw new Error("Aborted — existing WILL.md left untouched.");
    }
  } else {
    throw new Error(
      `WILL.md already exists at ${outPath}. Pass --force to overwrite (backs up to WILL.md.bak), or remove/rename it.`
    );
  }

  const bakPath = outPath + ".bak";
  fs.copyFileSync(outPath, bakPath);
  console.error(c(DIM, `  backed up → ${bakPath}`));
  return proceed;
}

function clearProgressLine() {
  if (!process.stderr.isTTY) return;
  process.stderr.write("\r" + " ".repeat(48) + "\r");
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(c(RED, "✗ " + err.message));
    process.exit(1);
  }

  const { command, flags, dir } = parsed;
  const repoDir = path.resolve(dir || process.cwd());

  if (flags.has("--version") || command === "--version") {
    console.log(pkg.version);
    return;
  }
  if (
    flags.has("--help") ||
    command === "--help" ||
    command === "help" ||
    command === "usage"
  ) {
    usage();
    return;
  }

  if (command.startsWith("--")) {
    usage();
    process.exitCode = 1;
    return;
  }

  const known = new Set(["scan", "draft", "paper"]);
  if (!known.has(command)) {
    usage();
    process.exitCode = 1;
    return;
  }

  const mode = flags.has("--fast") ? "fast" : "blame";
  const asJson = flags.has("--json") || command === "paper";

  let result;
  try {
    result = await analyze(repoDir, { mode });
  } catch (err) {
    clearProgressLine();
    console.error(c(RED, "✗ " + err.message));
    if (/not a git repository/i.test(err.message)) {
      console.error(c(DIM, "  Hint: run inside a git repository, or pass --dir <path>."));
    }
    process.exit(1);
  }
  clearProgressLine();

  if (command === "scan" || command === "paper") {
    if (asJson) {
      console.log(
        JSON.stringify(
          { schema: "git-will@1", generated: new Date().toISOString(), ...result },
          null,
          2
        )
      );
      return;
    }
    console.log(renderPaper(result));
    return;
  }

  if (command === "draft") {
    const yesMode = flags.has("--yes");
    const force = flags.has("--force");
    const outPath = path.join(repoDir, "WILL.md");

    const risk = riskBanner(result);
    console.log(chromeFrame("DRAFT WILL", risk.label, 48));
    console.log(
      c(DIM, `  ${result.authors.length} authors  ·  ${result.lonelyFiles.length} single-owner files\n`)
    );

    try {
      await prepareWillWrite(outPath, { yesMode, force });
    } catch (err) {
      console.error(c(RED, "✗ " + err.message));
      process.exit(1);
    }
    let md;
    if (yesMode) {
      const defaults = {
        maintainer: result.authors[0] ? result.authors[0].name : "you",
        backup: "",
        keys: "",
        wishes: "",
        notes: "",
        blessed: result.lonelyFiles.length > 0,
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
    console.log("");
    console.log(c(GREEN + BOLD, "✓") + " " + c(BRIGHT, "Wrote ") + c(ICE, outPath));
    console.log(c(DIM, "  Commit it. Keep it current. That’s the whole point."));
    return;
  }
}

main().catch((err) => {
  clearProgressLine();
  console.error(c(RED, "✗ " + (err.message || err)));
  process.exit(1);
});
