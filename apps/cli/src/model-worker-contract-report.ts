import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

type JsonRecord = Record<string, unknown>;

type ModelWorkerKind = "llm" | "dllm";
type ModelWorkerDecision = "approve" | "needs_review" | "reject";
type DllmRecommendedAction = "approve" | "remask_required" | "reject";

type ModelWorkerContractRequest = {
  kind: ModelWorkerKind;
  modelId: string;
  taskId: string;
  input: {
    changedFiles: string[];
    proposedTouchedFiles: string[];
    allowedFiles: string[];
    requiredFiles: string[];
    unresolvedConflicts: Array<{
      kind: string;
      filePath?: string;
    }>;
    proposedAddedLines: string[];
  };
  acceptanceCriteria: {
    allowedDecisions: ModelWorkerDecision[];
    requireReasoning: boolean;
    requireTokenUsageWhenAvailable: boolean;
  };
};

type ModelWorkerContractCase = {
  id: string;
  description: string;
  expectedValid: boolean;
  request: ModelWorkerContractRequest;
  response: unknown;
};

type ModelWorkerContractCaseResult = {
  id: string;
  description: string;
  expectedValid: boolean;
  actualValid: boolean;
  passed: boolean;
  requestErrorCount: number;
  responseErrorCount: number;
  errors: string[];
};

const reportName = "model-worker-contract-report-v1";
const suiteName = "real-model-worker-acceptance-dry-run-contract";
const createdAt = new Date().toISOString();
const safeTimestamp = createdAt.replace(/[:.]/g, "-");
const outputDir = "reports/model-worker-contract";

const allowedDecisions: ModelWorkerDecision[] = [
  "approve",
  "needs_review",
  "reject"
];

const allowedDllmRecommendedActions: DllmRecommendedAction[] = [
  "approve",
  "remask_required",
  "reject"
];

const baseRequest: ModelWorkerContractRequest = {
  kind: "llm",
  modelId: "mock-llm-worker",
  taskId: "model_worker_contract_base",
  input: {
    changedFiles: ["packages/code-benchmark/src/index.ts"],
    proposedTouchedFiles: ["packages/code-benchmark/src/index.ts"],
    allowedFiles: ["packages/code-benchmark/src/index.ts"],
    requiredFiles: ["packages/code-benchmark/src/index.ts"],
    unresolvedConflicts: [],
    proposedAddedLines: ["const verified = true;"]
  },
  acceptanceCriteria: {
    allowedDecisions,
    requireReasoning: true,
    requireTokenUsageWhenAvailable: true
  }
};

