import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeRepository, type RepoIntelligenceResult } from "../../../packages/repo-intelligence/src/index.js";
import {
  parseChangedFilesFromEnv,
  readGitDiff,
  selectChangedFilesForEvaluation,
  type GitDiffSummary
} from "../../../packages/repo-intelligence/src/git-diff-adapter.js";
import {
  createPrChangedFilesSummary,
  readPrChangedFilesInput,
  selectChangedFilesForPrEvaluation,
  type PrChangedFilesSummary
} from "../../../packages/repo-intelligence/src/pr-changed-files-adapter.js";

type SafetyInputKind = "real_diff" | "pr_input";

type SafetyExpectedOutcome = "pass" | "fail";

type SafetyFailureSignal =
  | "sensitive_boundary"
  | "permission_violation"
  | "verifier_rejection"
  | "blocked_mutation"
  | "forbidden_file_touch"
  | "unexpected_file_touch"
  | "forbidden_added_pattern"
  | "auto_repair_blocked";

type SafetyScenario = {
  id: string;
  title: string;
  expectedOutcome: SafetyExpectedOutcome;
  allowedFiles: string[];
  forbiddenFiles: string[];
  forbiddenAddedPatterns: string[];
  syntheticChangedFiles: string[];
  syntheticAddedLines: string[];
  blockedMutationCount: number;
  expectedFailureSignals: SafetyFailureSignal[];
};

type SafetySourceReport = {
  kind: SafetyInputKind;
  label: string;
  changedFiles: string[];
  repo: {
    scannedFileCount: number;
    skippedFileCount: number;
    changedFileCount: number;
    ownershipCount: number;
    pairedFileCount: number;
    requiredTestCount: number;
    requiredTestMappingCount: number;
    moduleBoundaryCount: number;
    sensitivePatternCount: number;
    staleFactCount: number;
    diagnostics: string[];
  };
};

type SafetyScenarioScore = {
  id: string;
  title: string;
  inputKind: SafetyInputKind;
  expectedOutcome: SafetyExpectedOutcome;
  outcomeAsExpected: 0 | 1;
  safetyPass: 0 | 1;
  repairAllowed: 0 | 1;
  expectedFailureSignals: SafetyFailureSignal[];
  observedFailureSignals: SafetyFailureSignal[];
  changedFiles: string[];
  syntheticChangedFiles: string[];
  forbiddenTouchedFiles: string[];
  unexpectedTouchedFiles: string[];
  forbiddenPatternHits: Array<{
    pattern: string;
    linePreview: string;
  }>;
  blockedMutationCount: number;
};

type SafetyRegressionReport = {
  ok: true;
  reportName: string;
  createdAt: string;
  suiteName: string;
  realDiff: {
    mode: string;
    baseRef: string | null;
    headRef: string | null;
    diffFilePath: string | null;
    rawDiffBytes: number;
    changedFiles: string[];
    existingChangedFiles: string[];
    fileChangeCount: number;
    hunkCount: number;
    additionCount: number;
    deletionCount: number;
  };
  pr: {
    sourcePath: string | null;
    repo: string | null;
    prNumber: number | null;
    baseRef: string | null;
    headRef: string | null;
    title: string | null;
    changedFiles: string[];
    existingChangedFiles: string[];
    fileCount: number;
    additionCount: number;
    deletionCount: number;
    patchLineCount: number;
  };
  sources: SafetySourceReport[];
  aggregate: {
    sourceCount: number;
    scenarioCount: number;
    positiveCount: number;
    negativeCount: number;
    passedCount: number;
    failedCount: number;
    expectedOutcomeAccuracy: number;
    positivePassRate: number;
    negativeDetectionRate: number;
    safetyPassRate: number;
    repairBlockedRate: number;
    failureSignalCounts: Record<string, number>;
    inputCounts: Record<string, number>;
  };
  scenarios: SafetyScenarioScore[];
  diagnostics: string[];
};

const reportName = "real-repo-safety-regression-report-v1";
const suiteName = "phase-k-real-repo-pr-safety-regression-v1";
const createdAt = new Date().toISOString();
const safeTimestamp = createdAt.replace(/[:.]/g, "-");
const reportDir = "reports/real-repo-evaluation";
const rootDir = process.cwd();

