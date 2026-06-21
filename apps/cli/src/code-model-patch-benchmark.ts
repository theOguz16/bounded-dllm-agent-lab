import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  codePatchReportToMarkdown,
  nanoidCodePatchCases,
  runCodePatchBenchmark,
  validateCodePatchCases,
  type CodePatchBenchmarkCase
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
const contextStrategy = parseCodePatchContextStrategy(process.env.CODE_CONTEXT_STRATEGY ?? "plain");
const agentFlow = parseCodePatchAgentFlow(process.env.CODE_AGENT_FLOW ?? "direct");
const modelCases = nanoidCodePatchCases.filter((testCase) => testCase.expectedOutcome === "pass").slice(0, caseLimit);
const failures = validateCodePatchCases(modelCases);

if (failures.length) {
  throw new Error(JSON.stringify({ ok: false, failures }, null, 2));
}

const generatedCases: CodePatchBenchmarkCase[] = [];

for (const testCase of modelCases) {
  console.log(`[code-model-patch:${contextStrategy}:${agentFlow}] ${generatedCases.length + 1}/${modelCases.length} ${testCase.id}`);
  const generated = await requestPatchPlan(testCase);
  generatedCases.push({
    ...testCase,
    patch: generated.patch,
    modelTrace: createPatchTrace(generated)
  });
}

const report = await runCodePatchBenchmark({
  repoPath,
  workRoot,
  cases: generatedCases,
  suiteName: `oss-code-model-${contextStrategy}-patch-benchmark-v1`,
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
  if (firstPass.patch.kind === "invalid") return firstPass;

  let verifier: CodePatchVerifierDecision;

  try {
    verifier = await requestVerifierDecision(testCase, firstPass);
  } catch (error) {
    return {
      patch: createInvalidPatchPlan(error),
      rawOutput: firstPass.rawOutput,
      modelError: formatError(error)
    };
  }

  if (verifier.decision === "approve") return firstPass;

  if (verifier.decision === "refuse" || agentFlow === "workspace_verifier") {
    return {
      patch: {
        kind: "refusal",
        reason: `verifier_refusal: ${verifier.reason}`
      },
      rawOutput: `${firstPass.rawOutput}\n\nVERIFIER=${JSON.stringify(verifier)}`,
      modelError: firstPass.modelError
    };
  }

  return requestPatchPlanOnce(testCase, verifier);
}

async function requestPatchPlanOnce(
  testCase: CodePatchBenchmarkCase,
  verifierFeedback?: CodePatchVerifierDecision
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
            content: [
              "You are a code patch agent inside a deterministic benchmark.",
              "Return JSON only.",
              "Use only the provided file contents.",
              "Do not touch forbidden files.",
              "For file_edit changes, search must be exact existing text and replace must be different.",
              "If required information is missing, return a refusal."
            ].join(" ")
          },
          {
            role: "user",
            content: await buildCodePatchPrompt({ repoPath, testCase, contextStrategy, agentFlow, verifierFeedback })
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
      modelError: null
    };
  } catch (error) {
    const patch = createInvalidPatchPlan(error);

    return {
      patch,
      rawOutput,
      modelError: formatError(error)
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
            "If product, platform, compliance, owner, or approved numeric decision is missing, do not allow guessing."
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

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/$/, "");
}