const cases: ModelWorkerContractCase[] = [
  {
    id: "valid_llm_approve_response",
    description: "LLM worker returns a valid approve response with consistent token usage.",
    expectedValid: true,
    request: baseRequest,
    response: {
      ok: true,
      modelId: "mock-llm-worker",
      decision: "approve",
      reasoning: "Patch is scoped to the requested file and no blocking risks were detected.",
      usage: {
        promptTokens: 120,
        completionTokens: 40,
        totalTokens: 160
      }
    }
  },
  {
    id: "valid_dllm_needs_review_with_remask_metadata",
    description: "dLLM worker keeps top-level decision compatible while exposing remask metadata.",
    expectedValid: true,
    request: {
      ...baseRequest,
      kind: "dllm",
      modelId: "mock-dllm-worker",
      taskId: "valid_dllm_needs_review_with_remask_metadata",
      input: {
        ...baseRequest.input,
        unresolvedConflicts: [
          {
            kind: "remask_unresolved",
            filePath: "packages/code-benchmark/src/index.ts"
          }
        ]
      }
    },
    response: {
      ok: true,
      modelId: "mock-dllm-worker",
      decision: "needs_review",
      reasoning: "The candidate should be remasked around the unresolved conflict before approval.",
      usage: {
        promptTokens: 100,
        completionTokens: 35,
        totalTokens: 135
      },
      dllmVerifier: {
        recommendedAction: "remask_required",
        signalCount: 1,
        maskRegionCount: 1
      }
    }
  },
  {
    id: "invalid_unknown_decision",
    description: "Worker response with an unknown top-level decision must be rejected.",
    expectedValid: false,
    request: baseRequest,
    response: {
      ok: true,
      modelId: "mock-llm-worker",
      decision: "remask_required",
      reasoning: "This is invalid at the model-worker acceptance layer."
    }
  },
  {
    id: "invalid_missing_reasoning",
    description: "Worker response without reasoning must be rejected.",
    expectedValid: false,
    request: baseRequest,
    response: {
      ok: true,
      modelId: "mock-llm-worker",
      decision: "approve",
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15
      }
    }
  },
  {
    id: "invalid_token_total_mismatch",
    description: "Worker response with inconsistent token totals must be rejected.",
    expectedValid: false,
    request: baseRequest,
    response: {
      ok: true,
      modelId: "mock-llm-worker",
      decision: "approve",
      reasoning: "Token totals are inconsistent.",
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 99
      }
    }
  },
  {
    id: "invalid_dllm_approve_with_remask_required",
    description: "dLLM metadata cannot recommend remask_required while top-level decision is approve.",
    expectedValid: false,
    request: {
      ...baseRequest,
      kind: "dllm",
      modelId: "mock-dllm-worker",
      taskId: "invalid_dllm_approve_with_remask_required"
    },
    response: {
      ok: true,
      modelId: "mock-dllm-worker",
      decision: "approve",
      reasoning: "Contradictory dLLM metadata.",
      dllmVerifier: {
        recommendedAction: "remask_required",
        signalCount: 1,
        maskRegionCount: 1
      }
    }
  }
];

await main();

async function main(): Promise<void> {
  await mkdir(outputDir, { recursive: true });

  const results = cases.map(runCase);
  const passedCount = results.filter((result) => result.passed).length;
  const failedCount = results.length - passedCount;

  const aggregate = {
    caseCount: results.length,
    passedCount,
    failedCount,
    validAcceptedCount: results.filter(
      (result) => result.expectedValid && result.actualValid
    ).length,
    invalidRejectedCount: results.filter(
      (result) => !result.expectedValid && !result.actualValid
    ).length,
    unexpectedAcceptedCount: results.filter(
      (result) => !result.expectedValid && result.actualValid
    ).length,
    unexpectedRejectedCount: results.filter(
      (result) => result.expectedValid && !result.actualValid
    ).length
  };

  const ok = failedCount === 0;
  const jsonPath = join(outputDir, `${safeTimestamp}-model-worker-contract-report.json`);
  const markdownPath = join(outputDir, `${safeTimestamp}-model-worker-contract-report.md`);

  const report = {
    ok,
    reportName,
    suiteName,
    createdAt,
    aggregate,
    contract: {
      endpointMethod: "POST",
      expectedRequestShape: {
        kind: "llm | dllm",
        modelId: "string",
        taskId: "string",
        input: {
          changedFiles: "string[]",
          proposedTouchedFiles: "string[]",
          allowedFiles: "string[]",
          requiredFiles: "string[]",
          unresolvedConflicts: "{ kind: string; filePath?: string }[]",
          proposedAddedLines: "string[]"
        },
        acceptanceCriteria: {
          allowedDecisions,
          requireReasoning: true,
          requireTokenUsageWhenAvailable: true
        }
      },
      expectedResponseShape: {
        ok: "boolean",
        modelId: "string",
        decision: allowedDecisions,
        reasoning: "string",
        usage: {
          promptTokens: "number",
          completionTokens: "number",
          totalTokens: "number"
        },
        dllmVerifier: {
          recommendedAction: allowedDllmRecommendedActions,
          signalCount: "number",
          maskRegionCount: "number"
        }
      }
    },
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
        validAcceptedCount: aggregate.validAcceptedCount,
        invalidRejectedCount: aggregate.invalidRejectedCount,
        unexpectedAcceptedCount: aggregate.unexpectedAcceptedCount,
        unexpectedRejectedCount: aggregate.unexpectedRejectedCount,
        jsonPath,
        markdownPath
      },
      null,
      2
    )
  );
}