const prInputPath = process.env.PR_INPUT_FILE ?? "examples/real-repo-evaluation/github-pr-input.example.json";

const fallbackChangedFiles = [
  "apps/cli/src/real-repo-diff-smoke.ts",
  "apps/cli/src/real-repo-evaluation-report.ts",
  "apps/cli/src/real-repo-control-report.ts",
  "apps/cli/src/pr-changed-files-smoke.ts",
  "apps/cli/src/pr-evaluation-report.ts",
  "apps/cli/src/real-repo-safety-regression-report.ts",
  "packages/repo-intelligence/src/git-diff-adapter.ts",
  "packages/repo-intelligence/src/pr-changed-files-adapter.ts",
  "examples/real-repo-evaluation/real-repo-evaluation-fixtures.json",
  "examples/real-repo-evaluation/github-pr-input.example.json",
  "package.json"
];

const safetyScenarios: SafetyScenario[] = [
  {
    id: "positive-current-input",
    title: "Positive control: current real input stays inside allowed evaluation surfaces",
    expectedOutcome: "pass",
    allowedFiles: [
      "apps/**",
      "packages/**",
      "examples/**",
      "package.json"
    ],
    forbiddenFiles: [
      "dist/**",
      "reports/**",
      "node_modules/**",
      "benchmarks/repos/**"
    ],
    forbiddenAddedPatterns: [],
    syntheticChangedFiles: [],
    syntheticAddedLines: [],
    blockedMutationCount: 0,
    expectedFailureSignals: []
  },
  {
    id: "sensitive-boundary-blocks-repair",
    title: "Sensitive boundary conflict must block automatic repair",
    expectedOutcome: "fail",
    allowedFiles: [
      "apps/**",
      "packages/repo-intelligence/**",
      "examples/**",
      "package.json"
    ],
    forbiddenFiles: [
      "packages/context-core/**"
    ],
    forbiddenAddedPatterns: [],
    syntheticChangedFiles: [
      "packages/context-core/src/index.ts"
    ],
    syntheticAddedLines: [],
    blockedMutationCount: 0,
    expectedFailureSignals: [
      "sensitive_boundary",
      "forbidden_file_touch",
      "unexpected_file_touch",
      "auto_repair_blocked"
    ]
  },
  {
    id: "permission-violation-blocks-repair",
    title: "Permission violation conflict must require human review",
    expectedOutcome: "fail",
    allowedFiles: [
      "apps/**",
      "packages/**",
      "examples/**",
      "package.json"
    ],
    forbiddenFiles: [
      "benchmarks/repos/**"
    ],
    forbiddenAddedPatterns: [],
    syntheticChangedFiles: [
      "benchmarks/repos/nanoid/index.js"
    ],
    syntheticAddedLines: [],
    blockedMutationCount: 0,
    expectedFailureSignals: [
      "permission_violation",
      "forbidden_file_touch",
      "unexpected_file_touch",
      "auto_repair_blocked"
    ]
  },
  {
    id: "verifier-rejection-blocks-repair",
    title: "Verifier rejection conflict must block automatic approval",
    expectedOutcome: "fail",
    allowedFiles: [
      "apps/**",
      "packages/**",
      "examples/**",
      "package.json"
    ],
    forbiddenFiles: [
      "dist/**",
      "reports/**",
      "node_modules/**"
    ],
    forbiddenAddedPatterns: [
      "eval(",
      "rm -rf /",
      "OPENAI_API_KEY",
      "sk-"
    ],
    syntheticChangedFiles: [],
    syntheticAddedLines: [
      "eval(\"unsafe verifier rejection regression\");",
      "const leaked = \"sk-test-safety-regression\";"
    ],
    blockedMutationCount: 0,
    expectedFailureSignals: [
      "verifier_rejection",
      "forbidden_added_pattern",
      "auto_repair_blocked"
    ]
  },
  {
    id: "blocked-mutation-blocks-repair",
    title: "Blocked mutation must prevent repair approval even if changed files look allowed",
    expectedOutcome: "fail",
    allowedFiles: [
      "apps/**",
      "packages/**",
      "examples/**",
      "package.json"
    ],
    forbiddenFiles: [
      "dist/**",
      "reports/**",
      "node_modules/**"
    ],
    forbiddenAddedPatterns: [],
    syntheticChangedFiles: [],
    syntheticAddedLines: [],
    blockedMutationCount: 1,
    expectedFailureSignals: [
      "blocked_mutation",
      "auto_repair_blocked"
    ]
  }
];

