#!/usr/bin/env node
/**
 * git-will — WILL.md generator.
 *
 * Turns a repo analysis into a succession document: who knows what,
 * who gets the keys, your wishes, and an AI-readable handoff section.
 *
 * Interactive prompts when TTY; all questions skippable via --yes / flags.
 */

"use strict";

const readline = require("readline");
const path = require("path");

/**
 * Prompt engine that works with BOTH interactive terminals and piped stdin.
 *
 * - Piped input (e.g. `printf "a\nb\n" | git-will draft`): all lines are
 *   collected up front, then consumed in order. No races.
 * - Interactive TTY: real prompts via rl.question().
 */
function createPrompter() {
  const isTTY = Boolean(process.stdin.isTTY);
  const queue = [];
  let closed = false;
  let onLine = null;
  let closedPromise = null;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("line", (line) => {
    if (onLine) {
      const cb = onLine;
      onLine = null;
      cb(line);
    } else {
      queue.push(line);
    }
  });
  closedPromise = new Promise((resolve) => {
    rl.on("close", () => {
      closed = true;
      resolve();
      if (onLine) {
        const cb = onLine;
        onLine = null;
        cb("");
      }
    });
  });

  /**
   * For non-TTY (piped) input: wait until ALL stdin lines have been read
   * before answering any question. This removes the race entirely.
   */
  async function ready() {
    if (!isTTY) {
      await closedPromise;
    }
  }

  /** Ask a single question. Returns trimmed answer (may be empty). */
  function ask(question) {
    return new Promise((resolve) => {
      if (queue.length > 0) {
        resolve(queue.shift().trim());
        return;
      }
      if (!isTTY || closed) {
        resolve(""); // piped stdin exhausted — no more answers
        return;
      }
      onLine = (line) => resolve(line.trim());
      rl.question(question, (answer) => {
        if (onLine) {
          onLine = null;
          resolve(answer.trim());
        }
      });
    });
  }

  /** Ask a yes/no question, default true. */
  async function askYesNo(question, def = true) {
    const hint = def ? "Y/n" : "y/N";
    const answer = await ask(`${question} [${hint}] `);
    if (!answer) return def;
    return /^y|yes/i.test(answer);
  }

  function close() {
    try {
      rl.close();
    } catch {
      /* already closed */
    }
  }

  return { ask, askYesNo, close, ready, isTTY };
}

/** Build the AI-readable handoff section from the analysis. */
function aiHandoffSection(analysis) {
  const topFiles = analysis.dangerFiles.slice(0, 8);
  const lines = [
    "## AI-readable handoff (machine section)",
    "",
    "This section is structured for tooling and future maintainers.",
    "",
    "### Critical files",
    "",
  ];
  if (topFiles.length === 0) {
    lines.push("_No single-owner files detected at analysis time._");
  } else {
    for (const f of topFiles) {
      lines.push(
        `- \`${f.file}\` — bus factor ${f.busFactor}, ${Math.round(f.topShare * 100)}% authored by ${f.topAuthor} (${f.total} lines)`
      );
    }
  }
  lines.push("");
  lines.push("### Knowledge map (owner → files)", "");
  const expertEntries = Object.entries(analysis.expertise)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 6);
  for (const [author, files] of expertEntries) {
    const names = files.slice(0, 4).map((f) => `\`${f.file}\``).join(", ");
    const more = files.length > 4 ? ` (+${files.length - 4} more)` : "";
    lines.push(`- ${author}: ${names}${more}`);
  }
  lines.push("");
  lines.push("### Command to regenerate", "");
  lines.push("```bash", "npx git-will draft --yes", "```");
  lines.push("");
  return lines.join("\n");
}

/**
 * Draft a WILL.md interactively. Returns the full markdown string.
 * opts: { repoName, analysis, answers?: {...} } — answers can pre-fill.
 */
