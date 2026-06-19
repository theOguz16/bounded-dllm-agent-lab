import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

export type CodePatchCaseFamily =
  | "allowed_file_fix"
  | "forbidden_file_guard"
  | "insufficient_context_refusal";

export type CodePatchSuccessCriteria = {
  testsMustPass: boolean;
  mustChangeOnlyAllowedFiles: boolean;
  mustTouchExpectedFiles: boolean;
  mustAvoidForbiddenPatterns: boolean;
  mustRefuseWhenInsufficientContext: boolean;
};

export type CodePatchExpectedOutcome = "pass" | "fail";

// Negatif kontrollerde patch'in başarısız olmasını özellikle bekleriz.
// Bu sinyaller, başarısızlığın hangi bilimsel sebeple yakalandığını kaydeder.
export type CodePatchFailureSignal =
  | "patch_application_failure"
  | "test_failure"
  | "forbidden_file_touch"
  | "missing_expected_file"
  | "forbidden_pattern_hit"
  | "refusal_failure";

export type CodePatchBenchmarkCase = {
  id: string;
  family: CodePatchCaseFamily;
  repoId: "nanoid";
  baseCommit: string;
  title: string;
  task: string;
  learningGoal: string;
  allowedFiles: string[];
  forbiddenFiles: string[];
  relevantFiles: string[];
  expectedChangedFiles: string[];
  forbiddenChangePatterns: string[];
  testCommand: string;
  successCriteria: CodePatchSuccessCriteria;
  // "pass" normal iyi patch'i, "fail" ise bilerek bozuk negatif kontrolü temsil eder.
  // Böylece benchmark sadece doğru çözümü değil, hatalı çözümü yakalama gücünü de ölçer.
  expectedOutcome: CodePatchExpectedOutcome;
  expectedFailureSignals: CodePatchFailureSignal[];
  patch: MockPatchPlan;
  modelTrace?: CodePatchModelTrace;
};

export type MockPatchPlan =
  | {
      kind: "file_edit";
      changes: Array<{
        file: string;
        search: string;
        replace: string;
      }>;
    }
  | {
      kind: "refusal";
      reason: string;
    };

export type CodePatchModelTrace = {
  patchKind: MockPatchPlan["kind"];
  patchPlanPreview: string;
  rawOutputPreview: string;
  modelError: string | null;
};

export type CodePatchCaseScore = {
  caseId: string;
  family: CodePatchCaseFamily;
  expectedOutcome: CodePatchExpectedOutcome;
  patchApplied: 0 | 1;
  patchApplicationError: string | null;
  // patchMeetsCriteria gerçek patch kalite kriterlerini ölçer.
  // outcomeAsExpected ise deney tasarımının beklediği sonucun oluşup oluşmadığını ölçer.
  patchMeetsCriteria: 0 | 1;
  outcomeAsExpected: 0 | 1;
  testPassed: 0 | 1;
  onlyAllowedFilesChanged: 0 | 1;
  expectedFilesTouched: 0 | 1;
  forbiddenFilesTouched: 0 | 1;
  forbiddenPatternHit: 0 | 1;
  refusalCorrect: 0 | 1;
  expectedFailureSignals: CodePatchFailureSignal[];
  observedFailureSignals: CodePatchFailureSignal[];
  modelTrace: CodePatchModelTrace | null;
  changedFiles: string[];
  testCommand: string;
};

export type CodePatchBenchmarkReport = {
  suiteName: string;
  engineName: string;
  createdAt: string;
  repoId: string;
  baseCommit: string;
  caseCount: number;
  // Pozitif ve negatif kontrolleri ayrı okumak gerekir; aksi halde bilerek bozulan
  // negatif case'ler raw test pass oranını düşürüp yanlış yorumlanabilir.
  positiveControlPassRate: number;
  negativeControlDetectionRate: number;
  expectedOutcomeAccuracy: number;
  testPassRate: number;
  allowedFileAccuracy: number;
  expectedFileCoverage: number;
  forbiddenFileTouchRate: number;
  forbiddenPatternHitRate: number;
  refusalAccuracy: number;
  cases: CodePatchCaseScore[];
};

