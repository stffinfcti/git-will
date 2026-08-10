"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { analyze, normalizeAuthor } = require("../src/analyze");

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

test("normalizeAuthor merges github noreply identities", () => {
  assert.strictEqual(normalizeAuthor("", "12345+octocat@users.noreply.github.com"), "octocat");
  assert.strictEqual(normalizeAuthor("", "octocat@users.noreply.github.com"), "octocat");
  assert.strictEqual(normalizeAuthor("Real Name", "real@example.com"), "Real Name");
  assert.strictEqual(normalizeAuthor("", "someone@example.com"), "someone");
});

test("analyze detects authors and ownership on fixture repo", () => {
  const dir = makeFixtureRepo();
  const result = analyze(dir);
  assert.ok(result.authors.length >= 2, "should see at least Alice and Bob");
  const names = result.authors.map((a) => a.name);
  assert.ok(names.includes("Alice"), "Alice present");
  assert.ok(names.includes("Bob"), "Bob present");
  // alpha.js is 5 lines, all rewritten by Bob — bus factor 1, topAuthor Bob
  const alpha = result.lonelyFiles.find((f) => f.file === "alpha.js");
  assert.ok(alpha, "alpha.js is a bus-factor file");
  assert.strictEqual(alpha.topAuthor, "Bob", "Bob owns alpha.js outright");
  // beta.js is 100% Bob -> single owner
  const beta = result.lonelyFiles.find((f) => f.file === "beta.js");
  assert.ok(beta, "beta.js single-owner");
  assert.strictEqual(beta.topAuthor, "Bob");
  assert.ok(result.totals.files >= 3, "three tracked files analyzed");
  // gamma.js stays 100% Alice -> her ownership survives
  const gamma = result.lonelyFiles.find((f) => f.file === "gamma.js");
  assert.ok(gamma, "gamma.js single-owner");
  assert.strictEqual(gamma.topAuthor, "Alice");
});

test("analyze throws on non-repo directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-will-norepo-"));
  assert.throws(() => analyze(dir), /not a git repository/);
});