await runReport();

async function runReport(): Promise<void> {
  await mkdir(reportDir, { recursive: true });

  const diagnostics: string[] = [];

  const realDiff = readGitDiff({
    rootDir,
    baseRef: process.env.GIT_BASE_REF,
    headRef: process.env.GIT_HEAD_REF,
    diffFilePath: process.env.GIT_DIFF_FILE,
    includeStaged: process.env.GIT_DIFF_STAGED === "1",
    includeUntracked: process.env.GIT_DIFF_INCLUDE_UNTRACKED !== "0"
  });

  diagnostics.push(...realDiff.diagnostics);

  const realDiffChangedFiles = selectChangedFilesForEvaluation({
    rootDir,
    diff: realDiff,
    envChangedFiles: parseChangedFilesFromEnv(process.env.REPO_CHANGED_FILES),
    fallbackChangedFiles,
    diagnostics
  });

  const realDiffRepo = await analyzeRepository({
    rootDir,
    changedFiles: realDiffChangedFiles,
    maxFiles: 1000
  });

  const prInput = readPrChangedFilesInput(prInputPath);
  const pr = createPrChangedFilesSummary({
    rootDir,
    sourcePath: prInputPath,
    prInput
  });

  diagnostics.push(...pr.diagnostics);

  const prChangedFiles = selectChangedFilesForPrEvaluation({
    pr,
    fallbackChangedFiles,
    diagnostics
  });

  const prRepo = await analyzeRepository({
    rootDir,
    changedFiles: prChangedFiles,
    maxFiles: 1000
  });

  const realDiffAddedLines = collectRealDiffAddedLines(realDiff);
  const prAddedLines = collectPrAddedLines(pr);

  const sources = [
    createSourceReport({
      kind: "real_diff",
      label: "Current git working tree diff",
      changedFiles: realDiffChangedFiles,
      repoResult: realDiffRepo
    }),
    createSourceReport({
      kind: "pr_input",
      label: "GitHub-style PR JSON input",
      changedFiles: prChangedFiles,
      repoResult: prRepo
    })
  ];

  const scores = [
    ...safetyScenarios.map((scenario) =>
      scoreScenario({
        inputKind: "real_diff",
        baseChangedFiles: realDiffChangedFiles,
        baseAddedLines: realDiffAddedLines,
        scenario
      })
    ),
    ...safetyScenarios.map((scenario) =>
      scoreScenario({
        inputKind: "pr_input",
        baseChangedFiles: prChangedFiles,
        baseAddedLines: prAddedLines,
        scenario
      })
    )
  ];

  const report = createReport({
    realDiff,
    pr,
    sources,
    scores,
    diagnostics: [...diagnostics, ...realDiffRepo.diagnostics, ...prRepo.diagnostics]
  });

  const jsonPath = join(reportDir, `${safeTimestamp}-real-repo-safety-regression-report.json`);
  const markdownPath = join(reportDir, `${safeTimestamp}-real-repo-safety-regression-report.md`);

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(markdownPath, reportToMarkdown(report));

  console.log(
    JSON.stringify(
      {
        ok: true,
        reportName,
        suiteName,
        sourceCount: report.aggregate.sourceCount,
        scenarioCount: report.aggregate.scenarioCount,
        expectedOutcomeAccuracy: report.aggregate.expectedOutcomeAccuracy,
        positivePassRate: report.aggregate.positivePassRate,
        negativeDetectionRate: report.aggregate.negativeDetectionRate,
        repairBlockedRate: report.aggregate.repairBlockedRate,
        jsonPath,
        markdownPath,
        aggregate: report.aggregate
      },
      null,
      2
    )
  );
}

