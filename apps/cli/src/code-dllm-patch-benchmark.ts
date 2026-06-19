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
  isHealthResponse,
  isInfillResponse,
  type DllmWorkerHealthResponse
} from "../../../packages/worker-contract/src/index.js";
import {
  buildCodePatchPrompt,
  createInvalidPatchPlan,
  createPatchTrace,
  formatError,
  parseGeneratedPatchPlan
} from "./code-patch-model-utils.js";

type GeneratedPatchPlan = {
  patch: CodePatchBenchmarkCase["patch"];
  rawOutput: string;
  modelError: string | null;
};

const repoPath = process.env.CODE_BENCH_REPO_PATH ?? "benchmarks/repos/nanoid";
const workRoot = process.env.CODE_BENCH_WORK_ROOT ?? "reports/code-dllm-patch-workspaces";
const reportDir = process.env.CODE_BENCH_REPORT_DIR ?? "reports";
const workerUrl = normalizeBaseUrl(process.env.DLLM_WORKER_URL ?? "http://127.0.0.1:8765");
const caseLimit = Number(process.env.CODE_MODEL_CASE_LIMIT ?? "50");
const modelCases = nanoidCodePatchCases.filter((testCase) => testCase.expectedOutcome === "pass").slice(0, caseLimit);
const failures = validateCodePatchCases(modelCases);

if (failures.length) {
  throw new Error(JSON.stringify({ ok: false, failures }, null, 2));
}

const workerHealth = await readWorkerHealth(workerUrl);
if (workerHealth.mode !== "dllm") {
  throw new Error(`Expected a dLLM worker at ${workerUrl}, received mode=${workerHealth.mode}`);
}

const generatedCases: CodePatchBenchmarkCase[] = [];

for (const testCase of modelCases) {
  console.log(`[code-dllm-patch] ${generatedCases.length + 1}/${modelCases.length} ${testCase.id}`);
  const generated = await requestPatchPlan(testCase);
  generatedCases.push({
    ...testCase,
    patch: generated.patch,
    modelTrace: createPatchTrace(generated)
  });
}

const modelName = workerHealth.modelName ?? workerHealth.workerName;
const report = await runCodePatchBenchmark({
  repoPath,
  workRoot,
  cases: generatedCases,
  suiteName: "oss-code-dllm-patch-benchmark-v1",
  engineName: `dllm-infill-code-patch:${modelName}`
});
const runId = `${report.createdAt.replace(/[:.]/g, "-")}-code-dllm-patch-benchmark`;
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
      workerUrl,
      modelName,
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
  let rawOutput = "";

  try {
    const prompt = await buildDllmPatchPrompt(testCase);
    const response = await fetch(`${workerUrl}/infill`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        requestId: `code-dllm-patch-${testCase.id}`,
        region: "final_result",
        prompt
      })
    });
    const body: unknown = await response.json();

    if (!response.ok || !isInfillResponse(body)) {
      throw new Error(`Invalid dLLM infill response from ${workerUrl}/infill`);
    }

    rawOutput = body.content;
    const patch = parseGeneratedPatchPlan(rawOutput, testCase);

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

async function buildDllmPatchPrompt(testCase: CodePatchBenchmarkCase): Promise<string> {
  const sharedPrompt = await buildCodePatchPrompt({ repoPath, testCase });
  // Burada prompt'u sonradan karakterden kırpmıyoruz. Dosya daraltma işi ortak
  // bounded excerpt katmanında yapılıyor. Sessiz string kırpma JSON'u ortadan
  // bölebilir ve model kalitesi yerine paketleme hatasını ölçmemize neden olur.
  return [
    "You are a bounded dLLM code patch infill worker.",
    "Return JSON only.",
    "Do not explain.",
    "Use only the supplied task, scope, and file context.",
    "If the task lacks enough authority or context, return a refusal JSON object.",
    sharedPrompt
  ].join("\n\n");
}

async function readWorkerHealth(baseUrl: string): Promise<DllmWorkerHealthResponse> {
  const response = await fetch(`${baseUrl}/health`);
  const body: unknown = await response.json();

  if (!response.ok || !isHealthResponse(body)) {
    throw new Error(`Invalid dLLM worker health response from ${baseUrl}/health`);
  }

  return body;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/$/, "");
}