async function draftWill(opts) {
  const { analysis } = opts;
  const repoName = opts.repoName || path.basename(process.cwd());
  const a = opts.answers || {};

  const prompter = createPrompter();
  const answers = { ...a };

  try {
    await prompter.ready(); // drain piped stdin before asking anything
    if (!opts.skipPrompts) {
      if (!answers.maintainer) {
        const top = analysis.authors[0];
        answers.maintainer = await prompter.ask(
          `▸ Who's the main maintainer? [${top ? top.name : "you"}] `
        ) || (top ? top.name : "you");
      }
      if (!answers.backup) {
        answers.backup = await prompter.ask("▸ Who's the backup (the person who'd take over)? [] ");
      }
      if (!answers.keys) {
        answers.keys = await prompter.ask(
          "▸ Who gets the keys (repo access, npm/pypi publish, domain, CI)? [] "
        );
      }
      if (!answers.wishes) {
        console.log("\n  (Empty line to skip — e.g. 'archived as-is', 'fork continues', 'hand to X')");
        answers.wishes = await prompter.ask("▸ Your wishes if you can't maintain this anymore? [] ");
      }
      if (!answers.notes) {
        answers.notes = await prompter.ask("▸ Anything future maintainers should know? [] ");
      }
      if (!answers.blessed) {
        const defYes = analysis.dangerFiles.length > 0;
        answers.blessed = await prompter.askYesNo("▸ Are there files ONLY you understand right now?", defYes);
      }
    }
  } finally {
    prompter.close();
  }

  const lonely = analysis.lonelyFiles;
  const topAuthor = analysis.authors[0] ? analysis.authors[0].name : "unknown";

  const md = [
    "# WILL.md — succession plan for " + repoName,
    "",
    "> **If the maintainer disappears tomorrow, this document tells you what to do.**",
    "> Written " + new Date().toISOString().slice(0, 10) + " — regenerate with `npx git-will draft`.",
    "",
    "## The short version",
    "",
    `- **Maintainer:** ${answers.maintainer}`,
    `- **Backup / successor:** ${answers.backup || "_none named — this is the gap_"}`,
    `- **Keys go to:** ${answers.keys || "_not specified_"}`,
    `- **Wishes:** ${answers.wishes || "_not specified_"}`,
    `- **Single-owner files today:** ${typeof answers.blessed === "boolean" ? (answers.blessed ? "yes — see below" : "no") : "_unknown_"}`,
    "",
    "> ⚠️ **Never commit real secrets here.** Write names of people and systems, not tokens, passwords, or API keys.",
    "",
    "## Ownership snapshot (from git history)",
    "",
    "Analyzed with `git-will scan` on " + new Date().toISOString().slice(0, 10) + ".",
    "",
    "| Author | Lines |",
    "|--------|------:|",
    ...analysis.authors.slice(0, 6).map((x) => `| ${x.name} | ${x.lines} |`),
    "",
    lonely.length > 0
      ? `**Bus factor alert:** ${lonely.length} file${lonely.length === 1 ? "" : "s"} are single-owner ("${topAuthor}" understands them alone).`
      : "**Bus factor:** healthy — no single-owner files detected.",
    "",
    "### Files only one person understands",
    "",
    ...(lonely.length > 0
      ? lonely.slice(0, 10).map((f) => `- \`${f.file}\` — ${Math.round(f.topShare * 100)}% by ${f.topAuthor}`)
      : ["_None detected._"]),
    "",
    "## Succession plan",
    "",
    "### If I can't maintain this anymore",
    "",
    answers.wishes
      ? `1. **Wishes:** ${answers.wishes}`
      : "1. **Wishes:** _not written — the document is incomplete without them_",
    answers.backup
      ? `2. **Hand off to:** ${answers.backup}`
      : `2. **Hand off to:** _name someone — the repo has ${analysis.authors.length} active author(s); it is on you_`,
    answers.keys
      ? `3. **Keys:** ${answers.keys}`
      : "3. **Keys:** _CI secrets, publish tokens, domains — write them down somewhere safe (names only in this file)_",
    "",
    "### First 48 hours for the successor",
    "",
    "1. Read the knowledge map below — those files are the core.",
    "2. Run `npx git-will scan` yourself to see the current state.",
    "3. Open a PR within a week — even a docs fix — to confirm you have access.",
    "4. If you're taking over an archived repo: announce the fork, move fast, tag the old maintainer.",
    "",
    "## Notes for the future",
    "",
    answers.notes || "_nothing recorded — add context if you want the handoff to be smooth_",
    "",
    "---",
    "",
    aiHandoffSection(analysis),
    "",
    "---",
    "",
    "_Generated by [git-will](https://github.com/waxhy/git-will). Fix the bus factor before the bus does._",
  ].join("\n");

  return md;
}

module.exports = { draftWill, aiHandoffSection };
