"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { analyze, normalizeAuthor, stripMailAngles } = require("../src/analyze");
const { draftWill } = require("../src/will");

const BIN = path.join(__dirname, "..", "bin", "git-will.js");

/** Create a throwaway git repo with controlled authorship. */
function makeFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-will-test-"));
  const run = (args, opts = {}) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
  run(["init", "-q"]);
  run(["config", "user.name", "Alice"]);
  run(["config", "user.email", "alice@example.com"]);
  fs.writeFileSync(path.join(dir, "alpha.js"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  fs.writeFileSync(path.join(dir, "gamma.js"), "module.exports = 'alice-only';\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "alpha"]);
  // Bob takes over alpha.js and adds beta.js
  run(["config", "user.name", "Bob"]);
  run(["config", "user.email", "bob@example.com"]);
  fs.writeFileSync(path.join(dir, "alpha.js"), "// bob rewrite\nconst a = 10;\nconst b = 20;\nconst c = 30;\n// bob edit\n");
  fs.writeFileSync(path.join(dir, "beta.js"), "module.exports = 42;\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "bob changes"]);
  return dir;
}

function makeEmptyRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-will-empty-"));
  execFileSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return dir;
}

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...(opts.env || {}) },
    cwd: opts.cwd || process.cwd(),
    input: opts.input,
  });
}

test("stripMailAngles removes porcelain brackets", () => {
  assert.strictEqual(stripMailAngles("<alice@example.com>"), "alice@example.com");
  assert.strictEqual(stripMailAngles("alice@example.com"), "alice@example.com");
  assert.strictEqual(stripMailAngles("  <x@y.z>  "), "x@y.z");
});

test("normalizeAuthor merges github noreply identities", () => {
  assert.strictEqual(normalizeAuthor("", "12345+octocat@users.noreply.github.com"), "octocat");
  assert.strictEqual(normalizeAuthor("", "octocat@users.noreply.github.com"), "octocat");
  assert.strictEqual(normalizeAuthor("Real Name", "real@example.com"), "real name");
  assert.strictEqual(normalizeAuthor("", "someone@example.com"), "someone");
});

test("normalizeAuthor strips <> and handles empty-name noreply", () => {
  assert.strictEqual(normalizeAuthor("", "<12345+octocat@users.noreply.github.com>"), "octocat");
  assert.strictEqual(normalizeAuthor("", "<octocat@users.noreply.github.com>"), "octocat");
  assert.strictEqual(normalizeAuthor("", "<someone@example.com>"), "someone");
  assert.notEqual(normalizeAuthor("", "<12345+octocat@users.noreply.github.com>"), "<12345+octocat");
});

test("normalizeAuthor casefolds display names for identity merge", () => {
  assert.strictEqual(normalizeAuthor("Alice Smith", "a@example.com"), normalizeAuthor("alice smith", "b@example.com"));
  assert.strictEqual(normalizeAuthor("Bob", "bob@example.com"), "bob");
});

test("analyze detects authors and ownership on fixture repo", async () => {
  const dir = makeFixtureRepo();
  const result = await analyze(dir);
  assert.ok(result.authors.length >= 2, "should see at least Alice and Bob");
  const names = result.authors.map((a) => a.name);
  assert.ok(names.includes("alice"), "alice present (casefolded)");
  assert.ok(names.includes("bob"), "bob present (casefolded)");
  // alpha.js is 5 lines, all rewritten by Bob — bus factor 1, topAuthor bob
  const alpha = result.lonelyFiles.find((f) => f.file === "alpha.js");
  assert.ok(alpha, "alpha.js is a bus-factor file");
  assert.strictEqual(alpha.topAuthor, "bob", "bob owns alpha.js outright");
  // beta.js is 100% Bob -> single owner
  const beta = result.lonelyFiles.find((f) => f.file === "beta.js");
  assert.ok(beta, "beta.js single-owner");
  assert.strictEqual(beta.topAuthor, "bob");
  assert.ok(result.totals.files >= 3, "three tracked files analyzed");
  // gamma.js stays 100% Alice -> her ownership survives
  const gamma = result.lonelyFiles.find((f) => f.file === "gamma.js");
  assert.ok(gamma, "gamma.js single-owner");
  assert.strictEqual(gamma.topAuthor, "alice");
  // Single field only — no duplicate busFactorFiles
  assert.strictEqual(result.busFactorFiles, undefined);
  assert.ok(Array.isArray(result.lonelyFiles));
  // Danger files: ≥ 85% share (all three fixture singles qualify)
  assert.ok(result.dangerFiles.length >= 1);
  assert.ok(result.dangerFiles.every((f) => f.topShare >= 0.85));
});

test("analyze throws on non-repo directory", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-will-norepo-"));
  await assert.rejects(() => analyze(dir), /not a git repository/);
});

