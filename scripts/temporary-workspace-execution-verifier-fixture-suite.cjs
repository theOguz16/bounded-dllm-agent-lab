const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SUITE_NAME = "phase-v-temporary-workspace-execution-verifier-fixture-suite";
const FIXTURE_PREFIX = "phase-v-temp-exec-fixture-";
const REPORT_DIR = path.join(
  "reports",
  "temporary-workspace-execution-verifier-fixture-suite"
);
const repoRoot = path.resolve(__dirname, "..");

function nodeCommand(id, source, overrides = {}) {
  return {
    id,
    executable: "node",
    args: ["-e", source],
    ...overrides
  };
}

const fixtures = [
  {
    caseId: "temp-validation-passed-single-command",
    expectedDecision: "temp_validation_passed",
    commands: [nodeCommand("single-pass", "process.stdout.write('fixture-stdout')")]
  },
  {
    caseId: "temp-validation-passed-multiple-commands",
    expectedDecision: "temp_validation_passed",
    commands: [
      nodeCommand("first-pass", "process.stdout.write('first')"),
      nodeCommand("second-pass", "process.stderr.write('second')")
    ]
  },
  {
    caseId: "temp-validation-passed-expected-non-zero",
    expectedDecision: "temp_validation_passed",
    commands: [
      nodeCommand("expected-seven", "process.exit(7)", { expectedExitCodes: [7] })
    ]
  },
  {
    caseId: "temp-validation-failed-unexpected-non-zero",
    expectedDecision: "temp_validation_failed",
    expectedIssueCodes: ["validation_command_failed"],
    commands: [nodeCommand("unexpected-seven", "process.exit(7)")]
  },
  {
    caseId: "temp-validation-failed-timeout",
    expectedDecision: "temp_validation_failed",
    expectedIssueCodes: ["validation_command_timeout"],
    commands: [
      nodeCommand("timeout", "setTimeout(() => {}, 1000)", { timeoutMs: 25 })
    ]
  },
  {
    caseId: "temp-validation-failed-launch",
    expectedDecision: "temp_validation_failed",
    expectedIssueCodes: ["validation_command_launch_failed"],
    commands: [
      {
        id: "missing-executable",
        executable: "node-v2-fixture-executable-does-not-exist",
        args: []
      }
    ],
    allowedExecutables: ["node-v2-fixture-executable-does-not-exist"]
  },
  {
    caseId: "temp-validation-needs-review-temp-apply-not-ready",
    expectedDecision: "temp_validation_needs_review",
    expectedIssueCodes: ["temp_apply_not_ready"],
    contextOverrides: { tempApplyDecision: "temp_apply_needs_review" }
  },
  {
    caseId: "temp-validation-needs-review-workspace-cleaned",
    expectedDecision: "temp_validation_needs_review",
    expectedIssueCodes: ["temp_workspace_already_cleaned"],
    contextOverrides: { tempWorkspaceCleanedUp: true }
  },
  {
    caseId: "temp-validation-needs-review-workspace-missing",
    expectedDecision: "temp_validation_needs_review",
    expectedIssueCodes: ["temp_workspace_missing"],
    workspaceKind: "missing"
  },
  {
    caseId: "temp-validation-needs-review-workspace-not-directory",
    expectedDecision: "temp_validation_needs_review",
    expectedIssueCodes: ["temp_workspace_not_directory"],
    workspaceKind: "file"
  },
  {
    caseId: "temp-validation-needs-review-workspace-outside-temp-root",
    expectedDecision: "temp_validation_needs_review",
    expectedIssueCodes: ["workspace_outside_temp_root"],
    workspaceKind: "outside-temp-root"
  },
  {
    caseId: "temp-validation-needs-review-no-commands",
    expectedDecision: "temp_validation_needs_review",
    expectedIssueCodes: ["no_validation_commands"],
    commands: []
  },
  {
    caseId: "temp-validation-needs-review-too-many-commands",
    expectedDecision: "temp_validation_needs_review",
    expectedIssueCodes: ["too_many_validation_commands"],
    commands: [nodeCommand("one", ""), nodeCommand("two", "")],
    contextOverrides: { maxCommands: 1 }
  },
  {
    caseId: "temp-validation-needs-review-unsafe-executable",
    expectedDecision: "temp_validation_needs_review",
    expectedIssueCodes: ["unsafe_executable"],
    commands: [nodeCommand("unsafe", "", { executable: "bin/node" })],
    allowedExecutables: ["bin/node"]
  },
  {
    caseId: "temp-validation-needs-review-executable-not-allowlisted",
    expectedDecision: "temp_validation_needs_review",
    expectedIssueCodes: ["executable_not_allowed"],
    commands: [nodeCommand("not-allowed", "")],
    allowedExecutables: []
  },
  {
    caseId: "temp-validation-needs-review-invalid-args",
    expectedDecision: "temp_validation_needs_review",
    expectedIssueCodes: ["invalid_command_args"],
    commands: [nodeCommand("invalid-args", "", { args: "not-an-array" })]
  },
  {
    caseId: "temp-validation-needs-review-null-byte-argument",
    expectedDecision: "temp_validation_needs_review",
    expectedIssueCodes: ["unsafe_command_argument"],
    commands: [nodeCommand("null-byte", "", { args: ["bad\0argument"] })]
  },
  {
    caseId: "temp-validation-needs-review-invalid-timeout",
    expectedDecision: "temp_validation_needs_review",
    expectedIssueCodes: ["invalid_command_timeout"],
    commands: [nodeCommand("zero-timeout", "", { timeoutMs: 0 })]
  },
  {
    caseId: "temp-validation-needs-review-timeout-above-maximum",
    expectedDecision: "temp_validation_needs_review",
    expectedIssueCodes: ["invalid_command_timeout"],
    commands: [nodeCommand("large-timeout", "", { timeoutMs: 101 })],
    contextOverrides: { maxTimeoutMs: 100 }
  },
  {
    caseId: "temp-validation-needs-review-invalid-expected-exit-codes",
    expectedDecision: "temp_validation_needs_review",
    expectedIssueCodes: ["invalid_expected_exit_codes"],
    commands: [nodeCommand("invalid-exit-codes", "", { expectedExitCodes: [] })]
  },
  {
    caseId: "temp-validation-needs-review-unsafe-environment-key",
    expectedDecision: "temp_validation_needs_review",
    expectedIssueCodes: ["unsafe_environment_key"],
    contextOverrides: { environment: { FIXTURE_TOKEN: "not-a-secret" } }
  },
  {
    caseId: "temp-validation-needs-review-invalid-environment-value",
    expectedDecision: "temp_validation_needs_review",
    expectedIssueCodes: ["invalid_environment_value"],
    contextOverrides: { environment: { FIXTURE_MODE: 1 } }
  },
  {
    caseId: "temp-validation-needs-review-stdout-truncation",
    expectedDecision: "temp_validation_needs_review",
    expectedIssueCodes: ["validation_output_truncated"],
    commands: [nodeCommand("stdout-truncation", "process.stdout.write('x'.repeat(64))")],
    contextOverrides: { maxOutputChars: 16 }
  },
  {
    caseId: "temp-validation-needs-review-stderr-truncation",
    expectedDecision: "temp_validation_needs_review",
    expectedIssueCodes: ["validation_output_truncated"],
    commands: [nodeCommand("stderr-truncation", "process.stderr.write('y'.repeat(64))")],
    contextOverrides: { maxOutputChars: 16 }
  }
];

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function workspaceForFixture(fixture, fixtureRoot, index) {
  if (fixture.workspaceKind === "outside-temp-root") {
    return repoRoot;
  }

  const workspacePath = path.join(fixtureRoot, `${String(index).padStart(2, "0")}`);

  if (fixture.workspaceKind === "missing") {
    return workspacePath;
  }

  if (fixture.workspaceKind === "file") {
    fs.writeFileSync(workspacePath, "fixture file\n");
    return workspacePath;
  }

  fs.mkdirSync(workspacePath);
  return workspacePath;
}