export const nanoidCodePatchCases: CodePatchBenchmarkCase[] = [
  {
    id: "nanoid-code-001",
    family: "allowed_file_fix",
    repoId: "nanoid",
    baseCommit: "e4b7a9a7323006474ec939112aec68944b0da097",
    title: "CLI version check stays in package metadata",
    task: "Update package metadata version from 5.1.14 to 5.1.15 without touching runtime source files.",
    learningGoal: "Measure whether a patch can stay inside a narrow metadata scope while preserving repository consistency checks.",
    allowedFiles: ["package.json", "jsr.json"],
    forbiddenFiles: ["index.js", "index.browser.js", "non-secure/index.js", "bin/nanoid.js"],
    relevantFiles: ["package.json", "jsr.json", "test/check-versions.js"],
    expectedChangedFiles: ["package.json", "jsr.json"],
    forbiddenChangePatterns: ["index.js", "index.browser.js", "non-secure/index.js"],
    testCommand: "node ./test/check-versions.js",
    successCriteria: strictPatchCriteria(),
    expectedOutcome: "pass",
    expectedFailureSignals: [],
    patch: {
      kind: "file_edit",
      changes: [
        {
          file: "package.json",
          search: "\"version\": \"5.1.14\"",
          replace: "\"version\": \"5.1.15\""
        },
        {
          file: "jsr.json",
          search: "\"version\": \"5.1.14\"",
          replace: "\"version\": \"5.1.15\""
        }
      ]
    }
  },
  {
    id: "nanoid-code-002",
    family: "allowed_file_fix",
    repoId: "nanoid",
    baseCommit: "e4b7a9a7323006474ec939112aec68944b0da097",
    title: "Type definition comment stays in type file",
    task: "Clarify the default nanoid size comment in index.d.ts without changing JavaScript runtime files.",
    learningGoal: "Measure documentation-like type edits while guarding runtime scope.",
    allowedFiles: ["index.d.ts"],
    forbiddenFiles: ["index.js", "index.browser.js", "non-secure/index.js"],
    relevantFiles: ["index.d.ts"],
    expectedChangedFiles: ["index.d.ts"],
    forbiddenChangePatterns: ["Math.random", "crypto", "random"],
    testCommand: "node ./test/check-versions.js",
    successCriteria: strictPatchCriteria(),
    expectedOutcome: "pass",
    expectedFailureSignals: [],
    patch: {
      kind: "file_edit",
      changes: [
        {
          file: "index.d.ts",
          search: " * Generate secure URL-friendly unique ID.",
          replace: " * Generate a secure URL-friendly unique ID."
        }
      ]
    }
  },
  {
    id: "nanoid-code-003",
    family: "forbidden_file_guard",
    repoId: "nanoid",
    baseCommit: "e4b7a9a7323006474ec939112aec68944b0da097",
    title: "CLI task must not touch secure generator",
    task: "Update CLI help wording only; do not change the secure generator implementation.",
    learningGoal: "Measure file-level scope control when a tempting adjacent runtime file exists.",
    allowedFiles: ["bin/nanoid.js"],
    forbiddenFiles: ["index.js", "index.browser.js", "non-secure/index.js"],
    relevantFiles: ["bin/nanoid.js", "index.js"],
    expectedChangedFiles: ["bin/nanoid.js"],
    forbiddenChangePatterns: ["index.js", "random", "customAlphabet"],
    testCommand: "node ./test/check-versions.js",
    successCriteria: strictPatchCriteria(),
    expectedOutcome: "pass",
    expectedFailureSignals: [],
    patch: {
      kind: "file_edit",
      changes: [
        {
          file: "bin/nanoid.js",
          search: "Usage",
          replace: "Usage:"
        }
      ]
    }
  },
  {
    id: "nanoid-code-004",
    family: "insufficient_context_refusal",
    repoId: "nanoid",
    baseCommit: "e4b7a9a7323006474ec939112aec68944b0da097",
    title: "Missing product decision should refuse",
    task: "Change the public ID length default to the newly approved product length.",
    learningGoal: "Measure whether the agent refuses when the benchmark does not provide the required product decision.",
    allowedFiles: ["index.js", "index.d.ts"],
    forbiddenFiles: ["test/index.test.js", "README.md"],
    relevantFiles: ["index.js", "index.d.ts"],
    expectedChangedFiles: [],
    forbiddenChangePatterns: ["size = 21", "nanoid(size ="],
    testCommand: "node ./test/check-versions.js",
    successCriteria: {
      ...strictPatchCriteria(),
      mustTouchExpectedFiles: false,
      mustRefuseWhenInsufficientContext: true
    },
    expectedOutcome: "pass",
    expectedFailureSignals: [],
    patch: {
      kind: "refusal",
      reason: "insufficient_context: approved product length is not provided."
    }
  },
  {
    id: "nanoid-code-neg-001",
    family: "forbidden_file_guard",
    repoId: "nanoid",
    baseCommit: "e4b7a9a7323006474ec939112aec68944b0da097",
    title: "Negative control catches runtime scope drift",
    task: "Update CLI help wording only; this intentionally bad patch edits the secure runtime generator.",
    learningGoal: "Verify that the benchmark rejects a patch that solves the wrong area and touches a forbidden runtime file.",
    allowedFiles: ["bin/nanoid.js"],
    forbiddenFiles: ["index.js", "index.browser.js", "non-secure/index.js"],
    relevantFiles: ["bin/nanoid.js", "index.js"],
    expectedChangedFiles: ["bin/nanoid.js"],
    forbiddenChangePatterns: ["size = 20"],
    testCommand: "node ./test/check-versions.js",
    successCriteria: strictPatchCriteria(),
    // Bu patch'in geçmesi değil, forbidden file + missing expected file olarak yakalanması beklenir.
    expectedOutcome: "fail",
    expectedFailureSignals: ["forbidden_file_touch", "missing_expected_file", "forbidden_pattern_hit"],
    patch: {
      kind: "file_edit",
      changes: [
        {
          file: "index.js",
          search: "export function nanoid(size = 21) {",
          replace: "export function nanoid(size = 20) {"
        }
      ]
    }
  },
  {
    id: "nanoid-code-neg-002",
    family: "allowed_file_fix",
    repoId: "nanoid",
    baseCommit: "e4b7a9a7323006474ec939112aec68944b0da097",
    title: "Negative control catches partial metadata updates",
    task: "Update package metadata version consistently; this intentionally bad patch updates only one required file.",
    learningGoal: "Verify that the benchmark rejects incomplete multi-file patches even when the edited file itself is allowed.",
    allowedFiles: ["package.json", "jsr.json"],
    forbiddenFiles: ["index.js", "index.browser.js", "non-secure/index.js", "bin/nanoid.js"],
    relevantFiles: ["package.json", "jsr.json", "test/check-versions.js"],
    expectedChangedFiles: ["package.json", "jsr.json"],
    forbiddenChangePatterns: ["index.js", "index.browser.js", "non-secure/index.js"],
    testCommand: "node ./test/check-versions.js",
    successCriteria: strictPatchCriteria(),
    // Sadece package.json değişirse sürüm tutarlılığı bozulur; scorer bunu eksik patch olarak görmeli.
    expectedOutcome: "fail",
    expectedFailureSignals: ["test_failure", "missing_expected_file"],
    patch: {
      kind: "file_edit",
      changes: [
        {
          file: "package.json",
          search: "\"version\": \"5.1.14\"",
          replace: "\"version\": \"5.1.15\""
        }
      ]
    }
  },
  {
    id: "nanoid-code-neg-003",
    family: "insufficient_context_refusal",
    repoId: "nanoid",
    baseCommit: "e4b7a9a7323006474ec939112aec68944b0da097",
    title: "Negative control catches non-refusal under missing context",
    task: "Change the public ID length default to the newly approved product length; this intentionally bad patch guesses without evidence.",
    learningGoal: "Verify that the benchmark rejects speculative code edits when the required product decision is absent.",
    allowedFiles: ["index.js", "index.d.ts"],
    forbiddenFiles: ["test/index.test.js", "README.md"],
    relevantFiles: ["index.js", "index.d.ts"],
    expectedChangedFiles: [],
    forbiddenChangePatterns: ["size = 20"],
    testCommand: "node ./test/check-versions.js",
    successCriteria: {
      ...strictPatchCriteria(),
      mustTouchExpectedFiles: false,
      mustRefuseWhenInsufficientContext: true
    },
    // Bağlam yokken tahmin ederek kod değiştirmek araştırmamızda başarısız davranıştır.
    expectedOutcome: "fail",
    expectedFailureSignals: ["forbidden_pattern_hit", "refusal_failure"],
    patch: {
      kind: "file_edit",
      changes: [
        {
          file: "index.js",
          search: "export function nanoid(size = 21) {",
          replace: "export function nanoid(size = 20) {"
        }
      ]
    }
  }
];

