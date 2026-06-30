import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  runDllmStyleVerifier,
  runDllmVerifierOnPipelineCandidate,
  type DllmVerifierDecision,
  type DllmVerifierInput,
  type DllmVerifierPipelineCandidate
} from "../../../packages/dllm-verifier/src/index.js";

type CoreReportCase = {
  id: string;
  expectedDecision: DllmVerifierDecision;
  input: DllmVerifierInput;
};

type PipelineReportCase = {
  id: string;
  expectedDecision: DllmVerifierDecision;
  candidate: DllmVerifierPipelineCandidate;
};

type CaseResult = {
  id: string;
  kind: "core" | "pipeline_candidate";
  expectedDecision: DllmVerifierDecision;
  actualDecision: DllmVerifierDecision;
  passed: boolean;
  signalCount: number;
  maskRegionCount: number;
  approvedFileCount: number;
  rejectedFileCount: number;
  summary: string;
};

type SectionSummary = {
  caseCount: number;
  passedCount: number;
  failedCount: number;
};

const reportName = "dllm-verifier-report-v1";
const suiteName = "dllm-verifier-core-and-pipeline-candidate-report";
const createdAt = new Date().toISOString();
const safeTimestamp = createdAt.replace(/[:.]/g, "-");
const reportDir = "reports/dllm-verifier";

const coreCases: CoreReportCase[] = [
  {
    id: "core_clean_changed_files_scope",
    expectedDecision: "approve",
    input: {
      taskId: "core_clean_changed_files_scope",
      changedFiles: ["packages/dllm-verifier/src/index.ts"],
      proposedTouchedFiles: ["packages/dllm-verifier/src/index.ts"],
      allowedFiles: ["packages/dllm-verifier/src/index.ts"],
      requiredFiles: ["packages/dllm-verifier/src/index.ts"],
      unresolvedConflicts: [],
      staleFactCount: 0,
      sensitivePatternCount: 0,
      proposedAddedLines: ["export const ok = true;"]
    }
  },
  {
    id: "core_unresolved_remask_requires_remask",
    expectedDecision: "remask_required",
    input: {
      taskId: "core_unresolved_remask_requires_remask",
      changedFiles: ["packages/code-benchmark/src/index.ts"],
      proposedTouchedFiles: ["packages/code-benchmark/src/index.ts"],
      allowedFiles: ["packages/code-benchmark/src/index.ts"],
      requiredFiles: ["packages/code-benchmark/src/index.ts"],
      unresolvedConflicts: [
        {
          kind: "remask_unresolved",
          filePath: "packages/code-benchmark/src/index.ts"
        }
      ],
      staleFactCount: 0,
      sensitivePatternCount: 0,
      proposedAddedLines: []
    }
  },
  {
    id: "core_scope_broadening_rejected",
    expectedDecision: "reject",
    input: {
      taskId: "core_scope_broadening_rejected",
      changedFiles: ["apps/cli/src/a.ts"],
      proposedTouchedFiles: ["apps/cli/src/a.ts", "apps/cli/src/unrelated.ts"],
      allowedFiles: ["apps/cli/src/a.ts"],
      requiredFiles: ["apps/cli/src/a.ts"],
      unresolvedConflicts: [],
      staleFactCount: 0,
      sensitivePatternCount: 0,
      proposedAddedLines: []
    }
  },
  {
    id: "core_sensitive_added_line_rejected",
    expectedDecision: "reject",
    input: {
      taskId: "core_sensitive_added_line_rejected",
      changedFiles: ["apps/cli/src/github-pr-live-fetch.ts"],
      proposedTouchedFiles: ["apps/cli/src/github-pr-live-fetch.ts"],
      allowedFiles: ["apps/cli/src/github-pr-live-fetch.ts"],
      requiredFiles: ["apps/cli/src/github-pr-live-fetch.ts"],
      unresolvedConflicts: [],
      staleFactCount: 0,
      sensitivePatternCount: 0,
      proposedAddedLines: ["authorization: `Bearer ${token}`"]
    }
  }
];

const pipelineCases: PipelineReportCase[] = [
  {
    id: "pipeline_bounded_repair_clean_candidate",
    expectedDecision: "approve",
    candidate: {
      taskId: "pipeline_bounded_repair_clean_candidate",
      changedFiles: [
        "packages/code-benchmark/src/index.ts",
        "apps/cli/src/code-model-patch-benchmark.ts"
      ],
      proposedTouchedFiles: [
        "packages/code-benchmark/src/index.ts",
        "apps/cli/src/code-model-patch-benchmark.ts"
      ],
      proposedAddedLines: ["const decision = verifierDecision;"]
    }
  },
  {
    id: "pipeline_bounded_repair_unresolved_remask_candidate",
    expectedDecision: "remask_required",
    candidate: {
      taskId: "pipeline_bounded_repair_unresolved_remask_candidate",
      changedFiles: ["packages/code-benchmark/src/index.ts"],
      proposedTouchedFiles: ["packages/code-benchmark/src/index.ts"],
      unresolvedConflicts: [
        {
          kind: "remask_unresolved",
          filePath: "packages/code-benchmark/src/index.ts"
        }
      ],
      proposedAddedLines: []
    }
  },
  {
    id: "pipeline_bounded_repair_stale_authority_candidate",
    expectedDecision: "remask_required",
    candidate: {
      taskId: "pipeline_bounded_repair_stale_authority_candidate",
      changedFiles: ["packages/code-benchmark/src/index.ts"],
      proposedTouchedFiles: ["packages/code-benchmark/src/index.ts"],
      unresolvedConflicts: [
        {
          kind: "stale_authority",
          filePath: "packages/code-benchmark/src/index.ts"
        }
      ],
      staleFactCount: 1,
      proposedAddedLines: []
    }
  },
  {
    id: "pipeline_bounded_repair_scope_broadened_candidate",
    expectedDecision: "reject",
    candidate: {
      taskId: "pipeline_bounded_repair_scope_broadened_candidate",
      changedFiles: ["packages/code-benchmark/src/index.ts"],
      proposedTouchedFiles: [
        "packages/code-benchmark/src/index.ts",
        "apps/cli/src/unrelated-worker.ts"
      ],
      allowedFiles: ["packages/code-benchmark/src/index.ts"],
      proposedAddedLines: []
    }
  },
  {
    id: "pipeline_bounded_repair_sensitive_added_line_candidate",
    expectedDecision: "reject",
    candidate: {
      taskId: "pipeline_bounded_repair_sensitive_added_line_candidate",
      changedFiles: ["apps/cli/src/github-pr-live-fetch.ts"],
      proposedTouchedFiles: ["apps/cli/src/github-pr-live-fetch.ts"],
      proposedAddedLines: ["authorization: `Bearer ${token}`"]
    }
  }
];

