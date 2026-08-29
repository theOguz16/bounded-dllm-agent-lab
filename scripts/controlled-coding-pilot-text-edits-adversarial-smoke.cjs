#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  PILOT_MAX_TEXT_EDIT_BYTES,
  PILOT_MAX_TEXT_EDITS,
  TEXT_EDIT_OUTPUT_VERSION,
  materializeBoundedTextEdits
} = require("./controlled-pilot/text-edits.cjs");
const { hash } = require("./controlled-pilot/context.cjs");

function source(path, content, overrides = {}) {
  return {
    path,
    content,
    contentHash: hash(content),
    authority: "change_allowed",
    relatedSymbols: [`symbol:${path}`],
    ...overrides
  };
}

function fixture(files, options = {}) {
  const requiredMutationPaths = options.requiredMutationPaths ?? files.map((file) => file.path);
  const allowedMutationPaths = options.allowedMutationPaths ?? requiredMutationPaths;
  const profile = {
    allowedMutationPaths,
    requiredMutationPaths,
    maxChangedFiles: options.maxChangedFiles ?? Math.max(requiredMutationPaths.length, 1),
    maxPatchLines: 120,
    providerRequirements: []
  };
  const request = {
    instruction: JSON.stringify({
      existingPlan: {
        steps: [{ stepId: "step-1", targetPaths: requiredMutationPaths }]
      },
      workspaceFiles: files
    })
  };
  return { request, profile };
}

function output(edits, summary = "Adversarial bounded edit regression.") {
  return { schemaVersion: TEXT_EDIT_OUTPUT_VERSION, edits, summary };
}

function edit(file, oldText, newText, overrides = {}) {
  return {
    path: file.path,
    expectedContentHash: file.contentHash,
    oldText,
    newText,
    ...overrides
  };
}

function materialize(files, edits, options = {}) {
  const { request, profile } = fixture(files, options);
  return materializeBoundedTextEdits(request, output(edits), profile);
}

function mutation(result, path) {
  return result.output.mutations.find((item) => item.path === path);
}

function rejectsModel(files, edits, options = {}) {
  const { request, profile } = fixture(files, options);
  assert.throws(
    () => materializeBoundedTextEdits(request, output(edits), profile),
    (error) => error?.pilotCode === "PILOT_MODEL_RESPONSE_INVALID"
  );
}

function rejectsAuthority(files, edits, options = {}) {
  const { request, profile } = fixture(files, options);
  assert.throws(
    () => materializeBoundedTextEdits(request, output(edits), profile),
    (error) => error?.pilotCode === "PILOT_AUTHORITY_VIOLATION"
  );
}

// PASS 1: single edit.
{
  const a = source("a.ts", "A\n");
  const result = materialize([a], [edit(a, "A", "B")]);
  assert.equal(mutation(result, a.path).newContent, "B\n");
}

// PASS 2 + deterministic descending materialization: two non-overlapping edits, same file.
{
  const a = source("a.ts", "abcdefghi");
  const result = materialize([a], [edit(a, "bc", "XX"), edit(a, "gh", "Y")]);
  assert.equal(mutation(result, a.path).newContent, "aXXdefYi");
  assert.deepEqual(result.editCounts, { "a.ts": 2 });
}

// PASS 3: edits on two required files.
{
  const a = source("a.ts", "const a = 1;\n");
  const b = source("b.ts", "const b = 1;\n");
  const result = materialize([a, b], [edit(a, "a = 1", "a = 2"), edit(b, "b = 1", "b = 2")]);
  assert.equal(result.output.mutations.length, 2);
}

// PASS 4: Unicode old/new text.
{
  const a = source("a.ts", "const city = \"İstanbul 🚀\";\n");
  const result = materialize([a], [edit(a, "İstanbul 🚀", "İzmir ✨")]);
  assert.match(mutation(result, a.path).newContent, /İzmir ✨/u);
}

// PASS 5: CRLF source is preserved outside the exact replacement.
{
  const a = source("a.ts", "A\r\nB\r\nC\r\n");
  const result = materialize([a], [edit(a, "B", "BB")]);
  assert.equal(mutation(result, a.path).newContent, "A\r\nBB\r\nC\r\n");
}

// PASS 6: replacement changes text length without shifting another original-source span.
{
  const a = source("a.ts", "left middle right");
  const result = materialize([a], [edit(a, "left", "L"), edit(a, "right", "RIGHT-LONG")]);
  assert.equal(mutation(result, a.path).newContent, "L middle RIGHT-LONG");
}

// REJECT 7: oldText missing.
{
  const a = source("a.ts", "A");
  rejectsModel([a], [edit(a, "missing", "B")]);
}

