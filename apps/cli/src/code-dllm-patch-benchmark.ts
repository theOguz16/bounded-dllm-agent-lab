import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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

class TransportError extends Error {}

const repoPath = process.env.CODE_BENCH_REPO_PATH ?? "benchmarks/repos/nanoid";
const workRoot = process.env.CODE_BENCH_WORK_ROOT ?? "reports/code-dllm-patch-workspaces";
const reportDir = process.env.CODE_BENCH_REPORT_DIR ?? "reports";
const workerUrl = normalizeBaseUrl(process.env.DLLM_WORKER_URL ?? "http://127.0.0.1:8765");
const caseLimit = Number(process.env.CODE_MODEL_CASE_LIMIT ?? "50");
const modelCases = nanoidCodePatchCases.filter((testCase) => testCase.expectedOutcome === "pass").slice(0, caseLimit);
const failures = validateCodePatchCases(modelCases);
const createdAt = new Date().toISOString();
const runId = await resolveRunId(createdAt);
const checkpointPath = join(reportDir, `${runId}.checkpoint.json`);
const jsonPath = join(reportDir, `${runId}.json`);
const markdownPath = join(reportDir, `${runId}.md`);

if (failures.length) {
  throw new Error(JSON.stringify({ ok: false, failures }, null, 2));
}

const workerHealth = await readWorkerHealth(workerUrl);
if (workerHealth.mode !== "dllm") {
  throw new Error(`Expected a dLLM worker at ${workerUrl}, received mode=${workerHealth.mode}`);
}

const checkpoint = await loadCheckpoint();
const generatedCases: CodePatchBenchmarkCase[] = checkpoint?.generatedCases ?? [];
const completedCaseIds = new Set(checkpoint?.completedCaseIds ?? []);

for (const [index, testCase] of modelCases.entries()) {
  const progress = `${index + 1}/${modelCases.length}`;
  if (completedCaseIds.has(testCase.id)) {
    console.log(`[code-dllm-patch] ${progress} ${testCase.id} skipped from checkpoint`);
    continue;
  }

  console.log(`[code-dllm-patch] ${progress} ${testCase.id}`);
  const generated = await requestPatchPlan(testCase);
  generatedCases.push({
    ...testCase,
    patch: generated.patch,
    modelTrace: createPatchTrace(generated)
  });
  completedCaseIds.add(testCase.id);
  await writeCheckpoint({
    runId,
    workerUrl,
    modelName: workerHealth.modelName ?? workerHealth.workerName,
    createdAt: checkpoint?.createdAt ?? createdAt,
    completedCaseIds: Array.from(completedCaseIds),
    generatedCases
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
      checkpointPath,
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
    rawOutput = await requestInfillWithRetry(testCase);
    const patch = parseGeneratedPatchPlan(rawOutput, testCase);

    return {
      patch,
      rawOutput,
      modelError: null
    };
  } catch (error) {
    if (isTransportError(error)) throw error;

    const patch = createInvalidPatchPlan(error);

    return {
      patch,
      rawOutput,
      modelError: formatError(error)
    };
  }
}

async function requestInfillWithRetry(testCase: CodePatchBenchmarkCase): Promise<string> {
  const maxAttempts = Number(process.env.BENCHMARK_RETRY_ATTEMPTS ?? "3");
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
        throw new TransportError(`Invalid dLLM infill response from ${workerUrl}/infill`);
      }

      return body.content;
    } catch (error) {
      lastError = error instanceof TransportError ? error : new TransportError(formatError(error));
      console.error(`[code-dllm-patch] ${testCase.id} attempt ${attempt}/${maxAttempts} failed: ${formatError(error)}`);
      if (attempt < maxAttempts) await sleep(1500 * attempt);
    }
  }

  throw lastError;
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

type DllmCodePatchCheckpoint = {
  runId: string;
  workerUrl: string;
  modelName: string;
  createdAt: string;
  completedCaseIds: string[];
  generatedCases: CodePatchBenchmarkCase[];
};

async function writeCheckpoint(checkpoint: DllmCodePatchCheckpoint): Promise<void> {
  await mkdir(reportDir, { recursive: true });
  // Dream-Coder code patch runs uzun sürebilir ve web terminal/worker kopabilir.
  // Her model çıktısını hemen yazıyoruz ki yeniden başlatınca aynı case'leri tekrar
  // üretmek zorunda kalmayalım.
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

async function loadCheckpoint(): Promise<DllmCodePatchCheckpoint | undefined> {
  if (process.env.BENCHMARK_RESUME !== "1") return undefined;

  try {
    const raw = await readFile(checkpointPath, "utf8");
    const checkpoint = JSON.parse(raw) as DllmCodePatchCheckpoint;
    console.error(`[code-dllm-patch] resuming ${checkpoint.completedCaseIds.length}/${modelCases.length} from ${checkpointPath}`);
    return checkpoint;
  } catch {
    console.error(`[code-dllm-patch] no checkpoint found at ${checkpointPath}; starting fresh`);
    return undefined;
  }
}

async function resolveRunId(createdAt: string): Promise<string> {
  if (process.env.BENCHMARK_RUN_ID) return process.env.BENCHMARK_RUN_ID;

  if (process.env.BENCHMARK_RESUME === "1") {
    const latest = await latestCheckpointRunId();
    if (latest) return latest;
  }

  return `${createdAt.replace(/[:.]/g, "-")}-code-dllm-patch-benchmark`;
}

async function latestCheckpointRunId(): Promise<string | undefined> {
  try {
    const files = await readdir(reportDir);
    const checkpoints = files
      .filter((file) => file.endsWith("-code-dllm-patch-benchmark.checkpoint.json"))
      .sort()
      .reverse();
    return checkpoints[0]?.replace(/\.checkpoint\.json$/, "");
  } catch {
    return undefined;
  }
}

function isTransportError(error: unknown): boolean {
  return error instanceof TransportError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/$/, "");
}
