import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeRepository } from "../../../packages/repo-intelligence/src/index.js";
import {
  parseChangedFilesFromEnv,
  readGitDiff,
  selectChangedFilesForEvaluation,
  type GitDiffSummary
} from "../../../packages/repo-intelligence/src/git-diff-adapter.js";

type RealDiffExpectedOutcome = "pass" | "fail";

type RealDiffFailureSignal =
  | "missing_diff"
  | "forbidden_file_touch"
  | "unexpected_file_touch"
  | "missing_required_file"
  | "forbidden_added_pattern";

type RealDiffControlCase = {
  id: string;
  title: string;
  expectedOutcome: RealDiffExpectedOutcome;
  allowedFiles: string[];
  forbiddenFiles: string[];
  requiredFiles: string[];
  forbiddenAddedPatterns: string[];
  syntheticChangedFiles?: string[];
  syntheticAddedLines?: string[];
  expectedFailureSignals: RealDiffFailureSignal[];
};

type RealDiffControlManifest = {
  suiteName: string;
  description: string;
  fallbackChangedFiles: string[];
  controls: RealDiffControlCase[];
};

type RealDiffControlScore = {
  id: string;
  title: string;
  expectedOutcome: RealDiffExpectedOutcome;
  outcomeAsExpected: 0 | 1;
  policyPass: 0 | 1;
  expectedFailureSignals: RealDiffFailureSignal[];
  observedFailureSignals: RealDiffFailureSignal[];
  changedFiles: string[];
  syntheticChangedFiles: string[];
  forbiddenTouchedFiles: string[];
  unexpectedTouchedFiles: string[];
  missingRequiredFiles: string[];
  forbiddenPatternHits: Array<{
    pattern: string;
    linePreview: string;
  }>;
};

