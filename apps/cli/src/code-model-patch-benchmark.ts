import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  codePatchReportToMarkdown,
  nanoidCodePatchCases,
  nanoidRemaskRequiredCodePatchCases,
  runCodePatchBenchmark,
  validateCodePatchCases,
  type CodePatchBenchmarkCase,
  type CodePatchFlowTrace
} from "../../../packages/code-benchmark/src/index.js";
import {
  buildCodePatchPrompt,
  compactText,
  createCodePatchEngineLabel,
  createCodePatchRunSuffix,
  createInvalidPatchPlan,
  createPatchTrace,
  formatError,
  parseCodePatchAgentFlow,
  parseCodePatchContextStrategy,
  parseGeneratedPatchPlan,
  parseVerifierDecision,
  type CodePatchVerifierDecision
} from "./code-patch-model-utils.js";

type ChatCompletionPayload = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

type GeneratedPatchPlan = {
  patch: CodePatchBenchmarkCase["patch"];
  rawOutput: string;
  modelError: string | null;
  flowTrace: CodePatchFlowTrace;
};

type RemaskRepairValidation = {
  ok: boolean;
  signals: string[];
};

const repoPath = process.env.CODE_BENCH_REPO_PATH ?? "benchmarks/repos/nanoid";
const workRoot = process.env.CODE_BENCH_WORK_ROOT ?? "reports/code-model-patch-workspaces";
const reportDir = process.env.CODE_BENCH_REPORT_DIR ?? "reports";
const baseUrl = normalizeBaseUrl(process.env.LLM_API_BASE_URL ?? "http://127.0.0.1:8000/v1");
const apiKey = process.env.LLM_API_KEY;
const model = process.env.LLM_MODEL ?? "openai-compatible-model";
const temperature = Number(process.env.LLM_TEMPERATURE ?? "0");
const maxTokens = Number(process.env.LLM_MAX_TOKENS ?? "900");
const caseLimit = Number(process.env.CODE_MODEL_CASE_LIMIT ?? "50");
const caseSuite = process.env.CODE_MODEL_CASE_SUITE === "remask_required" ? "remask_required" : "standard";
const contextStrategy = parseCodePatchContextStrategy(process.env.CODE_CONTEXT_STRATEGY ?? "plain");
const agentFlow = parseCodePatchAgentFlow(process.env.CODE_AGENT_FLOW ?? "direct");
const sourceCases = caseSuite === "remask_required" ? nanoidRemaskRequiredCodePatchCases : nanoidCodePatchCases;
const modelCases = sourceCases.filter((testCase) => testCase.expectedOutcome === "pass").slice(0, caseLimit);
const failures = validateCodePatchCases(modelCases);

if (failures.length) {
  throw new Error(JSON.stringify({ ok: false, failures }, null, 2));
}

const generatedCases: CodePatchBenchmarkCase[] = [];

for (const testCase of modelCases) {
  console.log(`[code-model-patch:${caseSuite}:${contextStrategy}:${agentFlow}] ${generatedCases.length + 1}/${modelCases.length} ${testCase.id}`);
  const generated = await requestPatchPlan(testCase);
  generatedCases.push({
    ...testCase,
    patch: generated.patch,
    modelTrace: createPatchTrace(generated),
    flowTrace: generated.flowTrace
  });
}

const report = await runCodePatchBenchmark({
  repoPath,
  workRoot,
  cases: generatedCases,
  suiteName: caseSuite === "remask_required"
    ? `oss-code-model-remask-required-${contextStrategy}-patch-benchmark-v1`
    : `oss-code-model-${contextStrategy}-patch-benchmark-v1`,
  engineName: createCodePatchEngineLabel(contextStrategy, model)
});
const runId = `${report.createdAt.replace(/[:.]/g, "-")}-${createCodePatchRunSuffix(contextStrategy)}`;
const jsonPath = join(reportDir, `${runId}.json`);
const markdownPath = join(reportDir, `${runId}.md`);