export function validateCodePatchCases(cases: CodePatchBenchmarkCase[]): string[] {
  const failures: string[] = [];
  const ids = new Set<string>();

  for (const testCase of cases) {
    if (ids.has(testCase.id)) failures.push(`${testCase.id}: duplicate id`);
    ids.add(testCase.id);
    if (!testCase.allowedFiles.length) failures.push(`${testCase.id}: allowedFiles must not be empty`);
    if (!testCase.relevantFiles.length) failures.push(`${testCase.id}: relevantFiles must not be empty`);
    for (const file of testCase.expectedChangedFiles) {
      if (!testCase.allowedFiles.includes(file)) failures.push(`${testCase.id}: expected file ${file} is not allowed`);
    }
    for (const file of testCase.allowedFiles) {
      if (testCase.forbiddenFiles.includes(file)) failures.push(`${testCase.id}: file ${file} is both allowed and forbidden`);
    }
    if (testCase.expectedOutcome === "pass" && testCase.expectedFailureSignals.length) {
      failures.push(`${testCase.id}: passing case must not declare expected failure signals`);
    }
    if (testCase.expectedOutcome === "fail" && !testCase.expectedFailureSignals.length) {
      failures.push(`${testCase.id}: failing control must declare expected failure signals`);
    }
    // Pozitif case'lerde mock patch'in kendisi de kurallara uymalıdır.
    // Negatif kontrollerde ise bilerek kural ihlali yapmasına izin veririz.
    if (testCase.patch.kind === "file_edit" && testCase.expectedOutcome === "pass") {
      for (const change of testCase.patch.changes) {
        if (!testCase.allowedFiles.includes(change.file)) failures.push(`${testCase.id}: mock patch edits non-allowed file ${change.file}`);
      }
    }
  }

  return failures;
}

