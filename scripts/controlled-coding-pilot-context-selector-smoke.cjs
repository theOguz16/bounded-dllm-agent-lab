#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const {
  resolveContextSelections,
  validateContextSelections
} = require("./controlled-coding-pilot-context-selector.cjs");

const PROVIDER_SENSITIVE_LINE = [
  /bearer\s+[A-Za-z0-9._~+/-]+=*/i,
  /authorization\s*:\s*[^\n]+/i,
  /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*[^\s,;]+/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /https?:\/\/[^/\s:@]+:[^/\s@]+@/i
];

function providerSafeContent(content) {
  return content.split("\n").map((line, index) =>
    PROVIDER_SENSITIVE_LINE.some((pattern) => pattern.test(line))
      ? `/* PILOT_REDACTED_LINE_${index} */`
      : line
  ).join("\n");
}

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

const canonicalDefinitions = [
  "pilots/controlled-real-coding-v2/worker-request-id-correlation/task.json",
  "pilots/controlled-real-coding-v2/local-json-schema-error-classification/task.json"
];

for (const definitionPath of canonicalDefinitions) {
  const definition = JSON.parse(readFileSync(join(process.cwd(), definitionPath), "utf8"));
  assert.equal(
    definition.contextSelections.flatMap((entry) => entry.selectors)
      .some((selector) => selector.kind === "lines"),
    false,
    `${definition.pilotId} should prefer semantic selectors`
  );
  validateContextSelections(definition.contextSelections, {
    requiredPaths: definition.allowedMutationPaths,
    allowedReadRoots: definition.allowedReadRoots
  });

  const rawFiles = [];
  const maskedFiles = [];
  for (const entry of definition.contextSelections) {
    const content = readFileSync(join(process.cwd(), entry.path), "utf8");
    rawFiles.push({
      path: entry.path,
      content,
      contentHash: "sha256:canonical-selector-fixture",
      authority: "change_allowed",
      relatedSymbols: []
    });
    maskedFiles.push({
      path: entry.path,
      content: providerSafeContent(content),
      contentHash: "sha256:canonical-masked-fixture",
      authority: "change_allowed",
      relatedSymbols: []
    });

    for (const selector of entry.selectors) {
      assert.doesNotThrow(
        () => resolveContextSelections([rawFiles.at(-1)], [{
          path: entry.path,
          selectors: [selector]
        }]),
        `${definition.pilotId} raw ${entry.path} ${JSON.stringify(selector)}`
      );
      assert.doesNotThrow(
        () => resolveContextSelections([maskedFiles.at(-1)], [{
          path: entry.path,
          selectors: [selector]
        }]),
        `${definition.pilotId} masked ${entry.path} ${JSON.stringify(selector)}`
      );
    }
  }

  const providerSafe = resolveContextSelections(maskedFiles, definition.contextSelections, {
    selectionFiles: rawFiles
  });
  assert.equal(providerSafe.length, definition.allowedMutationPaths.length);
  assert.equal(
    providerSafe.every((file) => file.excerpts.every((excerpt) =>
      !PROVIDER_SENSITIVE_LINE.some((pattern) => pattern.test(excerpt.content))
    )),
    true
  );
}

process.stdout.write("controlled coding pilot context selector smoke: PASS\n");