type RealDiffControlReport = {
  ok: true;
  reportName: string;
  createdAt: string;
  suiteName: string;
  description: string;
  manifestPath: string;
  diff: {
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
  selectedChangedFiles: string[];
  repo: {
    rootDir: string;
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
  aggregate: {
    caseCount: number;
    positiveCount: number;
    negativeCount: number;
    passedCount: number;
    failedCount: number;
    expectedOutcomeAccuracy: number;
    positivePassRate: number;
    negativeDetectionRate: number;
    policyPassRate: number;
    failureSignalCounts: Record<string, number>;
    diffMode: string;
    diffChangedFileCount: number;
    selectedChangedFileCount: number;
  };
  cases: RealDiffControlScore[];
  diagnostics: string[];
};

const reportName = "real-repo-control-report-v1";
const createdAt = new Date().toISOString();
const safeTimestamp = createdAt.replace(/[:.]/g, "-");
const reportDir = "reports/real-repo-evaluation";
const manifestPath = process.env.REAL_REPO_CONTROL_FILE ?? "examples/real-repo-evaluation/real-repo-evaluation-fixtures.json";

const manifest = await readManifest(manifestPath);
const diagnostics: string[] = [];
const rootDir = process.cwd();

const diff = readGitDiff({
  rootDir,
  baseRef: process.env.GIT_BASE_REF,
  headRef: process.env.GIT_HEAD_REF,
  diffFilePath: process.env.GIT_DIFF_FILE,
  includeStaged: process.env.GIT_DIFF_STAGED === "1",
  includeUntracked: process.env.GIT_DIFF_INCLUDE_UNTRACKED !== "0"
});

diagnostics.push(...diff.diagnostics);

const selectedChangedFiles = selectChangedFilesForEvaluation({
  rootDir,
  diff,
  envChangedFiles: parseChangedFilesFromEnv(process.env.REPO_CHANGED_FILES),
  fallbackChangedFiles: manifest.fallbackChangedFiles,
  diagnostics
});

const repoResult = await analyzeRepository({
  rootDir,
  changedFiles: selectedChangedFiles,
  maxFiles: 1000
});

const addedLines = collectAddedLines(diff);
const scores = manifest.controls.map((control) =>
  scoreControlCase({
    control,
    diff,
    selectedChangedFiles,
    addedLines
  })
);

const report = createReport({
  manifest,
  manifestPath,
  diff,
  selectedChangedFiles,
  scores,
  diagnostics: [...diagnostics, ...repoResult.diagnostics]
});

await mkdir(reportDir, { recursive: true });

const jsonPath = join(reportDir, `${safeTimestamp}-real-repo-control-report.json`);
const markdownPath = join(reportDir, `${safeTimestamp}-real-repo-control-report.md`);

await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(markdownPath, reportToMarkdown(report));

console.log(
  JSON.stringify(
    {
      ok: true,
      reportName,
      suiteName: manifest.suiteName,
      caseCount: report.aggregate.caseCount,
      expectedOutcomeAccuracy: report.aggregate.expectedOutcomeAccuracy,
      positivePassRate: report.aggregate.positivePassRate,
      negativeDetectionRate: report.aggregate.negativeDetectionRate,
      jsonPath,
      markdownPath,
      aggregate: report.aggregate
    },
    null,
    2
  )
);

async function readManifest(path: string): Promise<RealDiffControlManifest> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as RealDiffControlManifest;
  const failures = validateManifest(parsed);

  if (failures.length) {
    throw new Error(
      JSON.stringify(
        {
          ok: false,
          reason: "Invalid real repo control manifest.",
          manifestPath: path,
          failures
        },
        null,
        2
      )
    );
  }

  return parsed;
}

function validateManifest(manifest: RealDiffControlManifest): string[] {
  const failures: string[] = [];
  const ids = new Set<string>();

  if (!manifest.suiteName) failures.push("suiteName is required.");
  if (!Array.isArray(manifest.fallbackChangedFiles)) failures.push("fallbackChangedFiles must be an array.");
  if (!Array.isArray(manifest.controls) || manifest.controls.length === 0) {
    failures.push("controls must be a non-empty array.");
  }

  for (const control of manifest.controls ?? []) {
    if (!control.id) failures.push("control.id is required.");
    if (ids.has(control.id)) failures.push(`${control.id}: duplicate id.`);
    ids.add(control.id);

    if (control.expectedOutcome !== "pass" && control.expectedOutcome !== "fail") {
      failures.push(`${control.id}: expectedOutcome must be pass or fail.`);
    }

    if (!Array.isArray(control.allowedFiles)) failures.push(`${control.id}: allowedFiles must be an array.`);
    if (!Array.isArray(control.forbiddenFiles)) failures.push(`${control.id}: forbiddenFiles must be an array.`);
    if (!Array.isArray(control.requiredFiles)) failures.push(`${control.id}: requiredFiles must be an array.`);
    if (!Array.isArray(control.forbiddenAddedPatterns)) failures.push(`${control.id}: forbiddenAddedPatterns must be an array.`);
    if (!Array.isArray(control.expectedFailureSignals)) failures.push(`${control.id}: expectedFailureSignals must be an array.`);

    if (control.expectedOutcome === "pass" && control.expectedFailureSignals.length > 0) {
      failures.push(`${control.id}: passing control must not declare expected failure signals.`);
    }

    if (control.expectedOutcome === "fail" && control.expectedFailureSignals.length === 0) {
      failures.push(`${control.id}: failing control must declare expected failure signals.`);
    }
  }

  return failures;
}

function scoreControlCase(input: {
  control: RealDiffControlCase;
  diff: GitDiffSummary;
  selectedChangedFiles: string[];
  addedLines: string[];
}): RealDiffControlScore {
  const syntheticChangedFiles = input.control.syntheticChangedFiles ?? [];
  const changedFiles = uniqueSorted([
    ...input.selectedChangedFiles,
    ...syntheticChangedFiles
  ]);
  const allAddedLines = [
    ...input.addedLines,
    ...(input.control.syntheticAddedLines ?? [])
  ];

  const forbiddenTouchedFiles = changedFiles.filter((file) =>
    input.control.forbiddenFiles.some((pattern) => matchesPathPattern(file, pattern))
  );

  const unexpectedTouchedFiles = input.control.allowedFiles.length > 0
    ? changedFiles.filter((file) =>
        !input.control.allowedFiles.some((pattern) => matchesPathPattern(file, pattern))
      )
    : [];

  const missingRequiredFiles = input.control.requiredFiles.filter((requiredFile) =>
    !changedFiles.some((file) => matchesPathPattern(file, requiredFile))
  );

  const forbiddenPatternHits = findForbiddenPatternHits({
    addedLines: allAddedLines,
    forbiddenAddedPatterns: input.control.forbiddenAddedPatterns
  });

  const observedFailureSignals: RealDiffFailureSignal[] = [];

  if (input.diff.changedFiles.length === 0 && input.selectedChangedFiles.length === 0) {
    observedFailureSignals.push("missing_diff");
  }

  if (forbiddenTouchedFiles.length > 0) {
    observedFailureSignals.push("forbidden_file_touch");
  }

  if (unexpectedTouchedFiles.length > 0) {
    observedFailureSignals.push("unexpected_file_touch");
  }

  if (missingRequiredFiles.length > 0) {
    observedFailureSignals.push("missing_required_file");
  }

  if (forbiddenPatternHits.length > 0) {
    observedFailureSignals.push("forbidden_added_pattern");
  }

  const policyPass = observedFailureSignals.length === 0;
  const outcomeAsExpected = input.control.expectedOutcome === "pass"
    ? policyPass
    : input.control.expectedFailureSignals.every((signal) =>
        observedFailureSignals.includes(signal)
      );

  return {
    id: input.control.id,
    title: input.control.title,
    expectedOutcome: input.control.expectedOutcome,
    outcomeAsExpected: binary(outcomeAsExpected),
    policyPass: binary(policyPass),
    expectedFailureSignals: input.control.expectedFailureSignals,
    observedFailureSignals,
    changedFiles,
    syntheticChangedFiles,
    forbiddenTouchedFiles,
    unexpectedTouchedFiles,
    missingRequiredFiles,
    forbiddenPatternHits
  };
}

function collectAddedLines(diff: GitDiffSummary): string[] {
  return diff.fileChanges.flatMap((change) =>
    change.hunks.flatMap((hunk) => hunk.addedLines)
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

function createReport(input: {
  manifest: RealDiffControlManifest;
  manifestPath: string;
  diff: GitDiffSummary;
  selectedChangedFiles: string[];
  scores: RealDiffControlScore[];
  diagnostics: string[];
}): RealDiffControlReport {
  const positiveScores = input.scores.filter((score) => score.expectedOutcome === "pass");
  const negativeScores = input.scores.filter((score) => score.expectedOutcome === "fail");

  return {
    ok: true,
    reportName,
    createdAt,
    suiteName: input.manifest.suiteName,
    description: input.manifest.description,
    manifestPath: input.manifestPath,
    diff: {
      mode: input.diff.mode,
      baseRef: input.diff.baseRef,
      headRef: input.diff.headRef,
      diffFilePath: input.diff.diffFilePath,
      rawDiffBytes: input.diff.rawDiffBytes,
      changedFiles: input.diff.changedFiles,
      existingChangedFiles: input.diff.existingChangedFiles,
      fileChangeCount: input.diff.fileChanges.length,
      hunkCount: input.diff.hunkCount,
      additionCount: input.diff.additionCount,
      deletionCount: input.diff.deletionCount
    },
    selectedChangedFiles: input.selectedChangedFiles,
    repo: {
      rootDir: repoResult.rootDir,
      scannedFileCount: repoResult.scannedFileCount,
      skippedFileCount: repoResult.skippedFileCount,
      changedFileCount: repoResult.facts.changedFiles.length,
      ownershipCount: repoResult.facts.ownership.length,
      pairedFileCount: repoResult.facts.pairedFiles.length,
      requiredTestCount: repoResult.facts.requiredTests.length,
      requiredTestMappingCount: repoResult.facts.requiredTestMappings.length,
      moduleBoundaryCount: repoResult.facts.moduleBoundaries.length,
      sensitivePatternCount: repoResult.facts.sensitivePatterns.length,
      staleFactCount: repoResult.facts.staleFacts.length,
      diagnostics: repoResult.diagnostics.slice(0, 20)
    },
    aggregate: {
      caseCount: input.scores.length,
      positiveCount: positiveScores.length,
      negativeCount: negativeScores.length,
      passedCount: input.scores.filter((score) => score.outcomeAsExpected === 1).length,
      failedCount: input.scores.filter((score) => score.outcomeAsExpected === 0).length,
      expectedOutcomeAccuracy: average(input.scores.map((score) => score.outcomeAsExpected)),
      positivePassRate: average(positiveScores.map((score) => score.outcomeAsExpected)),
      negativeDetectionRate: average(negativeScores.map((score) => score.outcomeAsExpected)),
      policyPassRate: average(input.scores.map((score) => score.policyPass)),
      failureSignalCounts: countBy(input.scores.flatMap((score) => score.observedFailureSignals)),
      diffMode: input.diff.mode,
      diffChangedFileCount: input.diff.changedFiles.length,
      selectedChangedFileCount: input.selectedChangedFiles.length
    },
    cases: input.scores,
    diagnostics: input.diagnostics.slice(0, 30)
  };
}

function reportToMarkdown(report: RealDiffControlReport): string {
  const lines: string[] = [];

  lines.push(`# Real Repo Control Report`);
  lines.push("");
  lines.push(`- Report: \`${report.reportName}\``);
  lines.push(`- Created at: \`${report.createdAt}\``);
  lines.push(`- Suite: \`${report.suiteName}\``);
  lines.push(`- Manifest: \`${report.manifestPath}\``);
  lines.push(`- Diff mode: \`${report.diff.mode}\``);
  lines.push("");

  lines.push(`## Summary`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | ---: |`);
  lines.push(`| Cases | ${report.aggregate.caseCount} |`);
  lines.push(`| Positive controls | ${report.aggregate.positiveCount} |`);
  lines.push(`| Negative controls | ${report.aggregate.negativeCount} |`);
  lines.push(`| Expected outcome accuracy | ${percent(report.aggregate.expectedOutcomeAccuracy)} |`);
  lines.push(`| Positive pass rate | ${percent(report.aggregate.positivePassRate)} |`);
  lines.push(`| Negative detection rate | ${percent(report.aggregate.negativeDetectionRate)} |`);
  lines.push(`| Policy pass rate | ${percent(report.aggregate.policyPassRate)} |`);
  lines.push(`| Diff changed files | ${report.aggregate.diffChangedFileCount} |`);
  lines.push(`| Selected changed files | ${report.aggregate.selectedChangedFileCount} |`);
  lines.push("");

  lines.push(`## Changed Files`);
  lines.push("");
  for (const file of report.selectedChangedFiles) {
    lines.push(`- \`${file}\``);
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

  lines.push(`## Cases`);
  lines.push("");
  lines.push(`| Case | Expected | Outcome OK | Policy Pass | Expected Signals | Observed Signals |`);
  lines.push(`| --- | --- | --- | --- | --- | --- |`);

  for (const score of report.cases) {
    lines.push(
      `| ${escapeMarkdownCell(score.id)} | ${score.expectedOutcome} | ${passFail(score.outcomeAsExpected)} | ${passFail(score.policyPass)} | ${escapeMarkdownCell(score.expectedFailureSignals.join(", ") || "(none)")} | ${escapeMarkdownCell(score.observedFailureSignals.join(", ") || "(none)")} |`
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
