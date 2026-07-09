const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SUITE_NAME = "phase-t-patch-application-dry-run-fixture-suite";
const REPORT_DIR = path.join("reports", "patch-application-dry-run-fixture-suite");

const sourceFile = "packages/example/src/index.ts";
const otherFile = "packages/example/src/other.ts";
const forbiddenFile = ".env";
const originalContent = "export function addOne(value: number): number {\n  return value + 1;\n}\n";
const proposedContent =
  "export function addOne(value: number): number {\n  return value + 1;\n}\n\nexport function addTwo(value: number): number {\n  return value + 2;\n}\n";

const defaultContext = {
  allowedFiles: [sourceFile],
  forbiddenFiles: [forbiddenFile, "secrets.json", "infra/prod.tf"],
  fileContents: {
    [sourceFile]: originalContent,
    [otherFile]: "export const other = true;\n",
    [forbiddenFile]: "LOCAL_ONLY=false\n"
  }
};

const safeRepairDraft = {
  role: "remask",
  target: "repairDraft",
  summary: "Repair a bounded patch draft with a full replacement preview.",
  claims: [
    {
      type: "repair_draft",
      file: sourceFile,
      description: "Add the safe addTwo helper.",
      proposedPatch: proposedContent,
      addressesIssueCodes: ["missing_proposed_patch"]
    }
  ],
  touchedFiles: [sourceFile],
  confidence: 0.9
};

const approvedRepairVerifierFinding = {
  role: "verifier",
  target: "verifierFinding",
  summary: "Deterministic repairDraft verifier returned approve.",
  claims: [
    {
      type: "deterministic_repair_draft_verifier_finding",
      decision: "approve",
      issues: []
    }
  ],
  touchedFiles: [sourceFile],
  confidence: 1
};

function repairVerifierFinding(decision, overrides = {}) {
  return {
    ...approvedRepairVerifierFinding,
    summary: `Deterministic repairDraft verifier returned ${decision}.`,
    claims: [
      {
        type: "deterministic_repair_draft_verifier_finding",
        decision,
        issues: []
      }
    ],
    ...overrides
  };
}

