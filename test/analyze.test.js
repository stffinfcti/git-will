"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  analyze,
  normalizeAuthor,
  stripMailAngles,
  estimateRepoBusFactor,
} = require("../src/analyze");
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
  const env = { ...process.env, ...(opts.env || {}) };
  if (opts.env && Object.prototype.hasOwnProperty.call(opts.env, "NO_COLOR") === false) {
    /* keep inherited */
  }
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env,
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
  const alpha = result.lonelyFiles.find((f) => f.file === "alpha.js");
  assert.ok(alpha, "alpha.js is a bus-factor file");
  assert.strictEqual(alpha.topAuthor, "bob", "bob owns alpha.js outright");
  const beta = result.lonelyFiles.find((f) => f.file === "beta.js");
  assert.ok(beta, "beta.js single-owner");
  assert.strictEqual(beta.topAuthor, "bob");
  assert.ok(result.totals.files >= 3, "three tracked files analyzed");
  const gamma = result.lonelyFiles.find((f) => f.file === "gamma.js");
  assert.ok(gamma, "gamma.js single-owner");
  assert.strictEqual(gamma.topAuthor, "alice");
  assert.strictEqual(result.busFactorFiles, undefined);
  assert.ok(Array.isArray(result.lonelyFiles));
  assert.ok(result.dangerFiles.length >= 1);
  assert.ok(result.dangerFiles.every((f) => f.topShare >= 0.85));
  assert.strictEqual(result.meta.mode, "blame");
  assert.ok(typeof result.repoBusFactor === "number");
  assert.ok(result.repoBusFactor >= 1);
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
  const bare = runCli([], { cwd: empty, env: { NO_COLOR: "1" } });
  assert.strictEqual(bare.status, 0);
  assert.match(bare.stdout, /Usage:/);
  assert.doesNotMatch(bare.stderr, /no commits to analyze/);

  const unknown = runCli(["definitely-not-a-command"], { cwd: empty, env: { NO_COLOR: "1" } });
  assert.notStrictEqual(unknown.status, 0);
  assert.match(unknown.stdout, /Usage:/);
  assert.doesNotMatch(unknown.stderr, /no commits to analyze/);
});

test("draft --yes refuses to overwrite existing WILL.md without --force", async () => {
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

test("draft --yes --force overwrites after backing up WILL.md", async () => {
  const dir = makeFixtureRepo();
  const willPath = path.join(dir, "WILL.md");
  fs.writeFileSync(willPath, "# existing will\n", "utf8");
  const cli = runCli(["draft", "--yes", "--force"], { cwd: dir, env: { NO_COLOR: "1" } });
  assert.strictEqual(cli.status, 0, cli.stderr);
  assert.ok(fs.existsSync(willPath + ".bak"));
  assert.strictEqual(fs.readFileSync(willPath + ".bak", "utf8"), "# existing will\n");
  const md = fs.readFileSync(willPath, "utf8");
  assert.match(md, /# WILL\.md/);
  // blessed default fixed: lonely files exist → yes
  assert.match(md, /Single-owner files today:\*\* yes/);
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
  assert.match(md, /Single-owner files today:\*\* yes/);
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
  for (const f of result.lonelyFiles.slice(0, 10)) {
    assert.match(md, new RegExp(`${f.file}.*${f.topAuthor}`));
  }
});

test("piped stdout has no ANSI color; NO_COLOR and TERM=dumb disable color", () => {
  const dir = makeFixtureRepo();
  const baseEnv = { ...process.env, TERM: "xterm-256color" };
  delete baseEnv.NO_COLOR;

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

test("mailmap merges identities during blame analysis", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-will-mailmap-"));
  const run = (args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  run(["init", "-q"]);
  run(["config", "user.name", "Alice Personal"]);
  run(["config", "user.email", "alice@personal.com"]);
  fs.writeFileSync(path.join(dir, "app.js"), "line1\nline2\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "personal"]);
  run(["config", "user.name", "Alice Work"]);
  run(["config", "user.email", "alice@work.com"]);
  fs.appendFileSync(path.join(dir, "app.js"), "line3\nline4\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "work"]);
  fs.writeFileSync(
    path.join(dir, ".mailmap"),
    "Alice Canonical <alice@canonical.com> <alice@personal.com>\n" +
      "Alice Canonical <alice@canonical.com> <alice@work.com>\n"
  );

  const result = await analyze(dir);
  const names = result.authors.map((a) => a.name);
  assert.ok(
    names.some((n) => n.includes("alice")),
    "alice identity present: " + names.join(",")
  );
  // With mailmap, both emails should collapse toward one canonical identity
  assert.ok(result.authors.length === 1, "expected one author after mailmap, got " + names.join(","));
});

test("analyze --fast mode returns numstat ownership", async () => {
  const dir = makeFixtureRepo();
  const result = await analyze(dir, { mode: "fast" });
  assert.strictEqual(result.meta.mode, "fast");
  assert.ok(result.authors.length >= 1);
  assert.ok(result.totals.files >= 1);
  assert.ok(typeof result.repoBusFactor === "number");

  const cli = runCli(["scan", "--fast", "--json"], { cwd: dir, env: { NO_COLOR: "1" } });
  assert.strictEqual(cli.status, 0, cli.stderr);
  const json = JSON.parse(cli.stdout);
  assert.strictEqual(json.meta.mode, "fast");
});

test("--dir analyzes a repo without cd", () => {
  const dir = makeFixtureRepo();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "git-will-elsewhere-"));
  const cli = runCli(["scan", "--json", "--dir", dir], { cwd: elsewhere, env: { NO_COLOR: "1" } });
  assert.strictEqual(cli.status, 0, cli.stderr);
  const json = JSON.parse(cli.stdout);
  assert.ok(json.authors.length >= 2);
});

test("estimateRepoBusFactor greedy removal heuristic", () => {
  const analysis = {
    a: { topAuthor: "alice", topShare: 1, busFactor: 1, total: 10 },
    b: { topAuthor: "alice", topShare: 1, busFactor: 1, total: 10 },
    c: { topAuthor: "bob", topShare: 1, busFactor: 1, total: 10 },
  };
  // Removing alice drops 2/3 owned files → remaining 1/3 ≤ 50% → bus factor 1
  assert.strictEqual(estimateRepoBusFactor(analysis), 1);
  assert.strictEqual(estimateRepoBusFactor({}), 0);
});

test("paper is alias of scan --json", () => {
  const dir = makeFixtureRepo();
  const paper = runCli(["paper"], { cwd: dir, env: { NO_COLOR: "1" } });
  const json = runCli(["scan", "--json"], { cwd: dir, env: { NO_COLOR: "1" } });
  assert.strictEqual(paper.status, 0, paper.stderr);
  assert.strictEqual(json.status, 0, json.stderr);
  const a = JSON.parse(paper.stdout);
  const b = JSON.parse(json.stdout);
  assert.strictEqual(a.schema, "git-will@1");
  assert.deepStrictEqual(a.authors, b.authors);
  assert.deepStrictEqual(a.lonelyFiles, b.lonelyFiles);
});
