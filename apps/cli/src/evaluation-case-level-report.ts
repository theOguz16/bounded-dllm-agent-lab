import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  runDllmVerifierOnPipelineCandidate,
  type DllmVerifierPipelineCandidate
} from "../../../packages/dllm-verifier/src/index.js";

type JsonRecord = Record<string, unknown>;

type LatestJsonFile = {
  path: string;
  name: string;
};

type EnrichedCase = {
  id: string;
  sourceKind: string;
  baseline: JsonRecord;
  dllmVerifier: {
    enabled: true;
    decision: string;
    ok: boolean;
    signalCount: number;
    maskRegionCount: number;
    approvedFileCount: number;
    rejectedFileCount: number;
    summary: string;
  };
};

const reportName = "evaluation-case-level-report-v1";
const suiteName = "baseline-cases-with-dllm-verifier-metadata";
const createdAt = new Date().toISOString();
const safeTimestamp = createdAt.replace(/[:.]/g, "-");
const outputDir = "reports/evaluation-case-level";

await main();

async function main(): Promise<void> {
  await mkdir(outputDir, { recursive: true });

  const baselineFile = await findLatestJsonFile(
    "reports/baseline-comparison",
    "-baseline-comparison-report.json"
  );

  const baselineReport = await readJsonRecord(baselineFile.path);
  const baselineCases = extractBaselineCases(baselineReport);

  if (baselineCases.length === 0) {
    throw new Error(
      [
        "No case-level array found in latest baseline comparison report.",
        "Expected one of: results, cases, caseResults, comparisons.",
        `Source: ${baselineFile.path}`
      ].join(" ")
    );
  }

  const enrichedCases = baselineCases.map((baselineCase, index) =>
    enrichCase(baselineCase, index)
  );

  const passedCount = enrichedCases.filter((item) => item.dllmVerifier.ok).length;
  const failedCount = enrichedCases.length - passedCount;

  const decisionCounts = countBy(
    enrichedCases.map((item) => item.dllmVerifier.decision)
  );

  const aggregate = {
    caseCount: enrichedCases.length,
    passedCount,
    failedCount,
    decisionCounts,
    totalSignalCount: enrichedCases.reduce(
      (sum, item) => sum + item.dllmVerifier.signalCount,
      0
    ),
    totalMaskRegionCount: enrichedCases.reduce(
      (sum, item) => sum + item.dllmVerifier.maskRegionCount,
      0
    ),
    totalApprovedFileCount: enrichedCases.reduce(
      (sum, item) => sum + item.dllmVerifier.approvedFileCount,
      0
    ),
    totalRejectedFileCount: enrichedCases.reduce(
      (sum, item) => sum + item.dllmVerifier.rejectedFileCount,
      0
    )
  };

  const ok = failedCount === 0;

  const jsonPath = join(outputDir, `${safeTimestamp}-evaluation-case-level-report.json`);
  const markdownPath = join(outputDir, `${safeTimestamp}-evaluation-case-level-report.md`);

  const report = {
    ok,
    reportName,
    suiteName,
    createdAt,
    aggregate,
    source: {
      baselineComparisonReport: baselineFile.path
    },
    cases: enrichedCases,
    jsonPath,
    markdownPath
  };

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(markdownPath, reportToMarkdown(report));

  if (!ok) {
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        ok,
        reportName,
        suiteName,
        caseCount: aggregate.caseCount,
        passedCount: aggregate.passedCount,
        failedCount: aggregate.failedCount,
        decisionCounts: aggregate.decisionCounts,
        totalSignalCount: aggregate.totalSignalCount,
        totalMaskRegionCount: aggregate.totalMaskRegionCount,
        jsonPath,
        markdownPath
      },
      null,
      2
    )
  );
}

function enrichCase(rawCase: JsonRecord, index: number): EnrichedCase {
  const id = extractCaseId(rawCase, index);
  const candidate = baselineCaseToVerifierCandidate(rawCase, id);
  const output = runDllmVerifierOnPipelineCandidate(candidate);

  return {
    id,
    sourceKind: extractSourceKind(rawCase),
    baseline: rawCase,
    dllmVerifier: {
      enabled: true,
      decision: output.decision,
      ok: output.ok,
      signalCount: output.signals.length,
      maskRegionCount: output.maskRegions.length,
      approvedFileCount: output.approvedFiles.length,
      rejectedFileCount: output.rejectedFiles.length,
      summary: output.summary
    }
  };
}