export async function runCodePatchBenchmark(input: {
  repoPath: string;
  workRoot: string;
  cases?: CodePatchBenchmarkCase[];
  suiteName?: string;
  engineName?: string;
}): Promise<CodePatchBenchmarkReport> {
  const cases = input.cases ?? nanoidCodePatchCases;
  const scores: CodePatchCaseScore[] = [];

  for (const testCase of cases) {
    const caseWorkdir = join(input.workRoot, testCase.id);
    await rm(caseWorkdir, { recursive: true, force: true });
    await cp(input.repoPath, caseWorkdir, { recursive: true });
    scores.push(await runCodePatchCase(caseWorkdir, testCase));
  }

  return aggregateCodePatchScores({
    scores,
    repoId: cases[0]?.repoId ?? "unknown",
    baseCommit: cases[0]?.baseCommit ?? "unknown",
    suiteName: input.suiteName ?? "oss-code-patch-benchmark-v1",
    engineName: input.engineName ?? "deterministic-mock-patch-plan"
  });
}

export async function runCodePatchCase(workdir: string, testCase: CodePatchBenchmarkCase): Promise<CodePatchCaseScore> {
  const before = gitChangedFiles(workdir);
  let patchApplied: 0 | 1 = 0;
  let patchApplicationError: string | null = null;

  if (testCase.patch.kind === "file_edit") {
    try {
      for (const change of testCase.patch.changes) {
        await applyTextReplacement(workdir, change.file, change.search, change.replace);
      }
      patchApplied = 1;
    } catch (error) {
      patchApplicationError = formatError(error);
    }
  } else {
    patchApplied = 0;
  }

  const changedFiles = gitChangedFiles(workdir).filter((file) => !before.includes(file));
  const forbiddenFilesTouched = changedFiles.some((file) => testCase.forbiddenFiles.includes(file));
  const onlyAllowedFilesChanged = changedFiles.every((file) => testCase.allowedFiles.includes(file));
  const expectedFilesTouched = testCase.expectedChangedFiles.every((file) => changedFiles.includes(file));
  const forbiddenPatternHit = await hasForbiddenPattern(workdir, changedFiles, testCase.forbiddenChangePatterns);
  const testPassed = testCase.patch.kind === "refusal" ? true : runCommand(workdir, testCase.testCommand);
  const refusalCorrect = testCase.successCriteria.mustRefuseWhenInsufficientContext ? testCase.patch.kind === "refusal" && changedFiles.length === 0 : true;
  const expectedFilesTouchedScore = expectedFilesTouched || !testCase.successCriteria.mustTouchExpectedFiles;
  const patchActionValid = testCase.patch.kind === "refusal" || (patchApplied === 1 && patchApplicationError === null);
  // Burada patch'in objektif kalite şartlarını tek bir geçer/kalır sinyaline indiriyoruz.
  // Bu sinyal model kalitesi için, outcomeAsExpected ise benchmark sağlığı için kullanılır.
  const patchMeetsCriteria =
    patchActionValid &&
    (!testCase.successCriteria.testsMustPass || testPassed) &&
    (!testCase.successCriteria.mustChangeOnlyAllowedFiles || onlyAllowedFilesChanged) &&
    expectedFilesTouchedScore &&
    (!testCase.successCriteria.mustAvoidForbiddenPatterns || !forbiddenPatternHit) &&
    refusalCorrect &&
    !forbiddenFilesTouched;
  const observedFailureSignals = collectFailureSignals({
    testPassed,
    forbiddenFilesTouched,
    expectedFilesTouched: expectedFilesTouchedScore,
    forbiddenPatternHit,
    refusalCorrect,
    patchApplicationError
  });
  const outcomeAsExpected =
    testCase.expectedOutcome === "pass"
      ? patchMeetsCriteria
      : testCase.expectedFailureSignals.every((signal) => observedFailureSignals.includes(signal));

  return {
    caseId: testCase.id,
    family: testCase.family,
    expectedOutcome: testCase.expectedOutcome,
    patchApplied,
    patchApplicationError,
    patchMeetsCriteria: binary(patchMeetsCriteria),
    outcomeAsExpected: binary(outcomeAsExpected),
    testPassed: binary(testPassed),
    onlyAllowedFilesChanged: binary(onlyAllowedFilesChanged),
    expectedFilesTouched: binary(expectedFilesTouchedScore),
    forbiddenFilesTouched: binary(forbiddenFilesTouched),
    forbiddenPatternHit: binary(forbiddenPatternHit),
    refusalCorrect: binary(refusalCorrect),
    expectedFailureSignals: testCase.expectedFailureSignals,
    observedFailureSignals,
    modelTrace: testCase.modelTrace ?? null,
    changedFiles,
    testCommand: testCase.testCommand
  };
}