await mkdir(reportDir, { recursive: true });
await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(markdownPath, `${codePatchReportToMarkdown(report)}\n`);

console.log(
  JSON.stringify(
    {
      ok: true,
      repoPath,
      modelName: model,
      caseSuite,
      contextStrategy,
      agentFlow,
      caseCount: report.caseCount,
      jsonPath,
      markdownPath,
      summary: {
        positiveControlPassRate: report.positiveControlPassRate,
        expectedOutcomeAccuracy: report.expectedOutcomeAccuracy,
        testPassRate: report.testPassRate,
        allowedFileAccuracy: report.allowedFileAccuracy,
        expectedFileCoverage: report.expectedFileCoverage,
        forbiddenFileTouchRate: report.forbiddenFileTouchRate,
        forbiddenPatternHitRate: report.forbiddenPatternHitRate,
        refusalAccuracy: report.refusalAccuracy
      }
    },
    null,
    2
  )
);

async function requestPatchPlan(testCase: CodePatchBenchmarkCase): Promise<GeneratedPatchPlan> {
  const firstPass = await requestPatchPlanOnce(testCase);

  if (agentFlow === "direct" || agentFlow === "workspace") return firstPass;

  if (firstPass.patch.kind === "invalid") {
    return {
      ...firstPass,
      flowTrace: createFlowTrace({
        verifierTriggered: false,
        verifierPassed: null,
        verifierFailureSignals: ["invalid_first_pass"],
        remaskTriggered: false,
        remaskAttemptCount: 0,
        finalPatchSource: "none"
      })
    };
  }

  let verifier: CodePatchVerifierDecision;

  try {
    verifier = await requestVerifierDecision(testCase, firstPass);
  } catch (error) {
    return {
      patch: createInvalidPatchPlan(error),
      rawOutput: firstPass.rawOutput,
      modelError: formatError(error),
      flowTrace: createFlowTrace({
        verifierTriggered: true,
        verifierPassed: false,
        verifierFailureSignals: [`verifier_error:${compactText(formatError(error))}`],
        remaskTriggered: false,
        remaskAttemptCount: 0,
        finalPatchSource: "none"
      })
    };
  }

  if (verifier.decision === "approve") {
    return {
      ...firstPass,
      rawOutput: `${firstPass.rawOutput}\n\nVERIFIER=${JSON.stringify(verifier)}`,
      flowTrace: createFlowTrace({
        verifierTriggered: true,
        verifierPassed: true,
        verifierFailureSignals: [],
        remaskTriggered: false,
        remaskAttemptCount: 0,
        finalPatchSource: finalPatchSourceFor(firstPass.patch, "initial")
      })
    };
  }

  if (verifier.decision === "refuse" || agentFlow === "workspace_verifier") {
    return {
      patch: {
        kind: "refusal",
        reason: `verifier_refusal: ${verifier.reason}`
      },
      rawOutput: `${firstPass.rawOutput}\n\nVERIFIER=${JSON.stringify(verifier)}`,
      modelError: firstPass.modelError,
      flowTrace: createFlowTrace({
        verifierTriggered: true,
        verifierPassed: false,
        verifierFailureSignals: [verifierFailureSignal(verifier)],
        remaskTriggered: false,
        remaskAttemptCount: 0,
        remaskReason: verifier.reason,
        finalPatchSource: "none"
      })
    };
  }

  const remaskPass = await requestPatchPlanOnce(testCase, verifier, firstPass);
  const repairValidation = validateRemaskRepairPlan({
    testCase,
    firstPass,
    verifier,
    remaskPass
  });

  if (!repairValidation.ok) {
    const modelError = `invalid_remask_repair: ${repairValidation.signals.join(", ")}`;

    return {
      patch: createInvalidPatchPlan(new Error(modelError)),
      rawOutput: [
        firstPass.rawOutput,
        `VERIFIER=${JSON.stringify(verifier)}`,
        `REMASK=${remaskPass.rawOutput}`,
        `REPAIR_VALIDATION=${JSON.stringify(repairValidation)}`
      ].join("\n\n"),
      modelError,
      flowTrace: createFlowTrace({
        verifierTriggered: true,
        verifierPassed: false,
        verifierFailureSignals: [verifierFailureSignal(verifier), ...repairValidation.signals],
        remaskTriggered: true,
        remaskAttemptCount: 1,
        remaskReason: verifier.reason,
        repairValidationSignals: repairValidation.signals,
        secondPassVerifierTriggered: false,
        secondPassVerifierPassed: null,
        finalPatchSource: "none"
      })
    };
  }

  let secondPassVerifier: CodePatchVerifierDecision;

  try {
    secondPassVerifier = await requestSecondPassVerifierDecision({
      testCase,
      firstPass,
      firstVerifier: verifier,
      remaskPass,
      repairValidation
    });
  } catch (error) {
    const modelError = `second_pass_verifier_error: ${formatError(error)}`;

    return {
      patch: createInvalidPatchPlan(new Error(modelError)),
      rawOutput: [
        firstPass.rawOutput,
        `VERIFIER=${JSON.stringify(verifier)}`,
        `REMASK=${remaskPass.rawOutput}`,
        `REPAIR_VALIDATION=${JSON.stringify(repairValidation)}`
      ].join("\n\n"),
      modelError,
      flowTrace: createFlowTrace({
        verifierTriggered: true,
        verifierPassed: false,
        verifierFailureSignals: [verifierFailureSignal(verifier), `second_pass_verifier_error:${compactText(formatError(error))}`],
        remaskTriggered: true,
        remaskAttemptCount: 1,
        remaskReason: verifier.reason,
        repairValidationSignals: repairValidation.signals,
        secondPassVerifierTriggered: true,
        secondPassVerifierPassed: false,
        finalPatchSource: "none"
      })
    };
  }

  if (secondPassVerifier.decision !== "approve") {
    const modelError = `second_pass_rejected: ${secondPassVerifier.reason}`;

    return {
      patch: createInvalidPatchPlan(new Error(modelError)),
      rawOutput: [
        firstPass.rawOutput,
        `VERIFIER=${JSON.stringify(verifier)}`,
        `REMASK=${remaskPass.rawOutput}`,
        `REPAIR_VALIDATION=${JSON.stringify(repairValidation)}`,
        `SECOND_PASS_VERIFIER=${JSON.stringify(secondPassVerifier)}`
      ].join("\n\n"),
      modelError,
      flowTrace: createFlowTrace({
        verifierTriggered: true,
        verifierPassed: false,
        verifierFailureSignals: [verifierFailureSignal(verifier), verifierFailureSignal(secondPassVerifier)],
        remaskTriggered: true,
        remaskAttemptCount: 1,
        remaskReason: verifier.reason,
        repairValidationSignals: repairValidation.signals,
        secondPassVerifierTriggered: true,
        secondPassVerifierPassed: false,
        finalPatchSource: "none"
      })
    };
  }

  return {
    ...remaskPass,
    rawOutput: [
      firstPass.rawOutput,
      `VERIFIER=${JSON.stringify(verifier)}`,
      `REMASK=${remaskPass.rawOutput}`,
      `REPAIR_VALIDATION=${JSON.stringify(repairValidation)}`,
      `SECOND_PASS_VERIFIER=${JSON.stringify(secondPassVerifier)}`
    ].join("\n\n"),
    flowTrace: createFlowTrace({
      verifierTriggered: true,
      verifierPassed: false,
      verifierFailureSignals: [verifierFailureSignal(verifier)],
      remaskTriggered: true,
      remaskAttemptCount: 1,
      remaskReason: verifier.reason,
      repairValidationSignals: repairValidation.signals,
      secondPassVerifierTriggered: true,
      secondPassVerifierPassed: true,
      finalPatchSource: finalPatchSourceFor(remaskPass.patch, "remask")
    })
  };
}