function runFixture(fixture, fixtureRoot, index, verify) {
  const workspacePath = workspaceForFixture(fixture, fixtureRoot, index);
  const context = {
    tempWorkspacePath: workspacePath,
    tempApplyDecision: "temp_apply_ready",
    tempWorkspaceCleanedUp: false,
    commands:
      fixture.commands === undefined
        ? [nodeCommand("default-pass", "process.exit(0)")]
        : fixture.commands,
    allowedExecutables: fixture.allowedExecutables ?? ["node"],
    ...(fixture.contextOverrides ?? {})
  };
  const result = verify(context);
  const issueCodes = result.issues.map((issue) => issue.code);
  const expectedIssueCodes = fixture.expectedIssueCodes ?? [];
  const passed =
    result.decision === fixture.expectedDecision &&
    expectedIssueCodes.every((code) => issueCodes.includes(code));

  return {
    caseId: fixture.caseId,
    expectedDecision: fixture.expectedDecision,
    actualDecision: result.decision,
    passed,
    issueCodes,
    commandCount: result.summary.totalCommands,
    passedCommands: result.summary.passedCommands,
    failedCommands: result.summary.failedCommands,
    timedOutCommands: result.summary.timedOutCommands,
    truncatedOutputs: result.summary.truncatedOutputs,
    durationMs: result.summary.durationMs,
    stdout: result.commandResults.map((commandResult) => commandResult.stdout),
    stderr: result.commandResults.map((commandResult) => commandResult.stderr)
  };
}

