import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

type JsonRecord = Record<string, unknown>;

type LatestJsonFile = {
  path: string;
  name: string;
};

type DecisionCounts = Record<string, number>;

const reportName = "evaluation-integrated-report-v1";
const suiteName = "bounded-agent-evaluation-with-dllm-verifier";
const createdAt = new Date().toISOString();
const safeTimestamp = createdAt.replace(/[:.]/g, "-");
const outputDir = "reports/evaluation-integrated";

await main();

async function main(): Promise<void> {
  await mkdir(outputDir, { recursive: true });

  const baselineFile = await findLatestJsonFile(
    "reports/baseline-comparison",
    "-baseline-comparison-report.json"
  );

  const verifierFile = await findLatestJsonFile(
    "reports/dllm-verifier",
    "-dllm-verifier-report.json"
  );

  const repoVerifyFile = await findLatestJsonFile(
    "reports/real-repo-evaluation",
    "-real-repo-verify.json"
  );

  const modelAcceptanceFile = await findLatestJsonFile(
    "reports/model-worker-acceptance",
    "-model-worker-acceptance-report.json"
  );

  const baselineReport = await readJsonRecord(baselineFile.path);
  const verifierReport = await readJsonRecord(verifierFile.path);
  const repoVerifyReport = await readJsonRecord(repoVerifyFile.path);
  const modelAcceptanceReport = await readJsonRecord(modelAcceptanceFile.path);

  const baselineAggregate = asRecord(baselineReport.aggregate);
  const verifierAggregate = asRecord(verifierReport.aggregate);
  const repoCommandCount = numberValue(repoVerifyReport.commandCount);
  const repoPassedCount = numberValue(repoVerifyReport.passedCount);
  const repoFailedCount = numberValue(repoVerifyReport.failedCount);

  const verifierResults = arrayValue(verifierReport.results)
    .map(asRecord)
    .filter((item) => Object.keys(item).length > 0);

  const dllmVerifier = {
    enabled: true,
    sourcePath: verifierFile.path,
    caseCount: numberValue(verifierAggregate.caseCount),
    passedCount: numberValue(verifierAggregate.passedCount),
    failedCount: numberValue(verifierAggregate.failedCount),
    core: verifierReport.core ?? null,
    pipeline: verifierReport.pipeline ?? null,
    decisionCounts: countByStringField(verifierResults, "actualDecision"),
    totalSignalCount: sumNumberField(verifierResults, "signalCount"),
    totalMaskRegionCount: sumNumberField(verifierResults, "maskRegionCount"),
    totalApprovedFileCount: sumNumberField(verifierResults, "approvedFileCount"),
    totalRejectedFileCount: sumNumberField(verifierResults, "rejectedFileCount")
  };

  const baseline = {
    enabled: true,
    sourcePath: baselineFile.path,
    reportName: stringValue(baselineReport.reportName),
    suiteName: stringValue(baselineReport.suiteName),
    baselineStrategy: stringValue(baselineReport.baselineStrategy),
    caseCount: numberValue(baselineReport.caseCount),
    boundedFinalSafeRate: numberValue(baselineReport.boundedFinalSafeRate),
    directFinalSafeRate: numberValue(baselineReport.directFinalSafeRate),
    boundedWinRate: numberValue(baselineReport.boundedWinRate),
    averageTokenSavingsRate: numberValue(baselineReport.averageTokenSavingsRate),
    averageDirectScopeExpansionFactor: numberValue(
      baselineReport.averageDirectScopeExpansionFactor
    ),
    boundedFinalDecisionCounts: baselineAggregate.boundedFinalDecisionCounts ?? null,
    directDecisionCounts: baselineAggregate.directDecisionCounts ?? null,
    directFailureModeCounts: baselineAggregate.directFailureModeCounts ?? null,
    conflictCountsByKind: baselineAggregate.conflictCountsByKind ?? null
  };

  const repoVerification = {
    enabled: true,
    sourcePath: repoVerifyFile.path,
    commandCount: repoCommandCount,
    passedCount: repoPassedCount,
    failedCount: repoFailedCount
  };

  const modelAcceptance = {
    enabled: true,
    sourcePath: modelAcceptanceFile.path,
    status: stringValue(modelAcceptanceReport.status),
    required: Boolean(modelAcceptanceReport.required),
    configuredWorkerCount: numberValue(modelAcceptanceReport.configuredWorkerCount),
    skippedWorkerCount: numberValue(modelAcceptanceReport.skippedWorkerCount),
    failedWorkerCount: numberValue(modelAcceptanceReport.failedWorkerCount)
  };

  const integratedJudgement = createIntegratedJudgement({
    baseline,
    dllmVerifier,
    repoVerification,
    modelAcceptance
  });

  const ok =
    repoVerification.failedCount === 0 &&
    dllmVerifier.failedCount === 0 &&
    baseline.boundedFinalSafeRate === 1;

  const jsonPath = join(outputDir, `${safeTimestamp}-evaluation-integrated-report.json`);
  const markdownPath = join(outputDir, `${safeTimestamp}-evaluation-integrated-report.md`);

  const report = {
    ok,
    reportName,
    suiteName,
    createdAt,
    integratedJudgement,
    baseline,
    dllmVerifier,
    repoVerification,
    modelAcceptance,
    sources: {
      baseline: baselineFile.path,
      dllmVerifier: verifierFile.path,
      repoVerification: repoVerifyFile.path,
      modelAcceptance: modelAcceptanceFile.path
    },
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
        createdAt,
        integratedJudgement,
        baseline: {
          caseCount: baseline.caseCount,
          boundedFinalSafeRate: baseline.boundedFinalSafeRate,
          directFinalSafeRate: baseline.directFinalSafeRate,
          boundedWinRate: baseline.boundedWinRate,
          averageTokenSavingsRate: baseline.averageTokenSavingsRate
        },
        dllmVerifier: {
          enabled: dllmVerifier.enabled,
          caseCount: dllmVerifier.caseCount,
          passedCount: dllmVerifier.passedCount,
          failedCount: dllmVerifier.failedCount,
          decisionCounts: dllmVerifier.decisionCounts,
          totalSignalCount: dllmVerifier.totalSignalCount,
          totalMaskRegionCount: dllmVerifier.totalMaskRegionCount
        },
        repoVerification,
        modelAcceptance,
        jsonPath,
        markdownPath
      },
      null,
      2
    )
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

