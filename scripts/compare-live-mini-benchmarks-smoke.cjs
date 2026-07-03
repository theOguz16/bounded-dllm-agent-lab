const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-benchmark-comparison-smoke-"));
const outDir = path.join(tempDir, "out");
const reportA = path.join(tempDir, "o1.json");
const reportB = path.join(tempDir, "o3.json");

function writeReport(filePath, createdAt, qwen, dream) {
  fs.writeFileSync(filePath, JSON.stringify({
    ok: true,
    status: "completed",
    expectationsOk: false,
    createdAt,
    caseCount: 12,
    resultCount: 24,
    modelSummaries: [
      {
        kind: "llm",
        modelId: "qwen2.5-coder-7b",
        configured: true,
        resultCount: 12,
        completedCount: 12,
        failedCount: 0,
        expectedMatchedCount: qwen.expectedMatchedCount,
        expectedMatchRate: qwen.expectedMatchRate,
        jsonComplianceCount: qwen.jsonComplianceCount,
        jsonComplianceRate: qwen.jsonComplianceRate,
        averageLatencyMs: qwen.averageLatencyMs,
        averageTotalTokens: qwen.averageTotalTokens,
        decisionCounts: qwen.decisionCounts
      },
      {
        kind: "dllm",
        modelId: "dream-coder-v0-instruct-7b",
        configured: true,
        resultCount: 12,
        completedCount: 12,
        failedCount: 0,
        expectedMatchedCount: dream.expectedMatchedCount,
        expectedMatchRate: dream.expectedMatchRate,
        jsonComplianceCount: dream.jsonComplianceCount,
        jsonComplianceRate: dream.jsonComplianceRate,
        averageLatencyMs: dream.averageLatencyMs,
        averageTotalTokens: dream.averageTotalTokens,
        decisionCounts: dream.decisionCounts
      }
    ]
  }, null, 2));
}

writeReport(reportA, "2026-07-02T18:26:54.003Z",
  {
    expectedMatchedCount: 12,
    expectedMatchRate: 1,
    jsonComplianceCount: 12,
    jsonComplianceRate: 1,
    averageLatencyMs: 385,
    averageTotalTokens: 310,
    decisionCounts: { approve: 4, needs_review: 5, reject: 3 }
  },
  {
    expectedMatchedCount: 2,
    expectedMatchRate: 0.1667,
    jsonComplianceCount: 2,
    jsonComplianceRate: 0.1667,
    averageLatencyMs: 69336,
    averageTotalTokens: 0,
    decisionCounts: { unknown: 10, approve: 1, reject: 1 }
  }
);

writeReport(reportB, "2026-07-02T19:21:29.943Z",
  {
    expectedMatchedCount: 12,
    expectedMatchRate: 1,
    jsonComplianceCount: 12,
    jsonComplianceRate: 1,
    averageLatencyMs: 409,
    averageTotalTokens: 406,
    decisionCounts: { approve: 4, needs_review: 5, reject: 3 }
  },
  {
    expectedMatchedCount: 1,
    expectedMatchRate: 0.0833,
    jsonComplianceCount: 1,
    jsonComplianceRate: 0.0833,
    averageLatencyMs: 82774,
    averageTotalTokens: 0,
    decisionCounts: { unknown: 11, approve: 1 }
  }
);

const scriptPath = path.resolve(__dirname, "compare-live-mini-benchmarks.cjs");
const result = spawnSync(process.execPath, [scriptPath, reportA, reportB], {
  cwd: path.resolve(__dirname, ".."),
  env: {
    ...process.env,
    LIVE_MINI_BENCHMARK_COMPARISON_OUT_DIR: outDir
  },
  encoding: "utf8"
});

assert.equal(result.status, 0, result.stderr || result.stdout);

const stdout = JSON.parse(result.stdout);
assert.equal(stdout.ok, true);
assert.equal(stdout.runCount, 2);
assert.ok(fs.existsSync(stdout.jsonPath));
assert.ok(fs.existsSync(stdout.markdownPath));

const comparison = JSON.parse(fs.readFileSync(stdout.jsonPath, "utf8"));
const dreamDelta = comparison.deltas.find(delta => delta.kind === "dllm");

assert.ok(dreamDelta);
assert.equal(dreamDelta.unknownCountDelta, 1);
assert.equal(dreamDelta.expectedMatchRateDelta, -0.0834);
assert.equal(dreamDelta.jsonComplianceRateDelta, -0.0834);

const markdown = fs.readFileSync(stdout.markdownPath, "utf8");
assert.ok(markdown.includes("Live Mini Benchmark Comparison"));
assert.ok(markdown.includes("dream-coder-v0-instruct-7b"));
assert.ok(markdown.includes("Unknown Δ"));

console.log("live-mini-benchmark comparison smoke passed");