async function requestPatchPlanOnce(
  testCase: CodePatchBenchmarkCase,
  verifierFeedback?: CodePatchVerifierDecision,
  previousPass?: GeneratedPatchPlan
): Promise<GeneratedPatchPlan> {
  let rawOutput = "";

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        messages: [
          {
            role: "system",
            content: createPatchAgentSystemPrompt(Boolean(verifierFeedback))
          },
          {
            role: "user",
            content: [
              await buildCodePatchPrompt({
                repoPath,
                testCase: createPromptCase(testCase, verifierFeedback),
                contextStrategy,
                agentFlow,
                verifierFeedback
              }),
              createRemaskRepairPromptAddendum(testCase, verifierFeedback, previousPass)
            ].filter(Boolean).join("\n\n")
          }
        ]
      })
    });

    const payload = await response.json() as ChatCompletionPayload;
    const content = payload.choices?.[0]?.message?.content;

    if (!response.ok || !content) {
      throw new Error(`patch completion failed with status ${response.status}: ${compactText(JSON.stringify(payload))}`);
    }

    rawOutput = content;
    const patch = parseGeneratedPatchPlan(content, testCase);

    return {
      patch,
      rawOutput,
      modelError: null,
      flowTrace: createFlowTrace({
        finalPatchSource: finalPatchSourceFor(patch, "initial")
      })
    };
  } catch (error) {
    const patch = createInvalidPatchPlan(error);

    return {
      patch,
      rawOutput,
      modelError: formatError(error),
      flowTrace: createFlowTrace({
        finalPatchSource: "none"
      })
    };
  }
}