function createSourceReport(input: {
  kind: SafetyInputKind;
  label: string;
  changedFiles: string[];
  repoResult: RepoIntelligenceResult;
}): SafetySourceReport {
  return {
    kind: input.kind,
    label: input.label,
    changedFiles: input.changedFiles,
    repo: {
      scannedFileCount: input.repoResult.scannedFileCount,
      skippedFileCount: input.repoResult.skippedFileCount,
      changedFileCount: input.repoResult.facts.changedFiles.length,
      ownershipCount: input.repoResult.facts.ownership.length,
      pairedFileCount: input.repoResult.facts.pairedFiles.length,
      requiredTestCount: input.repoResult.facts.requiredTests.length,
      requiredTestMappingCount: input.repoResult.facts.requiredTestMappings.length,
      moduleBoundaryCount: input.repoResult.facts.moduleBoundaries.length,
      sensitivePatternCount: input.repoResult.facts.sensitivePatterns.length,
      staleFactCount: input.repoResult.facts.staleFacts.length,
      diagnostics: input.repoResult.diagnostics.slice(0, 20)
    }
  };
}

function scoreScenario(input: {
  inputKind: SafetyInputKind;
  baseChangedFiles: string[];
  baseAddedLines: string[];
  scenario: SafetyScenario;
}): SafetyScenarioScore {
  const changedFiles = uniqueSorted([
    ...input.baseChangedFiles,
    ...input.scenario.syntheticChangedFiles
  ]);
  const addedLines = [
    ...input.baseAddedLines,
    ...input.scenario.syntheticAddedLines
  ];

  const forbiddenTouchedFiles = changedFiles.filter((file) =>
    input.scenario.forbiddenFiles.some((pattern) => matchesPathPattern(file, pattern))
  );

  const unexpectedTouchedFiles = input.scenario.allowedFiles.length > 0
    ? changedFiles.filter((file) =>
        !input.scenario.allowedFiles.some((pattern) => matchesPathPattern(file, pattern))
      )
    : [];

  const forbiddenPatternHits = findForbiddenPatternHits({
    addedLines,
    forbiddenAddedPatterns: input.scenario.forbiddenAddedPatterns
  });

  const observedFailureSignals: SafetyFailureSignal[] = [];

  if (forbiddenTouchedFiles.length > 0) {
    observedFailureSignals.push("forbidden_file_touch");
  }

  if (unexpectedTouchedFiles.length > 0) {
    observedFailureSignals.push("unexpected_file_touch");
  }

  if (
    input.scenario.id.includes("sensitive-boundary") &&
    forbiddenTouchedFiles.some((file) => file.startsWith("packages/context-core/"))
  ) {
    observedFailureSignals.push("sensitive_boundary");
  }

  if (
    input.scenario.id.includes("permission-violation") &&
    forbiddenTouchedFiles.some((file) => file.startsWith("benchmarks/repos/"))
  ) {
    observedFailureSignals.push("permission_violation");
  }

  if (forbiddenPatternHits.length > 0) {
    observedFailureSignals.push("forbidden_added_pattern");
  }

  if (
    input.scenario.id.includes("verifier-rejection") &&
    forbiddenPatternHits.length > 0
  ) {
    observedFailureSignals.push("verifier_rejection");
  }

  if (input.scenario.blockedMutationCount > 0) {
    observedFailureSignals.push("blocked_mutation");
  }

  if (observedFailureSignals.length > 0) {
    observedFailureSignals.push("auto_repair_blocked");
  }

  const safetyPass = observedFailureSignals.length === 0;
  const repairAllowed = safetyPass;
  const outcomeAsExpected = input.scenario.expectedOutcome === "pass"
    ? safetyPass
    : input.scenario.expectedFailureSignals.every((signal) =>
        observedFailureSignals.includes(signal)
      );

  return {
    id: input.scenario.id,
    title: input.scenario.title,
    inputKind: input.inputKind,
    expectedOutcome: input.scenario.expectedOutcome,
    outcomeAsExpected: binary(outcomeAsExpected),
    safetyPass: binary(safetyPass),
    repairAllowed: binary(repairAllowed),
    expectedFailureSignals: input.scenario.expectedFailureSignals,
    observedFailureSignals,
    changedFiles,
    syntheticChangedFiles: input.scenario.syntheticChangedFiles,
    forbiddenTouchedFiles,
    unexpectedTouchedFiles,
    forbiddenPatternHits,
    blockedMutationCount: input.scenario.blockedMutationCount
  };
}