function baselineCaseToVerifierCandidate(
  rawCase: JsonRecord,
  id: string
): DllmVerifierPipelineCandidate {
  const changedFiles = firstStringArray(
    rawCase.changedFiles,
    rawCase.changedFilePaths,
    rawCase.scopedFiles,
    rawCase.files,
    getNested(rawCase, ["source", "changedFiles"]),
    getNested(rawCase, ["realDiff", "changedFiles"]),
    getNested(rawCase, ["prInput", "changedFiles"])
  );

  const proposedTouchedFiles = firstStringArray(
    rawCase.proposedTouchedFiles,
    rawCase.touchedFiles,
    rawCase.modifiedFiles,
    getNested(rawCase, ["bounded", "touchedFiles"]),
    getNested(rawCase, ["bounded", "proposedTouchedFiles"]),
    getNested(rawCase, ["boundedOutput", "touchedFiles"]),
    changedFiles
  );

  const allowedFiles = firstStringArray(
    rawCase.allowedFiles,
    rawCase.scopedFiles,
    getNested(rawCase, ["bounded", "allowedFiles"]),
    changedFiles
  );

  const requiredFiles = firstStringArray(
    rawCase.requiredFiles,
    getNested(rawCase, ["bounded", "requiredFiles"]),
    changedFiles
  );

  const unresolvedConflicts = extractConflicts(rawCase);
  const proposedAddedLines = firstStringArray(
    rawCase.proposedAddedLines,
    rawCase.addedLines,
    getNested(rawCase, ["bounded", "proposedAddedLines"]),
    getNested(rawCase, ["boundedOutput", "proposedAddedLines"])
  );

  return {
    taskId: id,
    changedFiles: changedFiles.length > 0 ? changedFiles : [`synthetic/${id}.ts`],
    proposedTouchedFiles:
      proposedTouchedFiles.length > 0
        ? proposedTouchedFiles
        : changedFiles.length > 0
          ? changedFiles
          : [`synthetic/${id}.ts`],
    allowedFiles: allowedFiles.length > 0 ? allowedFiles : changedFiles,
    requiredFiles: requiredFiles.length > 0 ? requiredFiles : changedFiles,
    unresolvedConflicts,
    staleFactCount: extractStaleFactCount(rawCase),
    sensitivePatternCount: extractSensitivePatternCount(rawCase),
    proposedAddedLines
  };
}

function extractBaselineCases(report: JsonRecord): JsonRecord[] {
  const direct = firstRecordArray(
    report.results,
    report.cases,
    report.caseResults,
    report.comparisons
  );

  if (direct.length > 0) {
    return direct;
  }

  const nested = findFirstRecordArray(report, [
    "results",
    "cases",
    "caseResults",
    "comparisons"
  ]);

  return nested;
}

function extractCaseId(rawCase: JsonRecord, index: number): string {
  const candidates = [
    rawCase.id,
    rawCase.caseId,
    rawCase.fixtureId,
    rawCase.name,
    rawCase.taskId
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }

  return `baseline_case_${index + 1}`;
}

function extractSourceKind(rawCase: JsonRecord): string {
  const candidates = [
    rawCase.sourceKind,
    rawCase.source,
    rawCase.kind,
    rawCase.inputKind
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }

  return "unknown";
}

function extractConflicts(rawCase: JsonRecord): Array<{ kind: string; filePath?: string }> {
  const rawConflicts = firstRecordArray(
    rawCase.unresolvedConflicts,
    rawCase.conflicts,
    getNested(rawCase, ["bounded", "unresolvedConflicts"]),
    getNested(rawCase, ["bounded", "remainingConflicts"]),
    getNested(rawCase, ["boundedOutput", "remainingConflicts"])
  );

  return rawConflicts
    .map((conflict) => {
      const kind =
        stringValue(conflict.kind) ??
        stringValue(conflict.type) ??
        stringValue(conflict.conflictKind) ??
        "unknown";

      const filePath =
        stringValue(conflict.filePath) ??
        stringValue(conflict.path) ??
        stringValue(conflict.file) ??
        undefined;

      return { kind, filePath };
    })
    .filter((conflict) => conflict.kind !== "unknown");
}

function extractStaleFactCount(rawCase: JsonRecord): number {
  return firstNumber(
    rawCase.staleFactCount,
    rawCase.staleFacts,
    getNested(rawCase, ["repoIntelligence", "staleFactCount"]),
    getNested(rawCase, ["bounded", "staleFactCount"])
  );
}

function extractSensitivePatternCount(rawCase: JsonRecord): number {
  return firstNumber(
    rawCase.sensitivePatternCount,
    rawCase.sensitivePatterns,
    getNested(rawCase, ["repoIntelligence", "sensitivePatternCount"]),
    getNested(rawCase, ["bounded", "sensitivePatternCount"])
  );
}