function buildReport(cases) {
  const passed = cases.filter((testCase) => testCase.passed).length;
  const tempValidationPassedCases = cases.filter(
    (testCase) => testCase.actualDecision === "temp_validation_passed"
  ).length;
  const tempValidationFailedCases = cases.filter(
    (testCase) => testCase.actualDecision === "temp_validation_failed"
  ).length;
  const tempValidationNeedsReviewCases = cases.filter(
    (testCase) => testCase.actualDecision === "temp_validation_needs_review"
  ).length;
  const allExpectedDecisionsObserved =
    tempValidationPassedCases > 0 &&
    tempValidationFailedCases > 0 &&
    tempValidationNeedsReviewCases > 0;

  return {
    suiteName: SUITE_NAME,
    ok: passed === cases.length && allExpectedDecisionsObserved,
    total: cases.length,
    passed,
    failed: cases.length - passed,
    tempValidationPassedCases,
    tempValidationFailedCases,
    tempValidationNeedsReviewCases,
    allExpectedDecisionsObserved,
    cases
  };
}

function escapeMarkdown(value) {
  return String(value).replace(/\|/g, "\\|");
}

function renderMarkdown(report) {
  const rows = report.cases.map((testCase) =>
    [
      testCase.caseId,
      testCase.expectedDecision,
      testCase.actualDecision,
      testCase.passed,
      testCase.issueCodes.join(", "),
      testCase.commandCount,
      testCase.passedCommands,
      testCase.failedCommands,
      testCase.timedOutCommands,
      testCase.truncatedOutputs,
      testCase.durationMs
    ]
      .map(escapeMarkdown)
      .join(" | ")
  );

  return [
    "# Temporary Workspace Execution Verifier Fixture Suite",
    "",
    `- Suite name: ${report.suiteName}`,
    `- OK: ${report.ok}`,
    `- Total: ${report.total}`,
    `- Passed: ${report.passed}`,
    `- Failed: ${report.failed}`,
    `- temp_validation_passed cases: ${report.tempValidationPassedCases}`,
    `- temp_validation_failed cases: ${report.tempValidationFailedCases}`,
    `- temp_validation_needs_review cases: ${report.tempValidationNeedsReviewCases}`,
    `- All expected decisions observed: ${report.allExpectedDecisionsObserved}`,
    "",
    "## Cases",
    "",
    "caseId | expected | actual | passed | issueCodes | commands | command passes | command failures | timeouts | truncations | durationMs",
    "--- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---",
    ...rows,
    ""
  ].join("\n");
}

function writeReport(report) {
  const reportDir = path.resolve(repoRoot, REPORT_DIR);
  fs.mkdirSync(reportDir, { recursive: true });
  const timestamp = safeTimestamp();
  const jsonPath = path.join(
    reportDir,
    `${timestamp}-temporary-workspace-execution-verifier-fixture-suite.json`
  );
  const markdownPath = path.join(
    reportDir,
    `${timestamp}-temporary-workspace-execution-verifier-fixture-suite.md`
  );
  const reportWithPaths = { ...report, jsonPath, markdownPath };

  fs.writeFileSync(jsonPath, JSON.stringify(reportWithPaths, null, 2));
  fs.writeFileSync(markdownPath, renderMarkdown(reportWithPaths));

  return reportWithPaths;
}

async function run() {
  const verifierPath = pathToFileURL(
    path.join(
      repoRoot,
      "dist",
      "packages",
      "product-runtime",
      "src",
      "temporary-workspace-execution-verifier.js"
    )
  );
  const { verifyTemporaryWorkspaceExecution } = await import(verifierPath.href);
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), FIXTURE_PREFIX));
  let cases;

  try {
    cases = fixtures.map((fixture, index) =>
      runFixture(fixture, fixtureRoot, index, verifyTemporaryWorkspaceExecution)
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }

  return writeReport(buildReport(cases));
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
  FIXTURE_PREFIX,
  SUITE_NAME,
  buildReport,
  fixtures,
  renderMarkdown,
  run
};
