const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SUITE_NAME = "phase-s-repair-draft-verifier-negative-fixture-suite";
const REPORT_DIR = path.join("reports", "repair-draft-verifier-negative-fixture-suite");

const defaultContext = {
  allowedFiles: ["packages/example/src/index.ts"],
  forbiddenFiles: [".env", "secrets.json", "infra/prod.tf"],
  requiredIssueCodes: ["missing_proposed_patch"],
  minConfidence: 0.5
};

const safeRepairDraft = {
  role: "remask",
  target: "repairDraft",
  summary: "Repair a missing proposedPatch in a bounded patch draft.",
  claims: [
    {
      type: "repair_draft",
      file: "packages/example/src/index.ts",
      description: "Add the missing proposedPatch for the safe helper.",
      proposedPatch: "export function addOne(value: number): number { return value + 1; }",
      addressesIssueCodes: ["missing_proposed_patch"]
    }
  ],
  touchedFiles: ["packages/example/src/index.ts"],
  confidence: 0.9
};

const fixtures = [
  {
    caseId: "repair-draft-approve-safe-helper",
    expectedDecision: "approve",
    mutation: safeRepairDraft,
    context: defaultContext
  },
  {
    caseId: "repair-draft-needs-review-missing-proposed-patch",
    expectedDecision: "needs_review",
    mutation: {
      ...safeRepairDraft,
      claims: [
        {
          type: "repair_draft",
          file: "packages/example/src/index.ts",
          description: "Add the missing proposedPatch for the safe helper.",
          addressesIssueCodes: ["missing_proposed_patch"]
        }
      ]
    },
    context: defaultContext
  },
  {
    caseId: "repair-draft-needs-review-missing-addresses-issue-codes",
    expectedDecision: "needs_review",
    mutation: {
      ...safeRepairDraft,
      claims: [
        {
          type: "repair_draft",
          file: "packages/example/src/index.ts",
          description: "Add the missing proposedPatch for the safe helper.",
          proposedPatch: "export function addOne(value: number): number { return value + 1; }"
        }
      ]
    },
    context: defaultContext
  },
  {
    caseId: "repair-draft-needs-review-required-issue-code-not-addressed",
    expectedDecision: "needs_review",
    mutation: {
      ...safeRepairDraft,
      claims: [
        {
          type: "repair_draft",
          file: "packages/example/src/index.ts",
          description: "Address a different verifier finding.",
          proposedPatch: "export function addOne(value: number): number { return value + 1; }",
          addressesIssueCodes: ["low_confidence"]
        }
      ]
    },
    context: defaultContext
  },
  {
    caseId: "repair-draft-needs-review-claim-outside-touched-files",
    expectedDecision: "needs_review",
    mutation: {
      ...safeRepairDraft,
      touchedFiles: ["packages/example/src/other.ts"]
    },
    context: {
      ...defaultContext,
      allowedFiles: ["packages/example/src/index.ts", "packages/example/src/other.ts"]
    }
  },
  {
    caseId: "repair-draft-needs-review-touched-file-without-claim",
    expectedDecision: "needs_review",
    mutation: {
      ...safeRepairDraft,
      touchedFiles: ["packages/example/src/index.ts", "packages/example/src/other.ts"]
    },
    context: {
      ...defaultContext,
      allowedFiles: ["packages/example/src/index.ts", "packages/example/src/other.ts"]
    }
  },
  {
    caseId: "repair-draft-needs-review-low-confidence",
    expectedDecision: "needs_review",
    mutation: {
      ...safeRepairDraft,
      confidence: 0.2
    },
    context: defaultContext
  },
  {
    caseId: "repair-draft-needs-review-allowed-files-scope-violation",
    expectedDecision: "needs_review",
    mutation: {
      ...safeRepairDraft,
      claims: [
        {
          type: "repair_draft",
          file: "packages/other/src/index.ts",
          description: "Add the missing proposedPatch in another package.",
          proposedPatch: "export function addOne(value: number): number { return value + 1; }",
          addressesIssueCodes: ["missing_proposed_patch"]
        }
      ],
      touchedFiles: ["packages/other/src/index.ts"]
    },
    context: defaultContext
  },
  {
    caseId: "repair-draft-reject-forbidden-file",
    expectedDecision: "reject",
    mutation: {
      ...safeRepairDraft,
      claims: [
        {
          type: "repair_draft",
          file: ".env",
          description: "Update local environment values.",
          proposedPatch: "LOCAL_ONLY=true",
          addressesIssueCodes: ["missing_proposed_patch"]
        }
      ],
      touchedFiles: [".env"]
    },
    context: defaultContext
  },
  {
    caseId: "repair-draft-reject-unsafe-patch-content",
    expectedDecision: "reject",
    mutation: {
      ...safeRepairDraft,
      claims: [
        {
          type: "repair_draft",
          file: "packages/example/src/index.ts",
          description: "Read a token from the environment.",
          proposedPatch: "const token = process.env.SECRET || process.env.TOKEN;",
          addressesIssueCodes: ["missing_proposed_patch"]
        }
      ]
    },
    context: defaultContext
  },
  {
    caseId: "repair-draft-reject-non-remask-mutation",
    expectedDecision: "reject",
    mutation: {
      ...safeRepairDraft,
      role: "coder"
    },
    context: defaultContext
  },
  {
    caseId: "repair-draft-reject-non-repair-draft-target",
    expectedDecision: "reject",
    mutation: {
      ...safeRepairDraft,
      target: "patchDraft"
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

async function loadRepairDraftVerifierGate() {
  const gatePath = pathToFileURL(
    path.join(
      process.cwd(),
      "dist",
      "packages",
      "product-runtime",
      "src",
      "repair-draft-verifier-gate.js"
    )
  );
  return import(gatePath.href);
}

function summarizeCase(fixture, result) {
  const issueCodes = result.issues.map((issue) => issue.code);

  return {
    caseId: fixture.caseId,
    expectedDecision: fixture.expectedDecision,
    actualDecision: result.decision,
    passed: result.decision === fixture.expectedDecision,
    issueCodes,
    issueCount: result.issues.length,
    findingRole: result.finding.role,
    findingTarget: result.finding.target
  };
}

function countCasesByExpectedDecision(cases, decision) {
  return cases.filter((testCase) => testCase.expectedDecision === decision).length;
}

function buildReport(cases, startedAt, finishedAt) {
  const total = cases.length;
  const passed = cases.filter((testCase) => testCase.passed).length;
  const failed = total - passed;
  const approveCases = countCasesByExpectedDecision(cases, "approve");
  const needsReviewCases = countCasesByExpectedDecision(cases, "needs_review");
  const rejectCases = countCasesByExpectedDecision(cases, "reject");
  const allExpectedDecisionsObserved =
    approveCases > 0 &&
    needsReviewCases > 0 &&
    rejectCases > 0 &&
    cases.some((testCase) => testCase.actualDecision === "approve") &&
    cases.some((testCase) => testCase.actualDecision === "needs_review") &&
    cases.some((testCase) => testCase.actualDecision === "reject");
  const ok = failed === 0 && allExpectedDecisionsObserved;

  return {
    suiteName: SUITE_NAME,
    ok,
    status: "completed",
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    total,
    passed,
    failed,
    approveCases,
    needsReviewCases,
    rejectCases,
    allExpectedDecisionsObserved,
    cases,
    jsonPath: "",
    markdownPath: ""
  };
}

function renderMarkdown(report) {
  const caseRows = report.cases.map((testCase) =>
    [
      testCase.caseId,
      testCase.expectedDecision,
      testCase.actualDecision,
      String(testCase.passed),
      testCase.issueCodes.join(", ")
    ].join(" | ")
  );

  return [
    "# RepairDraft Verifier Negative Fixture Suite",
    "",
    `- Suite status: ${report.status}`,
    `- OK: ${report.ok}`,
    `- Total: ${report.total}`,
    `- Passed: ${report.passed}`,
    `- Failed: ${report.failed}`,
    `- Approve cases: ${report.approveCases}`,
    `- Needs review cases: ${report.needsReviewCases}`,
    `- Reject cases: ${report.rejectCases}`,
    `- allExpectedDecisionsObserved: ${report.allExpectedDecisionsObserved}`,
    `- Started at: ${report.startedAt}`,
    `- Finished at: ${report.finishedAt}`,
    `- Duration ms: ${report.durationMs}`,
    "",
    "## Cases",
    "",
    "caseId | expected | actual | passed | issueCodes",
    "--- | --- | --- | --- | ---",
    ...caseRows,
    ""
  ].join("\n");
}

function writeReport(report) {
  const outDir = ensureDir(path.resolve(process.cwd(), REPORT_DIR));
  const timestamp = safeTimestamp();
  const jsonPath = path.join(
    outDir,
    `${timestamp}-repair-draft-verifier-negative-fixture-suite.json`
  );
  const markdownPath = path.join(
    outDir,
    `${timestamp}-repair-draft-verifier-negative-fixture-suite.md`
  );
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
  const { verifyRepairDraftMutation } = await loadRepairDraftVerifierGate();
  const cases = fixtures.map((fixture) =>
    summarizeCase(
      fixture,
      verifyRepairDraftMutation(fixture.mutation, fixture.context)
    )
  );
  const finishedAt = new Date();

  return writeReport(buildReport(cases, startedAt, finishedAt));
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
  fixtures,
  run
};