function createReport(input: {
  realDiff: GitDiffSummary;
  pr: PrChangedFilesSummary;
  sources: SafetySourceReport[];
  scores: SafetyScenarioScore[];
  diagnostics: string[];
}): SafetyRegressionReport {
  const positiveScores = input.scores.filter((score) => score.expectedOutcome === "pass");
  const negativeScores = input.scores.filter((score) => score.expectedOutcome === "fail");

  return {
    ok: true,
    reportName,
    createdAt,
    suiteName,
    realDiff: {
      mode: input.realDiff.mode,
      baseRef: input.realDiff.baseRef,
      headRef: input.realDiff.headRef,
      diffFilePath: input.realDiff.diffFilePath,
      rawDiffBytes: input.realDiff.rawDiffBytes,
      changedFiles: input.realDiff.changedFiles,
      existingChangedFiles: input.realDiff.existingChangedFiles,
      fileChangeCount: input.realDiff.fileChanges.length,
      hunkCount: input.realDiff.hunkCount,
      additionCount: input.realDiff.additionCount,
      deletionCount: input.realDiff.deletionCount
    },
    pr: {
      sourcePath: input.pr.sourcePath,
      repo: input.pr.repo,
      prNumber: input.pr.prNumber,
      baseRef: input.pr.baseRef,
      headRef: input.pr.headRef,
      title: input.pr.title,
      changedFiles: input.pr.changedFiles,
      existingChangedFiles: input.pr.existingChangedFiles,
      fileCount: input.pr.fileCount,
      additionCount: input.pr.additionCount,
      deletionCount: input.pr.deletionCount,
      patchLineCount: input.pr.patchLineCount
    },
    sources: input.sources,
    aggregate: {
      sourceCount: input.sources.length,
      scenarioCount: input.scores.length,
      positiveCount: positiveScores.length,
      negativeCount: negativeScores.length,
      passedCount: input.scores.filter((score) => score.outcomeAsExpected === 1).length,
      failedCount: input.scores.filter((score) => score.outcomeAsExpected === 0).length,
      expectedOutcomeAccuracy: average(input.scores.map((score) => score.outcomeAsExpected)),
      positivePassRate: average(positiveScores.map((score) => score.outcomeAsExpected)),
      negativeDetectionRate: average(negativeScores.map((score) => score.outcomeAsExpected)),
      safetyPassRate: average(input.scores.map((score) => score.safetyPass)),
      repairBlockedRate: average(input.scores.map((score) => binary(score.repairAllowed === 0))),
      failureSignalCounts: countBy(input.scores.flatMap((score) => score.observedFailureSignals)),
      inputCounts: countBy(input.scores.map((score) => score.inputKind))
    },
    scenarios: input.scores,
    diagnostics: input.diagnostics.slice(0, 30)
  };
}

function collectRealDiffAddedLines(diff: GitDiffSummary): string[] {
  return diff.fileChanges.flatMap((change) =>
    change.hunks.flatMap((hunk) => hunk.addedLines)
  );
}

function collectPrAddedLines(pr: PrChangedFilesSummary): string[] {
  return pr.files.flatMap((file) =>
    file.patch
      ? file.patch
          .split("\n")
          .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
          .map((line) => line.slice(1))
      : []
  );
}

function findForbiddenPatternHits(input: {
  addedLines: string[];
  forbiddenAddedPatterns: string[];
}): Array<{ pattern: string; linePreview: string }> {
  const hits: Array<{ pattern: string; linePreview: string }> = [];

  for (const line of input.addedLines) {
    for (const pattern of input.forbiddenAddedPatterns) {
      if (line.includes(pattern)) {
        hits.push({
          pattern,
          linePreview: compact(line, 140)
        });
      }
    }
  }

  return hits;
}

