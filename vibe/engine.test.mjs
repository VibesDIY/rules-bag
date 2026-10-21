import { test } from "node:test";
import assert from "node:assert/strict";
import { addedLines, reviewFiles, codeOnly, normalizeConfig, summarize, reviewComments, globToRegExp, authorInScope } from "./engine.js";

function patchOf(lines, start = 1) {
  return [`@@ -0,0 +${start},${lines.length} @@`, ...lines.map((l) => "+" + l)].join("\n");
}
function rulesFor(lines, { filename = "src/a.ts", config, status = "modified" } = {}) {
  return reviewFiles([{ filename, status, patch: patchOf(lines) }], config).findings.map((f) => f.rule);
}

test("addedLines tracks new-file line numbers across context and removals", () => {
  const patch = ["@@ -10,4 +10,5 @@", " ctx", "-gone", "+new1", "+new2", " ctx2", "\\ No newline at end of file"].join("\n");
  assert.deepEqual(addedLines(patch), [
    { line: 11, text: "new1" },
    { line: 12, text: "new2" },
  ]);
});

test("codeOnly blanks strings and comments", () => {
  const s = { inBlock: false };
  assert.equal(/try/.test(codeOnly(`const a = "try { }"; // try {`, s)), false);
  assert.equal(codeOnly("/* start", s).trim(), "");
  assert.equal(s.inBlock, true);
  assert.match(codeOnly("end */ try {", s), /try \{/);
});

test("result segment", () => {
  assert.deepEqual(rulesFor(["try {", "  x();", "} catch (e) {}"]), ["no-try-catch"]);
  assert.deepEqual(rulesFor(['throw new Error("x");']), ["no-throw"]);
  assert.deepEqual(rulesFor(['throw new Error("x");'], { filename: "src/a.test.ts" }), []);
  assert.deepEqual(rulesFor(["const r = exception2Result(() => x());"]), []);
});

test("cement segment", () => {
  assert.deepEqual(rulesFor(["const u = new URL(s);"]), ["uri-not-url"]);
  assert.deepEqual(rulesFor(["const e = new TextEncoder();"]), ["txt-not-textencoder"]);
  assert.deepEqual(rulesFor(["  static instance: Foo;"]), ["no-singleton"]);
});

test("types segment", () => {
  assert.deepEqual(rulesFor(["function f(x: any) {}"]), ["no-any"]);
  assert.deepEqual(rulesFor(["const y = (x as unknown) as Foo;"]), ["avoid-cast"]);
  assert.deepEqual(rulesFor(["const y = [1, 2] as const;"]), []);
  assert.deepEqual(rulesFor(['import * as fs from "node:fs";']), []);
  assert.deepEqual(rulesFor(["const v = JSON.parse(s);"]), ["json-parse-validate"]);
  assert.deepEqual(rulesFor(["const v = Shape(JSON.parse(s));"]), ["json-parse-validate"]);
  assert.deepEqual(rulesFor(["const v = type({ a: 'string' })(JSON.parse(s));"]), []);
  assert.deepEqual(rulesFor(["const a = 1;"], { filename: "src/new.js", status: "added" }), ["typescript-only"]);
  assert.deepEqual(rulesFor(["const a: any = 1;"], { filename: "src/new.js" }), []); // tsOnly
});

test("modules segment", () => {
  assert.deepEqual(rulesFor(["export default function App() {}"]), ["no-export-default"]);
  assert.deepEqual(rulesFor(['import React from "react";']), ["no-default-import"]);
  assert.deepEqual(rulesFor(['import { useState } from "react";']), []);
  assert.deepEqual(rulesFor(['import type Foo from "./foo";']), []);
});

test("falsy segment", () => {
  assert.deepEqual(rulesFor(["if (!user) return;"]), ["no-falsy-if"]);
  assert.deepEqual(rulesFor(["if (!r.isOk()) return;"]), ["no-falsy-if"]);
  assert.deepEqual(rulesFor(["if (x === undefined) return;"]), []);
  assert.deepEqual(rulesFor(["if (a !== b) return;"]), []);
});

test("testing, style, fetch segments", () => {
  assert.deepEqual(rulesFor(['vi.mock("./db");'], { filename: "src/a.test.ts" }), ["no-module-mock"]);
  assert.deepEqual(rulesFor(["const add = (a, b) => a + b;"]), ["function-declaration"]);
  assert.deepEqual(rulesFor(["xs.map((x) => x + 1);"]), []);
  assert.deepEqual(rulesFor(["function f(a, b, c, d) {}"]), ["max-three-params"]);
  assert.deepEqual(rulesFor(["function f(a, b, c) {}"]), []);
  assert.deepEqual(rulesFor(["const p = new Proxy(t, h);"]), ["no-proxy"]);
  assert.deepEqual(rulesFor(["  constructor(private db: Db) {}"]), ["no-param-properties"]);
  assert.deepEqual(rulesFor(["const f = deps.fetch ?? fetch;"]), ["bound-fetch"]);
  assert.deepEqual(rulesFor(["const f = deps.fetch ?? fetch.bind(globalThis);"]), []);
});

test("segments can be turned off, and levels carry through", () => {
  assert.deepEqual(rulesFor(["try {"], { config: { segments: { result: "off" } } }), []);
  const { findings } = reviewFiles([{ filename: "a.ts", patch: patchOf(["try {"]) }], { segments: { result: "note" } });
  assert.equal(findings[0].level, "note");
});

test("rules-bag-allow turns a finding into an exception request", () => {
  const r = reviewFiles(
    [{ filename: "a.ts", patch: patchOf(["// rules-bag-allow: no-try-catch the SDK throws", "try {"]) }],
    undefined
  );
  assert.equal(r.findings.length, 0);
  assert.deepEqual(r.exceptions, [{ path: "a.ts", line: 2, rule: "no-try-catch", segment: "result", reason: "the SDK throws" }]);
});

test("ignore globs and non-code files are skipped", () => {
  assert.deepEqual(rulesFor(["try {"], { filename: "dist/a.ts" }), []);
  assert.deepEqual(rulesFor(["try {"], { filename: "README.md" }), []);
  assert.equal(globToRegExp("**/*.d.ts").test("src/x/y.d.ts"), true);
  assert.equal(globToRegExp("**/*.d.ts").test("y.d.ts"), true);
});

test("normalizeConfig rejects junk", () => {
  const c = normalizeConfig({ segments: { result: "nope", cement: "off" }, ai: "yes", ignore: [1, "x/**"] });
  assert.equal(c.segments.result, "block");
  assert.equal(c.segments.cement, "off");
  assert.equal(c.ai, false);
  assert.deepEqual(c.ignore, ["x/**"]);
});

test("summary picks REQUEST_CHANGES only for blocking findings", () => {
  const { findings, exceptions } = reviewFiles([{ filename: "a.ts", patch: patchOf(["try {", "if (!x) {}"]) }]);
  const s = summarize({ findings, exceptions, sha: "abcdef123456", repo: "o/r", appUrl: "https://x" });
  assert.equal(s.event, "REQUEST_CHANGES");
  assert.match(s.body, /2 findings, 1 blocking/);
  const c = reviewComments(findings);
  assert.equal(c.length, 2);
  assert.equal(c[0].side, "RIGHT");
  const clean = summarize({ findings: [], exceptions: [], sha: "abcdef1", repo: "o/r", appUrl: "https://x" });
  assert.equal(clean.event, "COMMENT");
  assert.match(clean.body, /clean/);
  assert.match(clean.body, /\[Rules Bag Reviewer\]\(https:\/\/x\?utm_source=github&utm_medium=review&utm_campaign=rules-bag-reviewer\)/);
});

test("who defaults to team and authorInScope reads author_association", () => {
  assert.equal(normalizeConfig({}).who, "team");
  assert.equal(normalizeConfig({ who: "anyone" }).who, "anyone");
  assert.equal(normalizeConfig({ who: "everyone!" }).who, "team");
  assert.equal(authorInScope("OWNER", "team"), true);
  assert.equal(authorInScope("CONTRIBUTOR", "team"), false);
  assert.equal(authorInScope("NONE", "anyone"), true);
});