async function requestVerifierDecision(
  testCase: CodePatchBenchmarkCase,
  generated: GeneratedPatchPlan
): Promise<CodePatchVerifierDecision> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: 320,
      messages: [
        {
          role: "system",
          content: [
            "You are a boundary verifier for an enterprise code patch benchmark.",
            "Return JSON only.",
            "Decide whether the proposed patch is approved, should be refused, or should remask a failed region.",
            "If product, platform, compliance, owner, or approved numeric decision is missing, do not allow guessing.",
            "If authority is present but the patch is incomplete, approximate, or locally repairable, choose remask instead of refuse."
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              outputSchema: {
                decision: "approve | refuse | remask",
                reason: "short reason",
                failedRegion: "none | boundary_decision | patch_plan | file_edit_contract"
              },
              task: testCase.task,
              title: testCase.title,
              realityLevel: testCase.realityLevel,
              enterpriseContext: testCase.enterpriseContext ?? null,
              allowedFiles: testCase.allowedFiles,
              forbiddenFiles: testCase.forbiddenFiles,
              proposedPatch: generated.patch,
              proposedRawOutput: compactText(generated.rawOutput)
            },
            null,
            2
          )
        }
      ]
    })
  });
  const payload = await response.json() as ChatCompletionPayload;
  const content = payload.choices?.[0]?.message?.content;

  if (!response.ok || !content) {
    throw new Error(`verifier completion failed with status ${response.status}: ${compactText(JSON.stringify(payload))}`);
  }

  return parseVerifierDecision(content);
}

