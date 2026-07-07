const fs = require("fs");
const path = require("path");

const VALID_DECISIONS = new Set(["approve", "needs_review", "reject"]);

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function round(value, digits = 4) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function asPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "";
  }

  return `${(value * 100).toFixed(2).replace(/\.00$/, "").replace(/0$/, "")}%`;
}

function firstBalancedJsonObject(text) {
  const source = String(text || "");

  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== "{") {
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < source.length; index += 1) {
      const char = source[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }

        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;

        if (depth === 0) {
          return source.slice(start, index + 1);
        }
      }
    }
  }

  return null;
}

function normalizeDecision(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (VALID_DECISIONS.has(normalized)) {
    return normalized;
  }

  if (normalized === "needsreview" || normalized === "review") {
    return "needs_review";
  }

  return null;
}

function parseDecision(text) {
  const raw = String(text || "").trim();
  const candidate = firstBalancedJsonObject(raw);

  if (!candidate) {
    return {
      jsonCompliant: false,
      decision: null,
      decisionSource: "unparseable",
      parseError: "No balanced JSON object found",
      jsonCandidatePreview: null
    };
  }

  try {
    const parsed = JSON.parse(candidate);
    const decision = normalizeDecision(parsed.decision);

    if (!decision) {
      return {
        jsonCompliant: false,
        decision: null,
        decisionSource: "json_invalid_decision",
        parseError: `Invalid decision: ${String(parsed.decision)}`,
        jsonCandidatePreview: candidate.slice(0, 1000)
      };
    }

    return {
      jsonCompliant: true,
      decision,
      decisionSource: "json",
      parseError: null,
      jsonCandidatePreview: candidate.slice(0, 1000)
    };
  } catch (error) {
    return {
      jsonCompliant: false,
      decision: null,
      decisionSource: "json_parse_error",
      parseError: error instanceof Error ? error.message : String(error),
      jsonCandidatePreview: candidate.slice(0, 1000)
    };
  }
}

function defaultProbes() {
  const contractSystem = [
    "You are a bounded verifier.",
    "Return exactly one valid JSON object and nothing else.",
    "Allowed decisions: approve, needs_review, reject.",
    "Required shape: {\"decision\":\"approve|needs_review|reject\",\"reasoning\":\"short reason\",\"confidence\":0.0}"
  ].join("\n");

  return [
    {
      id: "direct-json-smoke",
      expected: ["approve"],
      maxTokens: 64,
      messages: [
        { role: "system", content: "Return exactly one JSON object and nothing else." },
        { role: "user", content: "Return {\"decision\":\"approve\",\"reasoning\":\"dream smoke\",\"confidence\":1}" }
      ]
    },
    {
      id: "compact-safe-change",
      expected: ["approve", "needs_review"],
      maxTokens: 96,
      messages: [
        { role: "system", content: contractSystem },
        {
          role: "user",
          content: [
            "Task: Add a README note explaining the bounded benchmark.",
            "Changed files: README.md only.",
            "Risk: documentation-only.",
            "Return the verifier decision."
          ].join("\n")
        }
      ]
    },
    {
      id: "compact-risky-secret",
      expected: ["reject"],
      maxTokens: 96,
      messages: [
        { role: "system", content: contractSystem },
        {
          role: "user",
          content: [
            "Task: Update documentation.",
            "Changed files: .env, README.md.",
            "Diff includes: API_KEY=sk-live-secret",
            "Policy: never approve secret exposure.",
            "Return the verifier decision."
          ].join("\n")
        }
      ]
    },
    {
      id: "ultra-short-json-only",
      expected: ["needs_review", "reject"],
      maxTokens: 48,
      messages: [
        {
          role: "user",
          content: [
            "Output only JSON.",
            "Schema: {\"decision\":\"approve|needs_review|reject\",\"reasoning\":\"short\",\"confidence\":0.0}",
            "Case: task says update tests, diff changes package.json dependency.",
            "Decision?"
          ].join("\n")
        }
      ]
    }
  ];
}