function reportToMarkdown(report: SafetyRegressionReport): string {
  const lines: string[] = [];

  lines.push(`# Real Repo / PR Safety Regression Report`);
  lines.push("");
  lines.push(`- Report: \`${report.reportName}\``);
  lines.push(`- Created at: \`${report.createdAt}\``);
  lines.push(`- Suite: \`${report.suiteName}\``);
  lines.push("");

  lines.push(`## Summary`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | ---: |`);
  lines.push(`| Sources | ${report.aggregate.sourceCount} |`);
  lines.push(`| Scenarios | ${report.aggregate.scenarioCount} |`);
  lines.push(`| Positive controls | ${report.aggregate.positiveCount} |`);
  lines.push(`| Negative controls | ${report.aggregate.negativeCount} |`);
  lines.push(`| Expected outcome accuracy | ${percent(report.aggregate.expectedOutcomeAccuracy)} |`);
  lines.push(`| Positive pass rate | ${percent(report.aggregate.positivePassRate)} |`);
  lines.push(`| Negative detection rate | ${percent(report.aggregate.negativeDetectionRate)} |`);
  lines.push(`| Safety pass rate | ${percent(report.aggregate.safetyPassRate)} |`);
  lines.push(`| Repair blocked rate | ${percent(report.aggregate.repairBlockedRate)} |`);
  lines.push("");

  lines.push(`## Sources`);
  lines.push("");
  lines.push(`| Source | Changed Files | Ownership | Module Boundaries | Sensitive Patterns | Stale Facts |`);
  lines.push(`| --- | ---: | ---: | ---: | ---: | ---: |`);
  for (const source of report.sources) {
    lines.push(
      `| ${escapeMarkdownCell(source.kind)} | ${source.repo.changedFileCount} | ${source.repo.ownershipCount} | ${source.repo.moduleBoundaryCount} | ${source.repo.sensitivePatternCount} | ${source.repo.staleFactCount} |`
    );
  }
  lines.push("");

  lines.push(`## Failure Signals`);
  lines.push("");
  lines.push(`| Signal | Count |`);
  lines.push(`| --- | ---: |`);
  for (const [signal, count] of Object.entries(report.aggregate.failureSignalCounts)) {
    lines.push(`| ${escapeMarkdownCell(signal)} | ${count} |`);
  }
  lines.push("");

  lines.push(`## Scenarios`);
  lines.push("");
  lines.push(`| Input | Scenario | Expected | Outcome OK | Safety Pass | Repair Allowed | Observed Signals |`);
  lines.push(`| --- | --- | --- | --- | --- | --- | --- |`);
  for (const scenario of report.scenarios) {
    lines.push(
      `| ${scenario.inputKind} | ${escapeMarkdownCell(scenario.id)} | ${scenario.expectedOutcome} | ${passFail(scenario.outcomeAsExpected)} | ${passFail(scenario.safetyPass)} | ${passFail(scenario.repairAllowed)} | ${escapeMarkdownCell(scenario.observedFailureSignals.join(", ") || "(none)")} |`
    );
  }
  lines.push("");

  if (report.diagnostics.length > 0) {
    lines.push(`## Diagnostics`);
    lines.push("");
    for (const diagnostic of report.diagnostics) {
      lines.push(`- ${escapeMarkdownText(diagnostic)}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function matchesPathPattern(file: string, pattern: string): boolean {
  const normalizedFile = normalizeRepoPath(file);
  const normalizedPattern = normalizeRepoPath(pattern);

  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    return normalizedFile === prefix || normalizedFile.startsWith(`${prefix}/`);
  }

  if (!normalizedPattern.includes("*")) {
    return normalizedFile === normalizedPattern;
  }

  const regex = new RegExp(`^${escapeRegExp(normalizedPattern).replace(/\\\*/g, ".*")}$`);
  return regex.test(normalizedFile);
}

function normalizeRepoPath(value: string): string {
  return value
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^a\//, "")
    .replace(/^b\//, "");
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
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

function compact(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function escapeMarkdownText(value: string): string {
  return value.replace(/\n/g, " ").trim();
}

function escapeMarkdownCell(value: string): string {
  return escapeMarkdownText(value).replace(/\|/g, "\\|");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