function runCase(testCase: ModelWorkerContractCase): ModelWorkerContractCaseResult {
  const requestErrors = validateRequest(testCase.request);
  const responseErrors = validateResponse(testCase.response);
  const errors = [...requestErrors, ...responseErrors];
  const actualValid = errors.length === 0;

  return {
    id: testCase.id,
    description: testCase.description,
    expectedValid: testCase.expectedValid,
    actualValid,
    passed: actualValid === testCase.expectedValid,
    requestErrorCount: requestErrors.length,
    responseErrorCount: responseErrors.length,
    errors
  };
}

function validateRequest(request: ModelWorkerContractRequest): string[] {
  const errors: string[] = [];

  if (!["llm", "dllm"].includes(request.kind)) {
    errors.push("request.kind must be llm or dllm");
  }

  if (!request.modelId) {
    errors.push("request.modelId is required");
  }

  if (!request.taskId) {
    errors.push("request.taskId is required");
  }

  if (request.input.changedFiles.length === 0) {
    errors.push("request.input.changedFiles must not be empty");
  }

  if (request.input.proposedTouchedFiles.length === 0) {
    errors.push("request.input.proposedTouchedFiles must not be empty");
  }

  if (request.input.allowedFiles.length === 0) {
    errors.push("request.input.allowedFiles must not be empty");
  }

  if (request.input.requiredFiles.length === 0) {
    errors.push("request.input.requiredFiles must not be empty");
  }

  const unsupportedDecision = request.acceptanceCriteria.allowedDecisions.find(
    (decision) => !allowedDecisions.includes(decision)
  );

  if (unsupportedDecision) {
    errors.push(`request.acceptanceCriteria.allowedDecisions contains unsupported decision: ${unsupportedDecision}`);
  }

  return errors;
}

function validateResponse(value: unknown): string[] {
  const response = asRecord(value);
  const errors: string[] = [];

  if (typeof response.ok !== "boolean") {
    errors.push("response.ok must be boolean");
  }

  if (typeof response.modelId !== "string" || response.modelId.length === 0) {
    errors.push("response.modelId must be non-empty string");
  }

  const decision = response.decision;

  if (
    typeof decision !== "string" ||
    !allowedDecisions.includes(decision as ModelWorkerDecision)
  ) {
    errors.push(
      `response.decision must be one of: ${allowedDecisions.join(", ")}`
    );
  }

  if (typeof response.reasoning !== "string" || response.reasoning.trim().length === 0) {
    errors.push("response.reasoning must be non-empty string");
  }

  if (response.usage !== undefined) {
    errors.push(...validateUsage(response.usage));
  }

  if (response.dllmVerifier !== undefined) {
    errors.push(...validateDllmVerifierMetadata(response.dllmVerifier, decision));
  }

  return errors;
}

function validateUsage(value: unknown): string[] {
  const usage = asRecord(value);
  const errors: string[] = [];

  const promptTokens = numberValue(usage.promptTokens);
  const completionTokens = numberValue(usage.completionTokens);
  const totalTokens = numberValue(usage.totalTokens);

  if (promptTokens === null || promptTokens < 0) {
    errors.push("response.usage.promptTokens must be a non-negative number");
  }

  if (completionTokens === null || completionTokens < 0) {
    errors.push("response.usage.completionTokens must be a non-negative number");
  }

  if (totalTokens === null || totalTokens < 0) {
    errors.push("response.usage.totalTokens must be a non-negative number");
  }

  if (
    promptTokens !== null &&
    completionTokens !== null &&
    totalTokens !== null &&
    promptTokens + completionTokens !== totalTokens
  ) {
    errors.push("response.usage.totalTokens must equal promptTokens + completionTokens");
  }

  return errors;
}