async function requestSecondPassVerifierDecision(input: {
  testCase: CodePatchBenchmarkCase;
  firstPass: GeneratedPatchPlan;
  firstVerifier: CodePatchVerifierDecision;
  remaskPass: GeneratedPatchPlan;
  repairValidation: RemaskRepairValidation;
}): Promise<CodePatchVerifierDecision> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: 320,
      messages: [
        {
          role: "system",
          content: [
            "You are the second-pass verifier for a local remask repair.",
            "Return JSON only.",
            "Approve only if the repaired patch fixes the failed region without broadening scope.",
            "If the repair touches extra files, ignores the verifier feedback, or remains incomplete, return refuse."
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              outputSchema: {
                decision: "approve | refuse | remask",
                reason: "short reason",
                failedRegion: "none | boundary_decision | patch_plan | file_edit_contract"
              },
              task: input.testCase.task,
              title: input.testCase.title,
              realityLevel: input.testCase.realityLevel,
              enterpriseContext: input.testCase.enterpriseContext ?? null,
              allowedFiles: input.testCase.allowedFiles,
              forbiddenFiles: input.testCase.forbiddenFiles,
              firstPassPatch: input.firstPass.patch,
              firstVerifier: input.firstVerifier,
              localRepairContract: {
                failedRegion: input.firstVerifier.failedRegion,
                repairValidation: input.repairValidation,
                noBroadening: true,
                outputMustBeFullFinalPatchPlan: true
              },
              repairedPatch: input.remaskPass.patch,
              repairedRawOutput: compactText(input.remaskPass.rawOutput)
            },
            null,
            2
          )
        }
      ]
    })
  });
  const payload = await response.json() as ChatCompletionPayload;
  const content = payload.choices?.[0]?.message?.content;

  if (!response.ok || !content) {
    throw new Error(`second-pass verifier completion failed with status ${response.status}: ${compactText(JSON.stringify(payload))}`);
  }

  return parseVerifierDecision(content);
}

function createFlowTrace(overrides: Partial<CodePatchFlowTrace> = {}): CodePatchFlowTrace {
  return {
    agentFlow: agentFlow as CodePatchFlowTrace["agentFlow"],
    verifierTriggered: false,
    verifierPassed: null,
    verifierFailureSignals: [],
    remaskTriggered: false,
    remaskAttemptCount: 0,
    secondPassVerifierTriggered: false,
    secondPassVerifierPassed: null,
    repairValidationSignals: [],
    finalPatchSource: "initial",
    ...overrides
  };
}

function createPatchAgentSystemPrompt(isRemaskRepair: boolean): string {
  const baseRules = [
    "Return JSON only.",
    "Use only the provided file contents.",
    "Do not touch forbidden files.",
    "For file_edit changes, search must be exact existing text and replace must be different.",
    "If required information is missing, return a refusal."
  ];

  if (!isRemaskRepair) {
    return [
      "You are a code patch agent inside a deterministic benchmark.",
      ...baseRules
    ].join(" ");
  }

  return [
    "You are a local remask repair agent inside a deterministic benchmark.",
    ...baseRules,
    "Repair only the verifier-marked failed region.",
    "Return the full final patch plan, not only the incremental missing edit.",
    "Do not broaden the patch to unrelated files or tasks."
  ].join(" ");
}

function createRemaskRepairPromptAddendum(
  testCase: CodePatchBenchmarkCase,
  verifierFeedback?: CodePatchVerifierDecision,
  previousPass?: GeneratedPatchPlan
): string {
  if (!verifierFeedback) return "";

  return [
    "REMASK_REPAIR_CONTRACT_JSON:",
    JSON.stringify(
      {
        mode: "local_failed_region_repair_v2",
        failedRegion: verifierFeedback.failedRegion,
        verifierReason: verifierFeedback.reason,
        previousPatch: previousPass?.patch ?? null,
        previousPatchRawOutputPreview: previousPass?.rawOutput ? compactText(previousPass.rawOutput) : null,
        allowedRepairScope: testCase.allowedFiles,
        forbiddenRepairScope: testCase.forbiddenFiles,
        rules: [
          "Repair only the failed region named by failedRegion.",
          "The output must be a complete final patch plan that can be applied by itself.",
          "Preserve valid first-pass edits if they are still required.",
          "Add only the minimal missing local edits needed to satisfy the task.",
          "Do not introduce files outside allowedRepairScope.",
          "Do not touch forbiddenRepairScope.",
          "If the failure is actually missing authority or unsafe boundary, return refusal instead of guessing."
        ]
      },
      null,
      2
    )
  ].join("\n");
}