await main();

async function main(): Promise<void> {
  await mkdir(reportDir, { recursive: true });

  const coreResults = coreCases.map(runCoreCase);
  const pipelineResults = pipelineCases.map(runPipelineCase);
  const results = [...coreResults, ...pipelineResults];

  const aggregate = summarize(results);
  const core = summarize(coreResults);
  const pipeline = summarize(pipelineResults);
  const ok = aggregate.failedCount === 0;

  const jsonPath = join(reportDir, `${safeTimestamp}-dllm-verifier-report.json`);
  const markdownPath = join(reportDir, `${safeTimestamp}-dllm-verifier-report.md`);

  const report = {
    ok,
    reportName,
    suiteName,
    createdAt,
    aggregate,
    core,
    pipeline,
    results,
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
        core,
        pipeline,
        jsonPath,
        markdownPath
      },
      null,
      2
    )
  );
}

function runCoreCase(testCase: CoreReportCase): CaseResult {
  const output = runDllmStyleVerifier(testCase.input);

  return {
    id: testCase.id,
    kind: "core",
    expectedDecision: testCase.expectedDecision,
    actualDecision: output.decision,
    passed: output.decision === testCase.expectedDecision,
    signalCount: output.signals.length,
    maskRegionCount: output.maskRegions.length,
    approvedFileCount: output.approvedFiles.length,
    rejectedFileCount: output.rejectedFiles.length,
    summary: output.summary
  };
}

function runPipelineCase(testCase: PipelineReportCase): CaseResult {
  const output = runDllmVerifierOnPipelineCandidate(testCase.candidate);

  return {
    id: testCase.id,
    kind: "pipeline_candidate",
    expectedDecision: testCase.expectedDecision,
    actualDecision: output.decision,
    passed: output.decision === testCase.expectedDecision,
    signalCount: output.signals.length,
    maskRegionCount: output.maskRegions.length,
    approvedFileCount: output.approvedFiles.length,
    rejectedFileCount: output.rejectedFiles.length,
    summary: output.summary
  };
}

function summarize(results: CaseResult[]): SectionSummary {
  const passedCount = results.filter((result) => result.passed).length;

  return {
    caseCount: results.length,
    passedCount,
    failedCount: results.length - passedCount
  };
}

function reportToMarkdown(report: {
  reportName: string;
  suiteName: string;
  createdAt: string;
  aggregate: SectionSummary;
  core: SectionSummary;
  pipeline: SectionSummary;
  results: CaseResult[];
}): string {
  const lines: string[] = [];

  lines.push("# dLLM Verifier Report");
  lines.push("");
  lines.push(`- Report: \`${report.reportName}\``);
  lines.push(`- Suite: \`${report.suiteName}\``);
  lines.push(`- Created at: \`${report.createdAt}\``);
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push("| Section | Cases | Passed | Failed |");
  lines.push("| --- | ---: | ---: | ---: |");
  lines.push(`| Aggregate | ${report.aggregate.caseCount} | ${report.aggregate.passedCount} | ${report.aggregate.failedCount} |`);
  lines.push(`| Core verifier | ${report.core.caseCount} | ${report.core.passedCount} | ${report.core.failedCount} |`);
  lines.push(`| Pipeline candidate adapter | ${report.pipeline.caseCount} | ${report.pipeline.passedCount} | ${report.pipeline.failedCount} |`);
  lines.push("");

  lines.push("## Cases");
  lines.push("");
  lines.push("| Case | Kind | Expected | Actual | Passed | Signals | Mask Regions | Approved Files | Rejected Files |");
  lines.push("| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: |");

  for (const result of report.results) {
    lines.push(
      `| \`${result.id}\` | ${result.kind} | ${result.expectedDecision} | ${result.actualDecision} | ${result.passed} | ${result.signalCount} | ${result.maskRegionCount} | ${result.approvedFileCount} | ${result.rejectedFileCount} |`
    );
  }

  lines.push("");
  lines.push("## Case Summaries");
  lines.push("");

  for (const result of report.results) {
    lines.push(`### \`${result.id}\``);
    lines.push("");
    lines.push(`- Decision: \`${result.actualDecision}\``);
    lines.push(`- Passed: \`${result.passed}\``);
    lines.push(`- Summary: ${result.summary}`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}
