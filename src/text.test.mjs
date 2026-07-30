import test from "node:test";
import assert from "node:assert/strict";

import { bounded, splitList, splitLines, parseBoolean, parsePositiveInteger } from "./text.mjs";
import { recommendationFrom } from "./verdict.mjs";
import { parseChangedFiles, boundValidations } from "./evidence.mjs";

test("bounded keeps short text untouched", () => {
  assert.equal(bounded("hello", 100), "hello");
});

test("bounded keeps both ends of long text", () => {
  const text = `START${"x".repeat(5000)}END`;
  const result = bounded(text, 200);

  assert.ok(result.length <= 200);
  assert.ok(result.startsWith("START"), "the head must survive");
  assert.ok(result.endsWith("END"), "the tail must survive; failures live there");
  assert.ok(result.includes("truncated"));
});

test("splitList and splitLines handle separators and blanks", () => {
  assert.deepEqual(splitList(" a , b \n c ,, "), ["a", "b", "c"]);
  assert.deepEqual(splitLines("npm ci\n\n  go test ./...  "), ["npm ci", "go test ./..."]);
  assert.deepEqual(splitLines('npm test -- --grep "a,b"'), ['npm test -- --grep "a,b"']);
  assert.deepEqual(splitList(undefined), []);
});

test("parseBoolean accepts known words and rejects nonsense", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(parseBoolean(value), true, value);
  }
  for (const value of ["0", "false", "no", "off"]) {
    assert.equal(parseBoolean(value), false, value);
  }
  assert.equal(parseBoolean("", true), true, "unset falls back");
  assert.equal(parseBoolean(undefined, false), false);
  assert.throws(() => parseBoolean("maybe"), /boolean/);
});

test("parsePositiveInteger rejects zero and negatives", () => {
  assert.equal(parsePositiveInteger("40", 10), 40);
  assert.equal(parsePositiveInteger("", 10), 10);
  assert.throws(() => parsePositiveInteger("0", 10), /positive integer/);
  assert.throws(() => parsePositiveInteger("-5", 10), /positive integer/);
  assert.throws(() => parsePositiveInteger("abc", 10), /positive integer/);
});

test("recommendationFrom reads the verdict in several shapes", () => {
  assert.equal(recommendationFrom("Verdict: merge"), "merge");
  assert.equal(recommendationFrom("## Verdict: hold\nmore"), "hold");
  assert.equal(recommendationFrom("**Verdict**: reject"), "reject");
  assert.equal(recommendationFrom("intro\n\n  verdict:  MERGE  "), "merge");
});

test("recommendationFrom returns unknown when absent or unparseable", () => {
  assert.equal(recommendationFrom("no verdict here"), "unknown");
  assert.equal(recommendationFrom("Verdict: maybe"), "unknown");
  assert.equal(recommendationFrom(""), "unknown");
  assert.equal(recommendationFrom(undefined), "unknown");
});

test("parseChangedFiles ignores blank lines", () => {
  assert.deepEqual(parseChangedFiles("a.js\n\nb/c.go\n"), ["a.js", "b/c.go"]);
  assert.deepEqual(parseChangedFiles(""), []);
});

test("boundValidations shares the budget across commands", () => {
  const validations = Array.from({ length: 4 }, (_, i) => ({
    command: `cmd-${i}`,
    exitCode: i === 0 ? 0 : 1,
    output: "y".repeat(200_000),
  }));

  const bounded_ = boundValidations(validations);
  const total = bounded_.reduce((sum, entry) => sum + entry.output.length, 0);

  assert.ok(total <= 120_000, `combined output should stay bounded, got ${total}`);
  assert.equal(bounded_[0].succeeded, true);
  assert.equal(bounded_[1].succeeded, false);
});