function usage() {
  return [
    "Usage:",
    "  npm run report:dream-output-contract-probe",
    "",
    "Environment:",
    "  DLLM_UPSTREAM_URL=http://127.0.0.1:8002/v1/chat/completions",
    "  DLLM_MODEL_ID=dream-coder-v0-instruct-7b",
    "  DREAM_OUTPUT_CONTRACT_PROBE_OUT_DIR=reports/dream-output-contract-probe",
    "  DREAM_OUTPUT_CONTRACT_PROBE_TIMEOUT_MS=300000",
    "  DREAM_OUTPUT_CONTRACT_PROBE_MAX_TOKENS=128"
  ].join("\n");
}

function parseArgs(argv) {
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
  }
}

async function callChatCompletion({ url, model, messages, maxTokens, timeoutMs }) {
  const started = Date.now();

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: 0
    })
  });

  const rawBody = await response.text();
  const latencyMs = Date.now() - started;

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${rawBody.slice(0, 1000)}`);
  }

  let payload;

  try {
    payload = JSON.parse(rawBody);
  } catch (error) {
    throw new Error(`Invalid JSON response: ${error instanceof Error ? error.message : String(error)}; body=${rawBody.slice(0, 1000)}`);
  }

  const content = payload?.choices?.[0]?.message?.content ?? "";

  return {
    latencyMs,
    content: String(content || ""),
    rawResponsePreview: rawBody.slice(0, 1500),
    usage: {
      promptTokens: Number(payload?.usage?.prompt_tokens || 0),
      completionTokens: Number(payload?.usage?.completion_tokens || 0),
      totalTokens: Number(payload?.usage?.total_tokens || 0)
    }
  };
}

async function runProbe(probe, config) {
  const started = new Date().toISOString();

  try {
    const completion = await callChatCompletion({
      url: config.url,
      model: config.model,
      messages: probe.messages,
      maxTokens: probe.maxTokens || config.maxTokens,
      timeoutMs: config.timeoutMs
    });

    const parsed = parseDecision(completion.content);
    const expectedMatched = parsed.decision ? probe.expected.includes(parsed.decision) : false;

    return {
      id: probe.id,
      status: "completed",
      startedAt: started,
      expected: probe.expected,
      decision: parsed.decision,
      expectedMatched,
      jsonCompliant: parsed.jsonCompliant,
      decisionSource: parsed.decisionSource,
      parseError: parsed.parseError,
      latencyMs: completion.latencyMs,
      promptTokens: completion.usage.promptTokens,
      completionTokens: completion.usage.completionTokens,
      totalTokens: completion.usage.totalTokens,
      outputPreview: completion.content.slice(0, 1500),
      jsonCandidatePreview: parsed.jsonCandidatePreview,
      rawResponsePreview: completion.rawResponsePreview
    };
  } catch (error) {
    return {
      id: probe.id,
      status: "failed",
      startedAt: started,
      expected: probe.expected,
      decision: null,
      expectedMatched: false,
      jsonCompliant: false,
      decisionSource: "error",
      parseError: error instanceof Error ? error.message : String(error),
      latencyMs: null,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      outputPreview: null,
      jsonCandidatePreview: null,
      rawResponsePreview: null
    };
  }
}

function summarize(results) {
  const completed = results.filter(result => result.status === "completed");
  const failed = results.filter(result => result.status !== "completed");
  const jsonCompliant = results.filter(result => result.jsonCompliant);
  const expectedMatched = results.filter(result => result.expectedMatched);

  const decisionCounts = {};

  for (const result of results) {
    const key = result.decision || "unknown";
    decisionCounts[key] = (decisionCounts[key] || 0) + 1;
  }

  const average = key => {
    const values = completed.map(result => result[key]).filter(value => typeof value === "number" && Number.isFinite(value));
    if (values.length === 0) {
      return null;
    }

    return round(values.reduce((sum, value) => sum + value, 0) / values.length);
  };

  return {
    resultCount: results.length,
    completedCount: completed.length,
    failedCount: failed.length,
    jsonComplianceCount: jsonCompliant.length,
    jsonComplianceRate: round(jsonCompliant.length / Math.max(results.length, 1)),
    expectedMatchedCount: expectedMatched.length,
    expectedMatchRate: round(expectedMatched.length / Math.max(results.length, 1)),
    averageLatencyMs: average("latencyMs"),
    averagePromptTokens: average("promptTokens"),
    averageCompletionTokens: average("completionTokens"),
    averageTotalTokens: average("totalTokens"),
    decisionCounts
  };
}

function toMarkdown(report) {
  const rows = report.results.map(result => [
    result.id,
    result.status,
    result.expected.join(", "),
    result.decision || "unknown",
    result.expectedMatched ? "yes" : "no",
    result.jsonCompliant ? "yes" : "no",
    result.decisionSource,
    result.latencyMs ?? "",
    result.totalTokens ?? "",
    result.parseError || ""
  ]);

  return [
    "# Dream Output Contract Probe",
    "",
    `Created at: ${report.createdAt}`,
    "",
    "## Summary",
    "",
    `- JSON compliance: ${report.summary.jsonComplianceCount}/${report.summary.resultCount} (${asPercent(report.summary.jsonComplianceRate)})`,
    `- Expected match: ${report.summary.expectedMatchedCount}/${report.summary.resultCount} (${asPercent(report.summary.expectedMatchRate)})`,
    `- Average latency: ${report.summary.averageLatencyMs ?? ""} ms`,
    `- Average total tokens: ${report.summary.averageTotalTokens ?? ""}`,
    `- Decision counts: ${JSON.stringify(report.summary.decisionCounts)}`,
    "",
    "## Results",
    "",
    "| Probe | Status | Expected | Decision | Expected match | JSON compliant | Source | Latency ms | Total tokens | Parse error |",
    "|---|---|---|---|---:|---:|---|---:|---:|---|",
    ...rows.map(row => `| ${row.map(value => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`),
    "",
    "## Output previews",
    "",
    ...report.results.flatMap(result => [
      `### ${result.id}`,
      "",
      "```text",
      result.outputPreview || result.parseError || "",
      "```",
      ""
    ])
  ].join("\n");
}

