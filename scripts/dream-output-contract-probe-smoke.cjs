const assert = require("assert");
const {
  firstBalancedJsonObject,
  normalizeDecision,
  parseDecision,
  summarize,
  toMarkdown
} = require("./dream-output-contract-probe.cjs");

const plain = parseDecision('{"decision":"approve","reasoning":"ok","confidence":1}');
assert.equal(plain.jsonCompliant, true);
assert.equal(plain.decision, "approve");
assert.equal(plain.decisionSource, "json");

const embedded = parseDecision('To evaluate this change, I would return {"decision":"needs_review","reasoning":"risk","confidence":0.5}');
assert.equal(embedded.jsonCompliant, true);
assert.equal(embedded.decision, "needs_review");

const invalid = parseDecision("To evaluate this change, I need more context.");
assert.equal(invalid.jsonCompliant, false);
assert.equal(invalid.decision, null);
assert.equal(invalid.decisionSource, "unparseable");

assert.equal(normalizeDecision("needs review"), "needs_review");
assert.equal(normalizeDecision("needs-review"), "needs_review");
assert.equal(normalizeDecision("reject"), "reject");
assert.equal(normalizeDecision("bad"), null);

assert.equal(
  firstBalancedJsonObject('x {"decision":"approve","reasoning":"ok { nested text }","confidence":1} y'),
  '{"decision":"approve","reasoning":"ok { nested text }","confidence":1}'
);

const results = [
  {
    id: "direct-json-smoke",
    status: "completed",
    expected: ["approve"],
    decision: "approve",
    expectedMatched: true,
    jsonCompliant: true,
    decisionSource: "json",
    parseError: null,
    latencyMs: 100,
    promptTokens: 10,
    completionTokens: 20,
    totalTokens: 30,
    outputPreview: '{"decision":"approve","reasoning":"ok","confidence":1}'
  },
  {
    id: "compact-risky-secret",
    status: "completed",
    expected: ["reject"],
    decision: null,
    expectedMatched: false,
    jsonCompliant: false,
    decisionSource: "unparseable",
    parseError: "No balanced JSON object found",
    latencyMs: 200,
    promptTokens: 11,
    completionTokens: 21,
    totalTokens: 32,
    outputPreview: "To evaluate this change..."
  }
];

const summary = summarize(results);
assert.equal(summary.resultCount, 2);
assert.equal(summary.completedCount, 2);
assert.equal(summary.jsonComplianceCount, 1);
assert.equal(summary.expectedMatchedCount, 1);
assert.equal(summary.decisionCounts.approve, 1);
assert.equal(summary.decisionCounts.unknown, 1);
assert.equal(summary.averageLatencyMs, 150);
assert.equal(summary.averageTotalTokens, 31);

const markdown = toMarkdown({
  createdAt: "2026-07-07T00:00:00.000Z",
  summary,
  results
});

assert.ok(markdown.includes("Dream Output Contract Probe"));
assert.ok(markdown.includes("direct-json-smoke"));
assert.ok(markdown.includes("compact-risky-secret"));

console.log("dream-output-contract-probe smoke passed");