test("analyze hard-errors on empty repo with no commits", async () => {
  const dir = makeEmptyRepo();
  await assert.rejects(() => analyze(dir), /no commits to analyze/);
  const cli = runCli(["scan"], { cwd: dir, env: { NO_COLOR: "1" } });
  assert.notStrictEqual(cli.status, 0);
  assert.match(cli.stderr, /no commits to analyze/);
  assert.doesNotMatch(cli.stdout + cli.stderr, /Healthy/);
});

test("bare git-will and unknown commands print usage without analyzing", () => {
  const empty = makeEmptyRepo();
  // Empty repo would throw if analyze ran — usage must succeed / not hit analyze
  const bare = runCli([], { cwd: empty, env: { NO_COLOR: "1" } });
  assert.strictEqual(bare.status, 0);
  assert.match(bare.stdout, /Usage:/);
  assert.doesNotMatch(bare.stderr, /no commits to analyze/);

  const unknown = runCli(["definitely-not-a-command"], { cwd: empty, env: { NO_COLOR: "1" } });
  assert.notStrictEqual(unknown.status, 0);
  assert.match(unknown.stdout, /Usage:/);
  assert.doesNotMatch(unknown.stderr, /no commits to analyze/);
});

test("draft --yes refuses to overwrite existing WILL.md", async () => {
  const dir = makeFixtureRepo();
  const willPath = path.join(dir, "WILL.md");
  fs.writeFileSync(willPath, "# existing will\n", "utf8");
  const before = fs.readFileSync(willPath, "utf8");
  const cli = runCli(["draft", "--yes"], { cwd: dir, env: { NO_COLOR: "1" } });
  assert.notStrictEqual(cli.status, 0);
  assert.match(cli.stderr, /WILL\.md already exists/);
  assert.strictEqual(fs.readFileSync(willPath, "utf8"), before);
  assert.ok(!fs.existsSync(willPath + ".bak"));
});

test("draft --yes writes WILL.md when absent", async () => {
  const dir = makeFixtureRepo();
  const willPath = path.join(dir, "WILL.md");
  assert.ok(!fs.existsSync(willPath));
  const cli = runCli(["draft", "--yes"], { cwd: dir, env: { NO_COLOR: "1" } });
  assert.strictEqual(cli.status, 0, cli.stderr);
  assert.ok(fs.existsSync(willPath));
  const md = fs.readFileSync(willPath, "utf8");
  assert.match(md, /# WILL\.md/);
  assert.match(md, /Bus factor/);
});

test("WILL.md bus-factor copy uses per-file owners and correct grammar", async () => {
  const dir = makeFixtureRepo();
  const result = await analyze(dir);
  const md = await draftWill({
    repoName: "fixture",
    analysis: result,
    answers: {
      maintainer: "alice",
      backup: "",
      keys: "",
      wishes: "",
      notes: "",
      blessed: true,
    },
    skipPrompts: true,
  });
  assert.doesNotMatch(md, /file are single-owner/);
  assert.doesNotMatch(md, /"alice" understands them alone/);
  if (result.lonelyFiles.length === 1) {
    assert.match(md, /1 file is single-owner/);
    assert.match(md, new RegExp(result.lonelyFiles[0].topAuthor));
  } else {
    assert.match(md, /\d+ files are single-owner/);
    assert.match(md, /see per-file owners below/);
  }
  // Per-file list still names each owner
  for (const f of result.lonelyFiles.slice(0, 10)) {
    assert.match(md, new RegExp(`${f.file}.*${f.topAuthor}`));
  }
});

test("piped stdout has no ANSI color; NO_COLOR and TERM=dumb disable color", () => {
  const dir = makeFixtureRepo();
  const baseEnv = { ...process.env, TERM: "xterm-256color" };
  delete baseEnv.NO_COLOR;

  // spawnSync pipes stdout → not a TTY → must be pipe-safe (no escapes)
  const piped = runCli(["scan"], { cwd: dir, env: baseEnv });
  assert.strictEqual(piped.status, 0, piped.stderr);
  assert.doesNotMatch(piped.stdout, /\x1b\[/);

  const help = runCli(["--help"], { cwd: dir, env: baseEnv });
  assert.strictEqual(help.status, 0);
  assert.doesNotMatch(help.stdout, /\x1b\[/);

  const noColor = runCli(["--help"], { cwd: dir, env: { ...baseEnv, NO_COLOR: "1" } });
  assert.doesNotMatch(noColor.stdout, /\x1b\[/);

  const dumb = runCli(["--help"], { cwd: dir, env: { ...baseEnv, TERM: "dumb" } });
  assert.doesNotMatch(dumb.stdout, /\x1b\[/);
});
