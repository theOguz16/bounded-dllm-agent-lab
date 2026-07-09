const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SUITE_NAME = "phase-u-temporary-workspace-apply-fixture-suite";
const REPORT_DIR = path.join("reports", "temporary-workspace-apply-fixture-suite");

const sourceFile = "packages/example/src/index.ts";
const otherFile = "packages/example/src/other.ts";
const forbiddenFile = "packages/example/secrets.txt";
const originalContent = "export function addOne(value: number): number {\n  return value + 1;\n}\n";
const proposedContent =
  "export function addOne(value: number): number {\n  return value + 1;\n}\n\nexport function addTwo(value: number): number {\n  return value + 2;\n}\n";

const defaultFileContents = {
  [sourceFile]: originalContent,
  [otherFile]: "export const other = true;\n",
  [forbiddenFile]: "SECRET=false\n"
};

const defaultContext = {
  allowedFiles: [sourceFile, otherFile, forbiddenFile],
  forbiddenFiles: [forbiddenFile],
  fileContents: defaultFileContents
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

const readyPatchDryRunResult = {
  decision: "ready_to_apply",
  issues: [],
  previews: [
    {
      file: sourceFile,
      originalContent,
      proposedContent,
      changed: true,
      addedLines: 2,
      removedLines: 1,
      diffPreview: ""
    }
  ],
  summary: {
    totalFiles: 1,
    changedFiles: 1,
    unchangedFiles: 0,
    totalAddedLines: 2,
    totalRemovedLines: 1
  }
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

function repairDraftForFile(file, proposedPatch, overrides = {}) {
  return {
    ...safeRepairDraft,
    claims: [
      {
        type: "repair_draft",
        file,
        description: "Apply a full replacement patch.",
        proposedPatch,
        addressesIssueCodes: ["missing_proposed_patch"]
      }
    ],
    touchedFiles: [file],
    ...overrides
  };
}

function patchDryRunForFile(file, proposedPatch, overrides = {}) {
  return {
    ...readyPatchDryRunResult,
    previews: [
      {
        file,
        originalContent: defaultFileContents[file] || originalContent,
        proposedContent: proposedPatch,
        changed: true,
        addedLines: 1,
        removedLines: 1,
        diffPreview: ""
      }
    ],
    ...overrides
  };
}

function context(overrides = {}) {
  return {
    ...defaultContext,
    fileContents: {
      ...defaultFileContents
    },
    ...overrides
  };
}

const tooManyClaims = Array.from({ length: 11 }, (_, index) => ({
  type: "repair_draft",
  file: `packages/example/src/generated-${index}.ts`,
  description: "Apply a generated replacement.",
  proposedPatch: `export const generated${index} = ${index};\n`,
  addressesIssueCodes: ["missing_proposed_patch"]
}));
const tooManyFileContents = Object.fromEntries(
  tooManyClaims.map((claim) => [claim.file, "export const generated = 0;\n"])
);

const fixtures = [
  {
    caseId: "temp-apply-ready-valid-cleanup-true",
    expectedDecision: "temp_apply_ready",
    repairDraftMutation: safeRepairDraft,
    repairVerifierFinding: approvedRepairVerifierFinding,
    patchDryRunResult: readyPatchDryRunResult,
    context: context({ cleanup: true })
  },
  {
    caseId: "temp-apply-ready-valid-cleanup-false",
    expectedDecision: "temp_apply_ready",
    repairDraftMutation: safeRepairDraft,
    repairVerifierFinding: approvedRepairVerifierFinding,
    patchDryRunResult: readyPatchDryRunResult,
    context: context({ cleanup: false })
  },
  {
    caseId: "temp-apply-needs-review-missing-repair-draft-claim",
    expectedDecision: "temp_apply_needs_review",
    repairDraftMutation: {
      ...safeRepairDraft,
      claims: [{ type: "note", message: "No repair draft claim." }]
    },
    repairVerifierFinding: approvedRepairVerifierFinding,
    patchDryRunResult: readyPatchDryRunResult,
    context: context()
  },
  {
    caseId: "temp-apply-needs-review-allowed-files-scope-violation",
    expectedDecision: "temp_apply_needs_review",
    repairDraftMutation: repairDraftForFile(otherFile, "export const other = false;\n"),
    repairVerifierFinding: approvedRepairVerifierFinding,
    patchDryRunResult: patchDryRunForFile(otherFile, "export const other = false;\n"),
    context: context({ allowedFiles: [sourceFile] })
  },
  {
    caseId: "temp-apply-needs-review-missing-original-file-content",
    expectedDecision: "temp_apply_needs_review",
    repairDraftMutation: safeRepairDraft,
    repairVerifierFinding: approvedRepairVerifierFinding,
    patchDryRunResult: readyPatchDryRunResult,
    context: context({ fileContents: {} })
  },
  {
    caseId: "temp-apply-needs-review-too-many-files",
    expectedDecision: "temp_apply_needs_review",
    repairDraftMutation: {
      ...safeRepairDraft,
      claims: tooManyClaims,
      touchedFiles: tooManyClaims.map((claim) => claim.file)
    },
    repairVerifierFinding: approvedRepairVerifierFinding,
    patchDryRunResult: {
      ...readyPatchDryRunResult,
      previews: tooManyClaims.map((claim) => ({
        file: claim.file,
        originalContent: tooManyFileContents[claim.file],
        proposedContent: claim.proposedPatch,
        changed: true,
        addedLines: 1,
        removedLines: 1,
        diffPreview: ""
      }))
    },
    context: context({
      allowedFiles: tooManyClaims.map((claim) => claim.file),
      forbiddenFiles: [],
      fileContents: tooManyFileContents
    })
  },
  {
    caseId: "temp-apply-needs-review-proposed-patch-too-large",
    expectedDecision: "temp_apply_needs_review",
    repairDraftMutation: repairDraftForFile(sourceFile, "x".repeat(32)),
    repairVerifierFinding: approvedRepairVerifierFinding,
    patchDryRunResult: patchDryRunForFile(sourceFile, "x".repeat(32)),
    context: context({ maxFileBytes: 8 })
  },
  {
    caseId: "temp-apply-needs-review-no-op-patch",
    expectedDecision: "temp_apply_needs_review",
    repairDraftMutation: repairDraftForFile(sourceFile, originalContent),
    repairVerifierFinding: approvedRepairVerifierFinding,
    patchDryRunResult: readyPatchDryRunResult,
    context: context()
  },
  {
    caseId: "temp-apply-needs-review-missing-patch-dry-run-preview",
    expectedDecision: "temp_apply_needs_review",
    repairDraftMutation: safeRepairDraft,
    repairVerifierFinding: approvedRepairVerifierFinding,
    patchDryRunResult: {
      ...readyPatchDryRunResult,
      previews: []
    },
    context: context()
  },
  {
    caseId: "temp-apply-reject-non-remask-mutation",
    expectedDecision: "temp_apply_rejected",
    repairDraftMutation: {
      ...safeRepairDraft,
      role: "coder"
    },
    repairVerifierFinding: approvedRepairVerifierFinding,
    patchDryRunResult: readyPatchDryRunResult,
    context: context()
  },
  {
    caseId: "temp-apply-reject-non-repair-draft-target",
    expectedDecision: "temp_apply_rejected",
    repairDraftMutation: {
      ...safeRepairDraft,
      target: "patchDraft"
    },
    repairVerifierFinding: approvedRepairVerifierFinding,
    patchDryRunResult: readyPatchDryRunResult,
    context: context()
  },
  {
    caseId: "temp-apply-reject-repair-verifier-not-approved",
    expectedDecision: "temp_apply_rejected",
    repairDraftMutation: safeRepairDraft,
    repairVerifierFinding: repairVerifierFinding("needs_review"),
    patchDryRunResult: readyPatchDryRunResult,
    context: context()
  },
  {
    caseId: "temp-apply-reject-patch-dry-run-not-ready",
    expectedDecision: "temp_apply_rejected",
    repairDraftMutation: safeRepairDraft,
    repairVerifierFinding: approvedRepairVerifierFinding,
    patchDryRunResult: {
      ...readyPatchDryRunResult,
      decision: "needs_review"
    },
    context: context()
  },
  {
    caseId: "temp-apply-reject-unsafe-absolute-file-path",
    expectedDecision: "temp_apply_rejected",
    repairDraftMutation: repairDraftForFile(path.join(os.tmpdir(), "absolute.ts"), proposedContent),
    repairVerifierFinding: approvedRepairVerifierFinding,
    patchDryRunResult: patchDryRunForFile(path.join(os.tmpdir(), "absolute.ts"), proposedContent),
    context: context({
      allowedFiles: [path.join(os.tmpdir(), "absolute.ts")],
      forbiddenFiles: [],
      fileContents: {
        [path.join(os.tmpdir(), "absolute.ts")]: originalContent
      }
    })
  },
  {
    caseId: "temp-apply-reject-unsafe-parent-traversal-path",
    expectedDecision: "temp_apply_rejected",
    repairDraftMutation: repairDraftForFile("../outside.ts", proposedContent),
    repairVerifierFinding: approvedRepairVerifierFinding,
    patchDryRunResult: patchDryRunForFile("../outside.ts", proposedContent),
    context: context({
      allowedFiles: ["../outside.ts"],
      forbiddenFiles: [],
      fileContents: {
        "../outside.ts": originalContent
      }
    })
  },
  {
    caseId: "temp-apply-reject-git-path",
    expectedDecision: "temp_apply_rejected",
    repairDraftMutation: repairDraftForFile(".git/config", proposedContent),
    repairVerifierFinding: approvedRepairVerifierFinding,
    patchDryRunResult: patchDryRunForFile(".git/config", proposedContent),
    context: context({
      allowedFiles: [".git/config"],
      forbiddenFiles: [],
      fileContents: {
        ".git/config": originalContent
      }
    })
  },
  {
    caseId: "temp-apply-reject-backslash-path",
    expectedDecision: "temp_apply_rejected",
    repairDraftMutation: repairDraftForFile("packages\\example\\src\\index.ts", proposedContent),
    repairVerifierFinding: approvedRepairVerifierFinding,
    patchDryRunResult: patchDryRunForFile("packages\\example\\src\\index.ts", proposedContent),
    context: context({
      allowedFiles: ["packages\\example\\src\\index.ts"],
      forbiddenFiles: [],
      fileContents: {
        "packages\\example\\src\\index.ts": originalContent
      }
    })
  },
  {
    caseId: "temp-apply-reject-forbidden-file",
    expectedDecision: "temp_apply_rejected",
    repairDraftMutation: repairDraftForFile(forbiddenFile, "SECRET=true\n"),
    repairVerifierFinding: approvedRepairVerifierFinding,
    patchDryRunResult: patchDryRunForFile(forbiddenFile, "SECRET=true\n"),
    context: context()
  },
  {
    caseId: "temp-apply-reject-temp-workspace-escape-attempt",
    expectedDecision: "temp_apply_rejected",
    repairDraftMutation: repairDraftForFile("packages/example/../../outside.ts", proposedContent),
    repairVerifierFinding: approvedRepairVerifierFinding,
    patchDryRunResult: patchDryRunForFile("packages/example/../../outside.ts", proposedContent),
    context: context({
      allowedFiles: ["packages/example/../../outside.ts"],
      forbiddenFiles: [],
      fileContents: {
        "packages/example/../../outside.ts": originalContent
      }
    })
  }
];

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

async function loadTemporaryWorkspaceApplyGate() {
  const gatePath = pathToFileURL(
    path.join(
      process.cwd(),
      "dist",
      "packages",
      "product-runtime",
      "src",
      "temporary-workspace-apply-gate.js"
    )
  );
  return import(gatePath.href);
}

function cleanupPath(targetPath) {
  if (targetPath) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
}

function runFixture(fixture, applyToTemporaryWorkspace) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "temp-apply-fixture-"));
  const fixtureContext = {
    ...fixture.context,
    tempRoot
  };
  let result;
  let tempWorkspacePathExistsAfterRun = false;

  try {
    result = applyToTemporaryWorkspace(
      fixture.repairDraftMutation,
      fixture.repairVerifierFinding,
      fixture.patchDryRunResult,
      fixtureContext
    );
    tempWorkspacePathExistsAfterRun =
      typeof result.tempWorkspacePath === "string" &&
      fs.existsSync(result.tempWorkspacePath);

    return summarizeCase(fixture, result, tempWorkspacePathExistsAfterRun);
  } finally {
    cleanupPath(tempRoot);
  }
}

