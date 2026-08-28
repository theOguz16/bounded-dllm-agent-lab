#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  resolveContextSelections,
  validateContextSelections
} = require("./controlled-coding-pilot-context-selector.cjs");

const futurePath = "packages/future-pilot/src/third-task.ts";
const futureContent = [
  "export const unrelated = 0;",
  "",
  "export function futureSelectorTarget() {",
  "  const semanticValue = 1;",
  "  return semanticValue;",
  "}",
  "",
  "// FUTURE_FIXTURE_START",
  "const futureFixture = true;",
  "// FUTURE_FIXTURE_END",
  "",
  "export const trailing = 2;"
].join("\n");

const futureSelections = [{
  path: futurePath,
  selectors: [
    { kind: "symbol", name: "futureSelectorTarget" },
    {
      kind: "anchor",
      start: "// FUTURE_FIXTURE_START",
      end: "// FUTURE_FIXTURE_END"
    }
  ]
}];

assert.doesNotThrow(() => validateContextSelections(futureSelections, {
  requiredPaths: [futurePath],
  allowedReadRoots: [futurePath]
}));

const [resolved] = resolveContextSelections([{
  path: futurePath,
  content: futureContent,
  contentHash: "sha256:synthetic-third-pilot",
  authority: "change_allowed",
  relatedSymbols: ["symbol:future-pilot"]
}], futureSelections);

assert.equal(resolved.path, futurePath);
assert.equal(resolved.excerpts.length, 2);
assert.equal(
  resolved.excerpts.some((excerpt) =>
    excerpt.content.includes("export function futureSelectorTarget()") &&
    excerpt.content.includes("return semanticValue;")
  ),
  true
);
assert.equal(
  resolved.excerpts.some((excerpt) =>
    excerpt.content.includes("// FUTURE_FIXTURE_START") &&
    excerpt.content.includes("// FUTURE_FIXTURE_END")
  ),
  true
);
assert.equal(
  resolved.excerpts.some((excerpt) => excerpt.content.includes("export const trailing = 2;")),
  false
);
assert.equal(
  resolved.excerpts.every((excerpt) =>
    excerpt.trustBoundary === "UNTRUSTED_REPOSITORY_DATA"
  ),
  true
);

const explicit = resolveContextSelections([{
  path: futurePath,
  content: futureContent,
  contentHash: "sha256:synthetic-third-pilot",
  authority: "change_allowed",
  relatedSymbols: []
}], [{
  path: futurePath,
  selectors: [{ kind: "lines", startLine: 1, endLine: 1 }]
}]);
assert.equal(explicit[0].excerpts[0].content, "export const unrelated = 0;");

for (const invalidSelections of [
  [{ path: futurePath, selectors: [{ kind: "symbol", name: "missingSymbol" }] }],
  [{
    path: futurePath,
    selectors: [{ kind: "anchor", start: "const", end: "// FUTURE_FIXTURE_END" }]
  }],
  [{ path: futurePath, selectors: [{ kind: "lines", startLine: 1, endLine: 999 }] }]
]) {
  assert.throws(
    () => resolveContextSelections([{
      path: futurePath,
      content: futureContent,
      contentHash: "sha256:synthetic-third-pilot",
      authority: "change_allowed",
      relatedSymbols: []
    }], invalidSelections),
    (error) => error?.pilotCode === "PILOT_DEFINITION_INVALID"
  );
}

process.stdout.write("controlled coding pilot context selector smoke: PASS\n");