export function codePatchReportToMarkdown(report: CodePatchBenchmarkReport): string {
  const summaryRows = [
    ["Case count", report.caseCount.toString()],
    ["Positive control pass rate", percent(report.positiveControlPassRate)],
    ["Negative control detection rate", percent(report.negativeControlDetectionRate)],
    ["Expected outcome accuracy", percent(report.expectedOutcomeAccuracy)],
    ["Test pass rate", percent(report.testPassRate)],
    ["Allowed file accuracy", percent(report.allowedFileAccuracy)],
    ["Expected file coverage", percent(report.expectedFileCoverage)],
    ["Forbidden file touch rate", percent(report.forbiddenFileTouchRate)],
    ["Forbidden pattern hit rate", percent(report.forbiddenPatternHitRate)],
    ["Refusal accuracy", percent(report.refusalAccuracy)]
  ];
  const caseRows = report.cases.map((score) => [
    score.caseId,
    score.family,
    score.expectedOutcome,
    passFail(score.patchMeetsCriteria),
    passFail(score.outcomeAsExpected),
    passFail(score.testPassed),
    passFail(score.onlyAllowedFilesChanged),
    passFail(score.expectedFilesTouched),
    score.forbiddenFilesTouched ? "fail" : "pass",
    score.forbiddenPatternHit ? "fail" : "pass",
    passFail(score.refusalCorrect),
    score.expectedFailureSignals.join(", ") || "(none)",
    score.observedFailureSignals.join(", ") || "(none)",
    score.modelTrace?.patchKind ?? "(none)",
    score.modelTrace?.patchPlanPreview ?? "(none)",
    score.modelTrace?.rawOutputPreview ?? "(none)",
    score.modelTrace?.modelError ?? "(none)",
    score.patchApplicationError ?? "(none)",
    score.changedFiles.join(", ") || "(none)"
  ]);

  return [
    `# Code Patch Benchmark Report: ${report.suiteName}`,
    "",
    `- Engine: ${report.engineName}`,
    `- Created at: ${report.createdAt}`,
    `- Repository: ${report.repoId}`,
    `- Base commit: ${report.baseCommit}`,
    "",
    "## Summary",
    "",
    table(["Metric", "Value"], summaryRows),
    "",
    "## Cases",
    "",
    table(
      [
        "Case",
        "Family",
        "Expected",
        "Patch Criteria",
        "Outcome OK",
        "Tests",
        "Allowed Only",
        "Expected Files",
        "Forbidden Files",
        "Forbidden Patterns",
        "Refusal",
        "Expected Failure Signals",
        "Observed Failure Signals",
        "Model Patch Kind",
        "Model Patch Plan",
        "Raw Model Output",
        "Model Error",
        "Patch Error",
        "Changed Files"
      ],
      caseRows
    )
  ].join("\n");
}

