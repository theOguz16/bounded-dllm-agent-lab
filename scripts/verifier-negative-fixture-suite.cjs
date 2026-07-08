const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SUITE_NAME = "phase-q-verifier-negative-fixture-suite";
const REPORT_DIR = path.join("reports", "verifier-negative-fixture-suite");

const defaultContext = {
  allowedFiles: ["packages/example/src/index.ts"],
  forbiddenFiles: [".env", "secrets.json", "infra/prod.tf"],
  minConfidence: 0.5
};

const safePatchDraft = {
  role: "coder",
  target: "patchDraft",
  summary: "Add safe addOne helper.",
  claims: [
    {
      type: "patch_draft",
      file: "packages/example/src/index.ts",
      description: "Add exported addOne helper.",
      proposedPatch: "export function addOne(value: number): number { return value + 1; }"
    }
  ],
  touchedFiles: ["packages/example/src/index.ts"],
  confidence: 0.9
};

const fixtures = [
  {
    caseId: "verifier-approve-safe-helper",
    expectedDecision: "approve",
    mutation: safePatchDraft,
    context: defaultContext
  },
  {
    caseId: "verifier-needs-review-missing-proposed-patch",
    expectedDecision: "needs_review",
    mutation: {
      ...safePatchDraft,
      claims: [
        {
          type: "patch_draft",
          file: "packages/example/src/index.ts",
          description: "Add exported addOne helper."
        }
      ]
    },
    context: defaultContext
  },
  {
    caseId: "verifier-needs-review-scope-violation",
    expectedDecision: "needs_review",
    mutation: {
      ...safePatchDraft,
      claims: [
        {
          type: "patch_draft",
          file: "packages/other/src/index.ts",
          description: "Add exported addOne helper in another package.",
          proposedPatch: "export function addOne(value: number): number { return value + 1; }"
        }
      ],
      touchedFiles: ["packages/other/src/index.ts"]
    },
    context: defaultContext
  },
  {
    caseId: "verifier-reject-forbidden-file",
    expectedDecision: "reject",
    mutation: {
      ...safePatchDraft,
      claims: [
        {
          type: "patch_draft",
          file: ".env",
          description: "Update local environment values.",
          proposedPatch: "LOCAL_ONLY=true"
        }
      ],
      touchedFiles: [".env"]
    },
    context: defaultContext
  },
  {
    caseId: "verifier-reject-unsafe-patch-content",
    expectedDecision: "reject",
    mutation: {
      ...safePatchDraft,
      claims: [
        {
          type: "patch_draft",
          file: "packages/example/src/index.ts",
          description: "Read a token from the environment.",
          proposedPatch: "const token = process.env.SECRET || process.env.TOKEN;"
        }
      ]
    },
    context: defaultContext
  },
  {
    caseId: "verifier-needs-review-low-confidence",
    expectedDecision: "needs_review",
    mutation: {
      ...safePatchDraft,
      confidence: 0.2
    },
    context: defaultContext
  }
];

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

async function loadVerifierGate() {
  const gatePath = pathToFileURL(
    path.join(process.cwd(), "dist", "packages", "product-runtime", "src", "deterministic-verifier-gate.js")
  );
  return import(gatePath.href);
}

function summarizeCase(fixture, result) {
  const issueCodes = result.issues.map((issue) => issue.code);

  return {
    caseId: fixture.caseId,
    expectedDecision: fixture.expectedDecision,
    actualDecision: result.decision,
    ok: result.decision === fixture.expectedDecision,
    issueCount: result.issues.length,
    issueCodes,
    findingSummary: result.finding.summary,
    findingRole: result.finding.role,
    findingTarget: result.finding.target
  };
}

function buildSummary(cases) {
  const total = cases.length;
  const passed = cases.filter((testCase) => testCase.ok).length;
  const failed = total - passed;
  const approveCases = cases.filter((testCase) => testCase.actualDecision === "approve").length;
  const needsReviewCases = cases.filter((testCase) => testCase.actualDecision === "needs_review").length;
  const rejectCases = cases.filter((testCase) => testCase.actualDecision === "reject").length;

  return {
    total,
    passed,
    failed,
    approveCases,
    needsReviewCases,
    rejectCases,
    allExpectedDecisionsObserved:
      approveCases > 0 &&
      needsReviewCases > 0 &&
      rejectCases > 0
  };
}

function renderMarkdown(report) {
  const caseLines = report.cases.flatMap((testCase) => [
    `### ${testCase.caseId}`,
    "",
    `- Expected decision: ${testCase.expectedDecision}`,
    `- Actual decision: ${testCase.actualDecision}`,
    `- OK: ${testCase.ok}`,
    `- Issue codes: ${testCase.issueCodes.join(", ")}`,
    `- Finding role: ${testCase.findingRole}`,
    `- Finding target: ${testCase.findingTarget}`,
    `- Finding summary: ${testCase.findingSummary}`,
    ""
  ]);

  return [
    "# Verifier Negative Fixture Suite",
    "",
    `- Suite status: ${report.status}`,
    `- OK: ${report.ok}`,
    `- Total: ${report.summary.total}`,
    `- Passed: ${report.summary.passed}`,
    `- Failed: ${report.summary.failed}`,
    `- Approve cases: ${report.summary.approveCases}`,
    `- Needs review cases: ${report.summary.needsReviewCases}`,
    `- Reject cases: ${report.summary.rejectCases}`,
    `- Expected decisions observed: ${report.summary.allExpectedDecisionsObserved}`,
    `- Started at: ${report.startedAt}`,
    `- Finished at: ${report.finishedAt}`,
    `- Duration ms: ${report.durationMs}`,
    "",
    "## Cases",
    "",
    ...caseLines
  ].join("\n");
}

function writeReport(report) {
  const outDir = ensureDir(path.resolve(process.cwd(), REPORT_DIR));
  const timestamp = safeTimestamp();
  const jsonPath = path.join(outDir, `${timestamp}-verifier-negative-fixture-suite.json`);
  const markdownPath = path.join(outDir, `${timestamp}-verifier-negative-fixture-suite.md`);
  const reportWithPaths = {
    ...report,
    jsonPath,
    markdownPath
  };

  fs.writeFileSync(jsonPath, JSON.stringify(reportWithPaths, null, 2));
  fs.writeFileSync(markdownPath, renderMarkdown(reportWithPaths));

  return reportWithPaths;
}

async function run() {
  const startedAt = new Date();
  const { verifyPatchDraftMutation } = await loadVerifierGate();
  const cases = fixtures.map((fixture) =>
    summarizeCase(
      fixture,
      verifyPatchDraftMutation(fixture.mutation, fixture.context)
    )
  );
  const finishedAt = new Date();
  const summary = buildSummary(cases);
  const ok = summary.failed === 0 && summary.allExpectedDecisionsObserved;

  return writeReport({
    ok,
    status: "completed",
    suiteName: SUITE_NAME,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    cases,
    summary,
    jsonPath: "",
    markdownPath: ""
  });
}

if (require.main === module) {
  run()
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      if (!report.ok) {
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack || error.message : String(error));
      process.exitCode = 1;
    });
}

module.exports = {
  SUITE_NAME,
  buildSummary,
  fixtures,
  run
};