const fixtures = [
  {
    caseId: "patch-dry-run-ready-valid-approved-repair-draft",
    expectedDecision: "ready_to_apply",
    repairDraftMutation: safeRepairDraft,
    repairVerifierFinding: approvedRepairVerifierFinding,
    context: defaultContext
  },
  {
    caseId: "patch-dry-run-needs-review-empty-repair-claims",
    expectedDecision: "needs_review",
    repairDraftMutation: {
      ...safeRepairDraft,
      claims: []
    },
    repairVerifierFinding: approvedRepairVerifierFinding,
    context: defaultContext
  },
  {
    caseId: "patch-dry-run-needs-review-missing-repair-draft-claim",
    expectedDecision: "needs_review",
    repairDraftMutation: {
      ...safeRepairDraft,
      claims: [{ type: "note", message: "No repair draft claim." }]
    },
    repairVerifierFinding: approvedRepairVerifierFinding,
    context: defaultContext
  },
  {
    caseId: "patch-dry-run-needs-review-missing-file",
    expectedDecision: "needs_review",
    repairDraftMutation: {
      ...safeRepairDraft,
      claims: [
        {
          type: "repair_draft",
          description: "Add the safe addTwo helper.",
          proposedPatch: proposedContent,
          addressesIssueCodes: ["missing_proposed_patch"]
        }
      ]
    },
    repairVerifierFinding: approvedRepairVerifierFinding,
    context: defaultContext
  },
  {
    caseId: "patch-dry-run-needs-review-missing-proposed-patch",
    expectedDecision: "needs_review",
    repairDraftMutation: {
      ...safeRepairDraft,
      claims: [
        {
          type: "repair_draft",
          file: sourceFile,
          description: "Add the safe addTwo helper.",
          addressesIssueCodes: ["missing_proposed_patch"]
        }
      ]
    },
    repairVerifierFinding: approvedRepairVerifierFinding,
    context: defaultContext
  },
  {
    caseId: "patch-dry-run-needs-review-invalid-proposed-patch",
    expectedDecision: "needs_review",
    repairDraftMutation: {
      ...safeRepairDraft,
      claims: [
        {
          type: "repair_draft",
          file: sourceFile,
          description: "Add the safe addTwo helper.",
          proposedPatch: { raw: proposedContent },
          addressesIssueCodes: ["missing_proposed_patch"]
        }
      ]
    },
    repairVerifierFinding: approvedRepairVerifierFinding,
    context: defaultContext
  },
  {
    caseId: "patch-dry-run-needs-review-missing-original-file-content",
    expectedDecision: "needs_review",
    repairDraftMutation: safeRepairDraft,
    repairVerifierFinding: approvedRepairVerifierFinding,
    context: {
      ...defaultContext,
      fileContents: {}
    }
  },
  {
    caseId: "patch-dry-run-needs-review-claim-outside-touched-files",
    expectedDecision: "needs_review",
    repairDraftMutation: {
      ...safeRepairDraft,
      touchedFiles: [otherFile]
    },
    repairVerifierFinding: approvedRepairVerifierFinding,
    context: {
      ...defaultContext,
      allowedFiles: [sourceFile, otherFile]
    }
  },
  {
    caseId: "patch-dry-run-needs-review-touched-file-without-repair-claim",
    expectedDecision: "needs_review",
    repairDraftMutation: {
      ...safeRepairDraft,
      touchedFiles: [sourceFile, otherFile]
    },
    repairVerifierFinding: approvedRepairVerifierFinding,
    context: {
      ...defaultContext,
      allowedFiles: [sourceFile, otherFile]
    }
  },
  {
    caseId: "patch-dry-run-needs-review-allowed-files-scope-violation",
    expectedDecision: "needs_review",
    repairDraftMutation: {
      ...safeRepairDraft,
      claims: [
        {
          type: "repair_draft",
          file: otherFile,
          description: "Touch a file outside the allowed dry-run scope.",
          proposedPatch: "export const other = false;\n",
          addressesIssueCodes: ["missing_proposed_patch"]
        }
      ],
      touchedFiles: [otherFile]
    },
    repairVerifierFinding: approvedRepairVerifierFinding,
    context: defaultContext
  },
  {
    caseId: "patch-dry-run-needs-review-proposed-patch-too-large",
    expectedDecision: "needs_review",
    repairDraftMutation: safeRepairDraft,
    repairVerifierFinding: approvedRepairVerifierFinding,
    context: {
      ...defaultContext,
      maxProposedPatchChars: 20
    }
  },
  {
    caseId: "patch-dry-run-needs-review-no-op-patch",
    expectedDecision: "needs_review",
    repairDraftMutation: {
      ...safeRepairDraft,
      claims: [
        {
          type: "repair_draft",
          file: sourceFile,
          description: "Submit a replacement identical to the original.",
          proposedPatch: originalContent,
          addressesIssueCodes: ["missing_proposed_patch"]
        }
      ]
    },
    repairVerifierFinding: approvedRepairVerifierFinding,
    context: defaultContext
  },
  {
    caseId: "patch-dry-run-reject-non-remask-mutation",
    expectedDecision: "reject",
    repairDraftMutation: {
      ...safeRepairDraft,
      role: "coder"
    },
    repairVerifierFinding: approvedRepairVerifierFinding,
    context: defaultContext
  },
  {
    caseId: "patch-dry-run-reject-non-repair-draft-target",
    expectedDecision: "reject",
    repairDraftMutation: {
      ...safeRepairDraft,
      target: "patchDraft"
    },
    repairVerifierFinding: approvedRepairVerifierFinding,
    context: defaultContext
  },
  {
    caseId: "patch-dry-run-reject-missing-repair-verifier-approval",
    expectedDecision: "reject",
    repairDraftMutation: safeRepairDraft,
    repairVerifierFinding: {
      ...approvedRepairVerifierFinding,
      claims: []
    },
    context: defaultContext
  },
  {
    caseId: "patch-dry-run-reject-repair-verifier-needs-review",
    expectedDecision: "reject",
    repairDraftMutation: safeRepairDraft,
    repairVerifierFinding: repairVerifierFinding("needs_review"),
    context: defaultContext
  },
  {
    caseId: "patch-dry-run-reject-forbidden-file",
    expectedDecision: "reject",
    repairDraftMutation: {
      ...safeRepairDraft,
      claims: [
        {
          type: "repair_draft",
          file: forbiddenFile,
          description: "Update a forbidden environment file.",
          proposedPatch: "LOCAL_ONLY=true\n",
          addressesIssueCodes: ["missing_proposed_patch"]
        }
      ],
      touchedFiles: [forbiddenFile]
    },
    repairVerifierFinding: approvedRepairVerifierFinding,
    context: defaultContext
  },
  {
    caseId: "patch-dry-run-reject-unsafe-proposed-patch",
    expectedDecision: "reject",
    repairDraftMutation: {
      ...safeRepairDraft,
      claims: [
        {
          type: "repair_draft",
          file: sourceFile,
          description: "Read a token from the environment.",
          proposedPatch: "const token = process.env.SECRET || process.env.TOKEN;",
          addressesIssueCodes: ["missing_proposed_patch"]
        }
      ]
    },
    repairVerifierFinding: approvedRepairVerifierFinding,
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

async function loadPatchApplicationDryRunGate() {
  const gatePath = pathToFileURL(
    path.join(
      process.cwd(),
      "dist",
      "packages",
      "product-runtime",
      "src",
      "patch-application-dry-run-gate.js"
    )
  );
  return import(gatePath.href);
}

function summarizeCase(fixture, result) {
  return {
    caseId: fixture.caseId,
    expectedDecision: fixture.expectedDecision,
    actualDecision: result.decision,
    passed: result.decision === fixture.expectedDecision,
    issueCodes: result.issues.map((issue) => issue.code),
    issueCount: result.issues.length,
    previewCount: result.previews.length,
    changedFiles: result.summary.changedFiles,
    totalAddedLines: result.summary.totalAddedLines,
    totalRemovedLines: result.summary.totalRemovedLines
  };
}

function countCasesByActualDecision(cases, decision) {
  return cases.filter((testCase) => testCase.actualDecision === decision).length;
}

function buildReport(cases, startedAt, finishedAt) {
  const total = cases.length;
  const passed = cases.filter((testCase) => testCase.passed).length;
  const failed = total - passed;
  const readyToApplyCases = countCasesByActualDecision(cases, "ready_to_apply");
  const needsReviewCases = countCasesByActualDecision(cases, "needs_review");
  const rejectCases = countCasesByActualDecision(cases, "reject");
  const allExpectedDecisionsObserved =
    readyToApplyCases > 0 &&
    needsReviewCases > 0 &&
    rejectCases > 0 &&
    cases.some((testCase) => testCase.expectedDecision === "ready_to_apply") &&
    cases.some((testCase) => testCase.expectedDecision === "needs_review") &&
    cases.some((testCase) => testCase.expectedDecision === "reject");
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
    readyToApplyCases,
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
      testCase.issueCodes.join(", "),
      String(testCase.changedFiles)
    ].join(" | ")
  );

  return [
    "# Patch Application Dry-Run Fixture Suite",
    "",
    `- Suite status: ${report.status}`,
    `- OK: ${report.ok}`,
    `- Total: ${report.total}`,
    `- Passed: ${report.passed}`,
    `- Failed: ${report.failed}`,
    `- ready_to_apply cases: ${report.readyToApplyCases}`,
    `- needs_review cases: ${report.needsReviewCases}`,
    `- reject cases: ${report.rejectCases}`,
    `- allExpectedDecisionsObserved: ${report.allExpectedDecisionsObserved}`,
    `- Started at: ${report.startedAt}`,
    `- Finished at: ${report.finishedAt}`,
    `- Duration ms: ${report.durationMs}`,
    "",
    "## Cases",
    "",
    "caseId | expected | actual | passed | issueCodes | changedFiles",
    "--- | --- | --- | --- | --- | ---",
    ...caseRows,
    ""
  ].join("\n");
}

function writeReport(report) {
  const outDir = ensureDir(path.resolve(process.cwd(), REPORT_DIR));
  const timestamp = safeTimestamp();
  const jsonPath = path.join(
    outDir,
    `${timestamp}-patch-application-dry-run-fixture-suite.json`
  );
  const markdownPath = path.join(
    outDir,
    `${timestamp}-patch-application-dry-run-fixture-suite.md`
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
  const { dryRunPatchApplication } = await loadPatchApplicationDryRunGate();
  const cases = fixtures.map((fixture) =>
    summarizeCase(
      fixture,
      dryRunPatchApplication(
        fixture.repairDraftMutation,
        fixture.repairVerifierFinding,
        fixture.context
      )
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
  SUITE_NAME,
  buildReport,
  fixtures,
  renderMarkdown,
  run
};