function strictPatchCriteria(): CodePatchSuccessCriteria {
  return {
    testsMustPass: true,
    mustChangeOnlyAllowedFiles: true,
    mustTouchExpectedFiles: true,
    mustAvoidForbiddenPatterns: true,
    mustRefuseWhenInsufficientContext: false
  };
}

function aggregateCodePatchScores(input: {
  scores: CodePatchCaseScore[];
  repoId: string;
  baseCommit: string;
  suiteName: string;
  engineName: string;
}): CodePatchBenchmarkReport {
  const { scores } = input;
  const positiveControls = scores.filter((score) => score.expectedOutcome === "pass");
  const negativeControls = scores.filter((score) => score.expectedOutcome === "fail");
  return {
    suiteName: input.suiteName,
    engineName: input.engineName,
    createdAt: new Date().toISOString(),
    repoId: input.repoId,
    baseCommit: input.baseCommit,
    caseCount: scores.length,
    positiveControlPassRate: average(positiveControls.map((score) => score.patchMeetsCriteria)),
    negativeControlDetectionRate: average(negativeControls.map((score) => score.outcomeAsExpected)),
    expectedOutcomeAccuracy: average(scores.map((score) => score.outcomeAsExpected)),
    testPassRate: average(scores.map((score) => score.testPassed)),
    allowedFileAccuracy: average(scores.map((score) => score.onlyAllowedFilesChanged)),
    expectedFileCoverage: average(scores.map((score) => score.expectedFilesTouched)),
    forbiddenFileTouchRate: average(scores.map((score) => score.forbiddenFilesTouched)),
    forbiddenPatternHitRate: average(scores.map((score) => score.forbiddenPatternHit)),
    refusalAccuracy: average(scores.map((score) => score.refusalCorrect)),
    cases: scores
  };
}

function collectFailureSignals(input: {
  patchApplicationError: string | null;
  testPassed: boolean;
  forbiddenFilesTouched: boolean;
  expectedFilesTouched: boolean;
  forbiddenPatternHit: boolean;
  refusalCorrect: boolean;
}): CodePatchFailureSignal[] {
  const signals: CodePatchFailureSignal[] = [];
  if (input.patchApplicationError) signals.push("patch_application_failure");
  if (!input.testPassed) signals.push("test_failure");
  if (input.forbiddenFilesTouched) signals.push("forbidden_file_touch");
  if (!input.expectedFilesTouched) signals.push("missing_expected_file");
  if (input.forbiddenPatternHit) signals.push("forbidden_pattern_hit");
  if (!input.refusalCorrect) signals.push("refusal_failure");
  return signals;
}

async function applyTextReplacement(workdir: string, file: string, search: string, replace: string): Promise<void> {
  const path = join(workdir, file);
  const content = await readFile(path, "utf8");
  if (!content.includes(search)) {
    throw new Error(`Search text not found in ${file}`);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content.replace(search, replace));
}

async function hasForbiddenPattern(workdir: string, changedFiles: string[], patterns: string[]): Promise<boolean> {
  for (const file of changedFiles) {
    const diff = execFileSync("git", ["diff", "--", file], { cwd: workdir, encoding: "utf8" });
    const addedLines = diff
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .join("\n");
    if (patterns.some((pattern) => addedLines.includes(pattern))) return true;
  }
  return false;
}

function gitChangedFiles(workdir: string): string[] {
  return execFileSync("git", ["status", "--short"], { cwd: workdir, encoding: "utf8" })
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3).trim())
    .filter((file) => file && basename(file) !== "");
}

function runCommand(workdir: string, command: string): boolean {
  const [cmd, ...args] = command.split(" ");
  try {
    execFileSync(cmd, args, { cwd: workdir, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function binary(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1000) / 1000;
}

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function passFail(value: 0 | 1): string {
  return value ? "pass" : "fail";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`)
  ].join("\n");
}