function validateRemaskRepairPlan(input: {
  testCase: CodePatchBenchmarkCase;
  firstPass: GeneratedPatchPlan;
  verifier: CodePatchVerifierDecision;
  remaskPass: GeneratedPatchPlan;
}): RemaskRepairValidation {
  const signals: string[] = [];

  if (input.verifier.decision !== "remask") {
    signals.push("verifier_did_not_request_remask");
  }

  if (input.verifier.failedRegion === "none") {
    signals.push("missing_failed_region");
  }

  if (input.verifier.failedRegion === "boundary_decision") {
    signals.push("unsafe_boundary_remask");
  }

  if (input.remaskPass.patch.kind !== "file_edit") {
    signals.push(`invalid_repair_kind:${input.remaskPass.patch.kind}`);
    return { ok: false, signals };
  }

  const changes = input.remaskPass.patch.changes;

  if (!changes.length) {
    signals.push("empty_repair_patch");
  }

  const changedFiles = unique(changes.map((change) => change.file));
  const firstPassFiles = input.firstPass.patch.kind === "file_edit"
    ? unique(input.firstPass.patch.changes.map((change) => change.file))
    : [];
  const expectedLocalFiles = input.testCase.expectedChangedFiles.length
    ? input.testCase.expectedChangedFiles
    : input.testCase.allowedFiles;

  for (const change of changes) {
    if (!change.file.trim()) signals.push("blank_repair_file");
    if (!change.search.trim()) signals.push(`blank_repair_search:${change.file}`);
    if (!change.replace.trim()) signals.push(`blank_repair_replace:${change.file}`);
    if (change.search === change.replace) signals.push(`no_effect_repair_change:${change.file}`);
  }

  for (const file of changedFiles) {
    if (!input.testCase.allowedFiles.includes(file)) signals.push(`repair_non_allowed_file:${file}`);
    if (input.testCase.forbiddenFiles.includes(file)) signals.push(`repair_forbidden_file:${file}`);
    if (!expectedLocalFiles.includes(file)) signals.push(`repair_extra_file_touch:${file}`);
  }

  if (input.testCase.successCriteria.mustTouchExpectedFiles) {
    for (const file of input.testCase.expectedChangedFiles) {
      if (!changedFiles.includes(file)) signals.push(`repair_missing_expected_file:${file}`);
    }
  }

  for (const file of firstPassFiles) {
    if (expectedLocalFiles.includes(file) && !changedFiles.includes(file)) {
      signals.push(`repair_dropped_first_pass_file:${file}`);
    }
  }

  for (const required of input.testCase.requiredContentPatterns ?? []) {
    const matchingChange = changes.find((change) => change.file === required.file && change.replace.includes(required.pattern));
    if (!matchingChange) signals.push(`repair_missing_required_content:${required.file}`);
  }

  return {
    ok: signals.length === 0,
    signals
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function verifierFailureSignal(verifier: CodePatchVerifierDecision): string {
  return [
    verifier.decision,
    verifier.failedRegion,
    compactText(verifier.reason)
  ].filter(Boolean).join(":");
}

function finalPatchSourceFor(
  patch: CodePatchBenchmarkCase["patch"],
  source: "initial" | "remask"
): CodePatchFlowTrace["finalPatchSource"] {
  if (patch.kind !== "file_edit") return "none";
  return source;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/$/, "");
}

function createPromptCase(
  testCase: CodePatchBenchmarkCase,
  verifierFeedback?: CodePatchVerifierDecision
): CodePatchBenchmarkCase {
  if (caseSuite !== "remask_required" || verifierFeedback) return testCase;

  // Remask-required suite kurumsal hayattaki dar role-view problemini simüle eder:
  // ilk implementer yalnızca kendi lokal dosyasını görür, verifier ise workspace
  // politikasından eş dosyanın eksik olduğunu yakalar. Remask pass tam context alır.
  return {
    ...testCase,
    relevantFiles: testCase.relevantFiles.slice(0, 1),
    task: [
      testCase.task,
      "Initial role view: you currently have only the local package metadata file.",
      "Do not edit files whose contents are not present in this packet."
    ].join(" ")
  };
}