async function findLatestJsonFile(
  dir: string,
  suffix: string
): Promise<LatestJsonFile> {
  const names = await readdir(dir);
  const candidates = names.filter((name) => name.endsWith(suffix));

  if (candidates.length === 0) {
    throw new Error(`No report file found in ${dir} with suffix ${suffix}`);
  }

  const withStats = await Promise.all(
    candidates.map(async (name) => {
      const path = join(dir, name);
      const stats = await stat(path);

      return {
        name,
        path,
        mtimeMs: stats.mtimeMs
      };
    })
  );

  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);

  return {
    name: withStats[0].name,
    path: withStats[0].path
  };
}

async function readJsonRecord(path: string): Promise<JsonRecord> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  return asRecord(parsed);
}

function firstRecordArray(...values: unknown[]): JsonRecord[] {
  for (const value of values) {
    if (!Array.isArray(value)) continue;

    const records = value.map(asRecord).filter((item) => Object.keys(item).length > 0);

    if (records.length > 0) {
      return records;
    }
  }

  return [];
}

function findFirstRecordArray(
  value: unknown,
  preferredKeys: string[]
): JsonRecord[] {
  if (Array.isArray(value)) {
    const records = value.map(asRecord).filter((item) => Object.keys(item).length > 0);

    if (records.length > 0) {
      return records;
    }

    for (const item of value) {
      const nested = findFirstRecordArray(item, preferredKeys);
      if (nested.length > 0) return nested;
    }

    return [];
  }

  const record = asRecord(value);

  for (const key of preferredKeys) {
    const direct = firstRecordArray(record[key]);
    if (direct.length > 0) return direct;
  }

  for (const nestedValue of Object.values(record)) {
    const nested = findFirstRecordArray(nestedValue, preferredKeys);
    if (nested.length > 0) return nested;
  }

  return [];
}

function firstStringArray(...values: unknown[]): string[] {
  for (const value of values) {
    if (!Array.isArray(value)) continue;

    const strings = value.filter(
      (item): item is string => typeof item === "string" && item.length > 0
    );

    if (strings.length > 0) {
      return strings;
    }
  }

  return [];
}

function firstNumber(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (Array.isArray(value)) {
      return value.length;
    }
  }

  return 0;
}

function getNested(value: unknown, path: string[]): unknown {
  let current: unknown = value;

  for (const key of path) {
    const record = asRecord(current);
    current = record[key];
  }

  return current;
}

function asRecord(value: unknown): JsonRecord {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as JsonRecord;
  }

  return {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }

  return counts;
}

function reportToMarkdown(report: {
  reportName: string;
  suiteName: string;
  createdAt: string;
  aggregate: {
    caseCount: number;
    passedCount: number;
    failedCount: number;
    decisionCounts: Record<string, number>;
    totalSignalCount: number;
    totalMaskRegionCount: number;
  };
  source: {
    baselineComparisonReport: string;
  };
  cases: EnrichedCase[];
}): string {
  const lines: string[] = [];

  lines.push("# Evaluation Case-Level Report");
  lines.push("");
  lines.push(`- Report: \`${report.reportName}\``);
  lines.push(`- Suite: \`${report.suiteName}\``);
  lines.push(`- Created at: \`${report.createdAt}\``);
  lines.push(`- Source baseline report: \`${report.source.baselineComparisonReport}\``);
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | ---: |");
  lines.push(`| Case count | ${report.aggregate.caseCount} |`);
  lines.push(`| Passed | ${report.aggregate.passedCount} |`);
  lines.push(`| Failed | ${report.aggregate.failedCount} |`);
  lines.push(`| Decision counts | \`${JSON.stringify(report.aggregate.decisionCounts)}\` |`);
  lines.push(`| Total signal count | ${report.aggregate.totalSignalCount} |`);
  lines.push(`| Total mask region count | ${report.aggregate.totalMaskRegionCount} |`);
  lines.push("");

  lines.push("## Cases");
  lines.push("");
  lines.push("| Case | Source | Verifier Decision | OK | Signals | Mask Regions | Approved Files | Rejected Files |");
  lines.push("| --- | --- | --- | --- | ---: | ---: | ---: | ---: |");

  for (const item of report.cases) {
    lines.push(
      `| \`${item.id}\` | ${item.sourceKind} | ${item.dllmVerifier.decision} | ${item.dllmVerifier.ok} | ${item.dllmVerifier.signalCount} | ${item.dllmVerifier.maskRegionCount} | ${item.dllmVerifier.approvedFileCount} | ${item.dllmVerifier.rejectedFileCount} |`
    );
  }

  lines.push("");
  lines.push("## Case Summaries");
  lines.push("");

  for (const item of report.cases) {
    lines.push(`### \`${item.id}\``);
    lines.push("");
    lines.push(`- Source kind: \`${item.sourceKind}\``);
    lines.push(`- Verifier decision: \`${item.dllmVerifier.decision}\``);
    lines.push(`- OK: \`${item.dllmVerifier.ok}\``);
    lines.push(`- Summary: ${item.dllmVerifier.summary}`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}