function summarizeCase(fixture, result, tempWorkspacePathExistsAfterRun) {
  return {
    caseId: fixture.caseId,
    expectedDecision: fixture.expectedDecision,
    actualDecision: result.decision,
    passed: result.decision === fixture.expectedDecision,
    issueCodes: result.issues.map((issue) => issue.code),
    issueCount: result.issues.length,
    appliedFileCount: result.appliedFiles.length,
    changedFiles: result.summary.changedFiles,
    totalAddedLines: result.summary.totalAddedLines,
    totalRemovedLines: result.summary.totalRemovedLines,
    cleanedUp: result.summary.cleanedUp,
    tempWorkspacePathExistsAfterRun
  };
}

function countCasesByActualDecision(cases, decision) {
  return cases.filter((testCase) => testCase.actualDecision === decision).length;
}

function buildReport(cases, startedAt, finishedAt) {
  const total = cases.length;
  const passed = cases.filter((testCase) => testCase.passed).length;
  const failed = total - passed;
  const tempApplyReadyCases = countCasesByActualDecision(cases, "temp_apply_ready");
  const tempApplyNeedsReviewCases = countCasesByActualDecision(
    cases,
    "temp_apply_needs_review"
  );
  const tempApplyRejectedCases = countCasesByActualDecision(
    cases,
    "temp_apply_rejected"
  );
  const allExpectedDecisionsObserved =
    tempApplyReadyCases > 0 &&
    tempApplyNeedsReviewCases > 0 &&
    tempApplyRejectedCases > 0 &&
    cases.some((testCase) => testCase.expectedDecision === "temp_apply_ready") &&
    cases.some((testCase) => testCase.expectedDecision === "temp_apply_needs_review") &&
    cases.some((testCase) => testCase.expectedDecision === "temp_apply_rejected");
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
    tempApplyReadyCases,
    tempApplyNeedsReviewCases,
    tempApplyRejectedCases,
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
      String(testCase.appliedFileCount),
      String(testCase.changedFiles),
      String(testCase.cleanedUp)
    ].join(" | ")
  );

  return [
    "# Temporary Workspace Apply Fixture Suite",
    "",
    `- Suite status: ${report.status}`,
    `- OK: ${report.ok}`,
    `- Total: ${report.total}`,
    `- Passed: ${report.passed}`,
    `- Failed: ${report.failed}`,
    `- temp_apply_ready cases: ${report.tempApplyReadyCases}`,
    `- temp_apply_needs_review cases: ${report.tempApplyNeedsReviewCases}`,
    `- temp_apply_rejected cases: ${report.tempApplyRejectedCases}`,
    `- allExpectedDecisionsObserved: ${report.allExpectedDecisionsObserved}`,
    `- Started at: ${report.startedAt}`,
    `- Finished at: ${report.finishedAt}`,
    `- Duration ms: ${report.durationMs}`,
    "",
    "## Cases",
    "",
    "caseId | expected | actual | passed | issueCodes | appliedFileCount | changedFiles | cleanedUp",
    "--- | --- | --- | --- | --- | --- | --- | ---",
    ...caseRows,
    ""
  ].join("\n");
}

function writeReport(report) {
  const outDir = ensureDir(path.resolve(process.cwd(), REPORT_DIR));
  const timestamp = safeTimestamp();
  const jsonPath = path.join(
    outDir,
    `${timestamp}-temporary-workspace-apply-fixture-suite.json`
  );
  const markdownPath = path.join(
    outDir,
    `${timestamp}-temporary-workspace-apply-fixture-suite.md`
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
  const { applyToTemporaryWorkspace } = await loadTemporaryWorkspaceApplyGate();
  const cases = fixtures.map((fixture) =>
    runFixture(fixture, applyToTemporaryWorkspace)
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