function validateDllmVerifierMetadata(value: unknown, decision: unknown): string[] {
  const metadata = asRecord(value);
  const errors: string[] = [];

  const recommendedAction = metadata.recommendedAction;

  if (
    typeof recommendedAction !== "string" ||
    !allowedDllmRecommendedActions.includes(recommendedAction as DllmRecommendedAction)
  ) {
    errors.push(
      `response.dllmVerifier.recommendedAction must be one of: ${allowedDllmRecommendedActions.join(", ")}`
    );
  }

  const signalCount = numberValue(metadata.signalCount);
  const maskRegionCount = numberValue(metadata.maskRegionCount);

  if (signalCount === null || signalCount < 0) {
    errors.push("response.dllmVerifier.signalCount must be a non-negative number");
  }

  if (maskRegionCount === null || maskRegionCount < 0) {
    errors.push("response.dllmVerifier.maskRegionCount must be a non-negative number");
  }

  if (decision === "approve" && recommendedAction === "remask_required") {
    errors.push("response.decision cannot be approve when dllmVerifier recommends remask_required");
  }

  return errors;
}

function asRecord(value: unknown): JsonRecord {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as JsonRecord;
  }

  return {};
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function reportToMarkdown(report: {
  reportName: string;
  suiteName: string;
  createdAt: string;
  aggregate: {
    caseCount: number;
    passedCount: number;
    failedCount: number;
    validAcceptedCount: number;
    invalidRejectedCount: number;
    unexpectedAcceptedCount: number;
    unexpectedRejectedCount: number;
  };
  results: ModelWorkerContractCaseResult[];
}): string {
  const lines: string[] = [];

  lines.push("# Model Worker Contract Report");
  lines.push("");
  lines.push(`- Report: \`${report.reportName}\``);
  lines.push(`- Suite: \`${report.suiteName}\``);
  lines.push(`- Created at: \`${report.createdAt}\``);
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | ---: |");
  lines.push(`| Case count | ${report.aggregate.caseCount} |`);
  lines.push(`| Passed | ${report.aggregate.passedCount} |`);
  lines.push(`| Failed | ${report.aggregate.failedCount} |`);
  lines.push(`| Valid accepted | ${report.aggregate.validAcceptedCount} |`);
  lines.push(`| Invalid rejected | ${report.aggregate.invalidRejectedCount} |`);
  lines.push(`| Unexpected accepted | ${report.aggregate.unexpectedAcceptedCount} |`);
  lines.push(`| Unexpected rejected | ${report.aggregate.unexpectedRejectedCount} |`);
  lines.push("");

  lines.push("## Cases");
  lines.push("");
  lines.push("| Case | Expected Valid | Actual Valid | Passed | Request Errors | Response Errors |");
  lines.push("| --- | --- | --- | --- | ---: | ---: |");

  for (const result of report.results) {
    lines.push(
      `| \`${result.id}\` | ${result.expectedValid} | ${result.actualValid} | ${result.passed} | ${result.requestErrorCount} | ${result.responseErrorCount} |`
    );
  }

  lines.push("");
  lines.push("## Case Details");
  lines.push("");

  for (const result of report.results) {
    lines.push(`### \`${result.id}\``);
    lines.push("");
    lines.push(result.description);
    lines.push("");
    lines.push(`- Expected valid: \`${result.expectedValid}\``);
    lines.push(`- Actual valid: \`${result.actualValid}\``);
    lines.push(`- Passed: \`${result.passed}\``);

    if (result.errors.length > 0) {
      lines.push("- Errors:");
      for (const error of result.errors) {
        lines.push(`  - ${error}`);
      }
    } else {
      lines.push("- Errors: none");
    }

    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}