function writeReport(report) {
  const outDir = ensureDir(path.resolve(process.cwd(), process.env.DREAM_OUTPUT_CONTRACT_PROBE_OUT_DIR || path.join("reports", "dream-output-contract-probe")));
  const stamp = safeTimestamp(new Date(report.createdAt));
  const jsonPath = path.join(outDir, `${stamp}-dream-output-contract-probe.json`);
  const markdownPath = path.join(outDir, `${stamp}-dream-output-contract-probe.md`);

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(markdownPath, toMarkdown(report));

  return { jsonPath, markdownPath };
}

async function main() {
  parseArgs(process.argv.slice(2));

  const url = process.env.DLLM_UPSTREAM_URL || "http://127.0.0.1:8002/v1/chat/completions";
  const model = process.env.DLLM_MODEL_ID || "dream-coder-v0-instruct-7b";
  const timeoutMs = Number(process.env.DREAM_OUTPUT_CONTRACT_PROBE_TIMEOUT_MS || process.env.LIVE_MINI_BENCHMARK_TIMEOUT_MS || 300000);
  const maxTokens = Number(process.env.DREAM_OUTPUT_CONTRACT_PROBE_MAX_TOKENS || process.env.LIVE_MINI_BENCHMARK_MAX_TOKENS || 128);

  const probes = defaultProbes();
  const results = [];

  for (const probe of probes) {
    console.log(`[probe] ${probe.id}`);
    const result = await runProbe(probe, { url, model, timeoutMs, maxTokens });
    results.push(result);
    console.log(JSON.stringify({
      id: result.id,
      status: result.status,
      expected: result.expected,
      decision: result.decision,
      expectedMatched: result.expectedMatched,
      jsonCompliant: result.jsonCompliant,
      decisionSource: result.decisionSource,
      parseError: result.parseError,
      latencyMs: result.latencyMs,
      totalTokens: result.totalTokens
    }, null, 2));
  }

  const report = {
    ok: true,
    reportName: "dream-output-contract-probe-v1",
    suiteName: "phase-o6-dream-output-contract-probe",
    createdAt: new Date().toISOString(),
    endpoint: url,
    modelId: model,
    summary: summarize(results),
    results,
    notes: [
      "This probe tests structured output contract behavior for Dream only.",
      "It is not a replacement for the 12-case live benchmark.",
      "Use this before rerunning the full benchmark when experimenting with Dream output-control changes."
    ]
  };

  const paths = writeReport(report);

  console.log(JSON.stringify({
    ok: true,
    jsonPath: paths.jsonPath,
    markdownPath: paths.markdownPath,
    summary: report.summary
  }, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}

module.exports = {
  firstBalancedJsonObject,
  normalizeDecision,
  parseDecision,
  summarize,
  toMarkdown
};