function asRecord(value: unknown): JsonRecord {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as JsonRecord;
  }

  return {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sumNumberField(items: JsonRecord[], field: string): number {
  return items.reduce((sum, item) => sum + numberValue(item[field]), 0);
}

function countByStringField(items: JsonRecord[], field: string): DecisionCounts {
  const counts: DecisionCounts = {};

  for (const item of items) {
    const value = stringValue(item[field]) ?? "unknown";
    counts[value] = (counts[value] ?? 0) + 1;
  }

  return counts;
}

function createIntegratedJudgement(input: {
  baseline: {
    boundedFinalSafeRate: number;
    directFinalSafeRate: number;
    boundedWinRate: number;
    averageTokenSavingsRate: number;
  };
  dllmVerifier: {
    failedCount: number;
    decisionCounts: DecisionCounts;
  };
  repoVerification: {
    failedCount: number;
  };
  modelAcceptance: {
    status: string | null;
  };
}): string {
  const boundedPassed = input.baseline.boundedFinalSafeRate === 1;
  const verifierPassed = input.dllmVerifier.failedCount === 0;
  const repoPassed = input.repoVerification.failedCount === 0;

  if (boundedPassed && verifierPassed && repoPassed) {
    return [
      "Integrated evaluation passed.",
      "The bounded pipeline remains safe across model-free repo/PR evaluation,",
      "and the dLLM-style verifier independently classifies approve/remask/reject candidates."
    ].join(" ");
  }

  return [
    "Integrated evaluation requires review.",
    `boundedFinalSafeRate=${input.baseline.boundedFinalSafeRate},`,
    `dllmVerifierFailedCount=${input.dllmVerifier.failedCount},`,
    `repoFailedCount=${input.repoVerification.failedCount}.`
  ].join(" ");
}

function reportToMarkdown(report: {
  reportName: string;
  suiteName: string;
  createdAt: string;
  integratedJudgement: string;
  baseline: JsonRecord;
  dllmVerifier: JsonRecord;
  repoVerification: JsonRecord;
  modelAcceptance: JsonRecord;
  sources: JsonRecord;
}): string {
  const lines: string[] = [];

  lines.push("# Integrated Evaluation Report");
  lines.push("");
  lines.push(`- Report: \`${report.reportName}\``);
  lines.push(`- Suite: \`${report.suiteName}\``);
  lines.push(`- Created at: \`${report.createdAt}\``);
  lines.push("");
  lines.push("## Integrated Judgement");
  lines.push("");
  lines.push(report.integratedJudgement);
  lines.push("");

  lines.push("## Baseline Comparison");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | ---: |");
  lines.push(`| Case count | ${formatCell(report.baseline.caseCount)} |`);
  lines.push(`| Bounded final safe rate | ${formatCell(report.baseline.boundedFinalSafeRate)} |`);
  lines.push(`| Direct final safe rate | ${formatCell(report.baseline.directFinalSafeRate)} |`);
  lines.push(`| Bounded win rate | ${formatCell(report.baseline.boundedWinRate)} |`);
  lines.push(`| Average token savings rate | ${formatCell(report.baseline.averageTokenSavingsRate)} |`);
  lines.push(`| Average direct scope expansion factor | ${formatCell(report.baseline.averageDirectScopeExpansionFactor)} |`);
  lines.push("");

  lines.push("## dLLM Verifier");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | ---: |");
  lines.push(`| Enabled | ${formatCell(report.dllmVerifier.enabled)} |`);
  lines.push(`| Case count | ${formatCell(report.dllmVerifier.caseCount)} |`);
  lines.push(`| Passed | ${formatCell(report.dllmVerifier.passedCount)} |`);
  lines.push(`| Failed | ${formatCell(report.dllmVerifier.failedCount)} |`);
  lines.push(`| Decision counts | \`${JSON.stringify(report.dllmVerifier.decisionCounts)}\` |`);
  lines.push(`| Total signal count | ${formatCell(report.dllmVerifier.totalSignalCount)} |`);
  lines.push(`| Total mask region count | ${formatCell(report.dllmVerifier.totalMaskRegionCount)} |`);
  lines.push("");

  lines.push("## Repo Verification");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | ---: |");
  lines.push(`| Command count | ${formatCell(report.repoVerification.commandCount)} |`);
  lines.push(`| Passed | ${formatCell(report.repoVerification.passedCount)} |`);
  lines.push(`| Failed | ${formatCell(report.repoVerification.failedCount)} |`);
  lines.push("");

  lines.push("## Model Acceptance");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | ---: |");
  lines.push(`| Status | ${formatCell(report.modelAcceptance.status)} |`);
  lines.push(`| Required | ${formatCell(report.modelAcceptance.required)} |`);
  lines.push(`| Configured workers | ${formatCell(report.modelAcceptance.configuredWorkerCount)} |`);
  lines.push(`| Skipped workers | ${formatCell(report.modelAcceptance.skippedWorkerCount)} |`);
  lines.push(`| Failed workers | ${formatCell(report.modelAcceptance.failedWorkerCount)} |`);
  lines.push("");

  lines.push("## Sources");
  lines.push("");
  lines.push("| Source | Path |");
  lines.push("| --- | --- |");
  lines.push(`| Baseline | \`${formatCell(report.sources.baseline)}\` |`);
  lines.push(`| dLLM verifier | \`${formatCell(report.sources.dllmVerifier)}\` |`);
  lines.push(`| Repo verification | \`${formatCell(report.sources.repoVerification)}\` |`);
  lines.push(`| Model acceptance | \`${formatCell(report.sources.modelAcceptance)}\` |`);
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "n/a";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(4);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