// REJECT 8: oldText non-unique in original source.
{
  const a = source("a.ts", "same / same");
  rejectsModel([a], [edit(a, "same", "changed")]);
}

// REJECT 9: zero-op.
{
  const a = source("a.ts", "A");
  rejectsModel([a], [edit(a, "A", "A")]);
}

// REJECT 10: empty oldText.
{
  const a = source("a.ts", "A");
  rejectsModel([a], [edit(a, "", "B")]);
}

// REJECT 11: NUL in old/new text.
{
  const a = source("a.ts", "A\u0000B");
  rejectsModel([a], [edit(a, "A\u0000B", "C")]);
}

// REJECT 12: redacted placeholder.
{
  const a = source("a.ts", "PILOT_REDACTED_LINE_1");
  rejectsModel([a], [edit(a, "PILOT_REDACTED_LINE_1", "visible")]);
}

// REJECT 13: duplicate identical edit / same original span twice.
{
  const a = source("a.ts", "A");
  rejectsModel([a], [edit(a, "A", "B"), edit(a, "A", "B")]);
}

// REJECT 14: same original span with different replacements.
{
  const a = source("a.ts", "A");
  rejectsModel([a], [edit(a, "A", "B"), edit(a, "A", "C")]);
}

// REJECT 15: partially overlapping original spans.
{
  const a = source("a.ts", "abcdefghi");
  rejectsModel([a], [edit(a, "bcde", "X"), edit(a, "def", "Y")]);
}

// REJECT 16: one original span fully contains another.
{
  const a = source("a.ts", "abcdefghi");
  rejectsModel([a], [edit(a, "bcdefg", "X"), edit(a, "de", "Y")]);
}

// REJECT 17: generated-text chaining. B exists only because edit 1 would create it.
{
  const a = source("a.ts", "A");
  rejectsModel([a], [edit(a, "A", "B"), edit(a, "B", "C")]);
}

// REJECT 18: edit count exceeds protocol max.
{
  const text = Array.from({ length: PILOT_MAX_TEXT_EDITS + 1 }, (_, index) => `v${index}`).join("|");
  const a = source("a.ts", text);
  rejectsModel([a], Array.from({ length: PILOT_MAX_TEXT_EDITS + 1 }, (_, index) =>
    edit(a, `v${index}`, `x${index}`)
  ));
}

// REJECT 19: total UTF-8 old/new bytes exceed protocol max.
{
  const a = source("a.ts", "A");
  rejectsModel([a], [edit(a, "A", "X".repeat(PILOT_MAX_TEXT_EDIT_BYTES + 1))]);
}

// REJECT 20: required file missing from edits.
{
  const a = source("a.ts", "A");
  const b = source("b.ts", "B");
  rejectsModel([a, b], [edit(a, "A", "AA")]);
}

// REJECT model: malformed edit shape.
{
  const a = source("a.ts", "A");
  rejectsModel([a], [{ ...edit(a, "A", "B"), unexpected: true }]);
}

// REJECT authority 21: unauthorized path.
{
  const a = source("a.ts", "A");
  const outside = source("outside.ts", "O");
  rejectsAuthority([a, outside], [edit(outside, "O", "X")], {
    requiredMutationPaths: ["a.ts"], allowedMutationPaths: ["a.ts"]
  });
}

// REJECT authority 22: allowed but not required path.
{
  const a = source("a.ts", "A");
  const c = source("c.ts", "C");
  rejectsAuthority([a, c], [edit(c, "C", "X")], {
    requiredMutationPaths: ["a.ts"], allowedMutationPaths: ["a.ts", "c.ts"]
  });
}

// REJECT authority 23: stale expectedContentHash.
{
  const a = source("a.ts", "A");
  rejectsAuthority([a], [edit(a, "A", "B", { expectedContentHash: hash("stale") })]);
}

// REJECT authority 24: source authority is not change_allowed.
{
  const a = source("a.ts", "A", { authority: "read_only" });
  rejectsAuthority([a], [edit(a, "A", "B")]);
}

// REJECT authority 25: source missing.
{
  const a = source("a.ts", "A");
  const ghost = source("ghost.ts", "G");
  rejectsAuthority([a], [edit(ghost, "G", "X")], {
    requiredMutationPaths: ["ghost.ts"], allowedMutationPaths: ["ghost.ts"]
  });
}

// REJECT authority: supplied source content does not match its own contentHash.
{
  const a = source("a.ts", "A", { contentHash: hash("different") });
  rejectsAuthority([a], [edit(a, "A", "B", { expectedContentHash: a.contentHash })]);
}

process.stdout.write("controlled pilot bounded text-edit adversarial regression: PASS\n");
