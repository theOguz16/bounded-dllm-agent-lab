import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  codePatchReportToMarkdown,
  nanoidCodePatchCases,
  runCodePatchBenchmark,
  validateCodePatchCases,
  type CodePatchBenchmarkCase,
  type CodePatchModelTrace,
  type MockPatchPlan
} from "../../../packages/code-benchmark/src/index.js";

type ChatCompletionPayload = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

type GeneratedPatchPlan = {
  patch: MockPatchPlan;
  trace: CodePatchModelTrace;
};

const repoPath = process.env.CODE_BENCH_REPO_PATH ?? "benchmarks/repos/nanoid";
const workRoot = process.env.CODE_BENCH_WORK_ROOT ?? "reports/code-model-patch-workspaces";
const reportDir = process.env.CODE_BENCH_REPORT_DIR ?? "reports";
const baseUrl = normalizeBaseUrl(process.env.LLM_API_BASE_URL ?? "http://127.0.0.1:8000/v1");
const apiKey = process.env.LLM_API_KEY;
const model = process.env.LLM_MODEL ?? "openai-compatible-model";
const temperature = Number(process.env.LLM_TEMPERATURE ?? "0");
const maxTokens = Number(process.env.LLM_MAX_TOKENS ?? "900");
const caseLimit = Number(process.env.CODE_MODEL_CASE_LIMIT ?? "4");
const modelCases = nanoidCodePatchCases.filter((testCase) => testCase.expectedOutcome === "pass").slice(0, caseLimit);
const failures = validateCodePatchCases(modelCases);

if (failures.length) {
  throw new Error(JSON.stringify({ ok: false, failures }, null, 2));
}

const generatedCases: CodePatchBenchmarkCase[] = [];

for (const testCase of modelCases) {
  console.log(`[code-model-patch] ${generatedCases.length + 1}/${modelCases.length} ${testCase.id}`);
  const generated = await requestPatchPlan(testCase);
  generatedCases.push({
    ...testCase,
    patch: generated.patch,
    modelTrace: generated.trace
  });
}

const report = await runCodePatchBenchmark({
  repoPath,
  workRoot,
  cases: generatedCases,
  suiteName: "oss-code-model-patch-benchmark-v1",
  engineName: `openai-compatible-code-patch:${model}`
});
const runId = `${report.createdAt.replace(/[:.]/g, "-")}-code-model-patch-benchmark`;
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
              "If required information is missing, return a refusal."
            ].join(" ")
          },
          {
            role: "user",
            content: await buildPatchPrompt(testCase)
          }
        ]
      })
    });
    const payload = await response.json() as ChatCompletionPayload;
    const content = payload.choices?.[0]?.message?.content;

    if (!response.ok || !content) {
      throw new Error(`patch completion failed with status ${response.status}`);
    }

    rawOutput = content;
    const patch = parsePatchPlan(content, testCase);

    return {
      patch,
      trace: {
        patchKind: patch.kind,
        patchPlanPreview: compactText(JSON.stringify(patch)),
        rawOutputPreview: compactText(content),
        modelError: null
      }
    };
  } catch (error) {
    // Model JSON sözleşmesini bozarsa benchmark çökmez; bu case ölçülebilir
    // bir patch başarısızlığına dönüşür. Böylece altyapı yerine model davranışını
    // raporda görürüz.
    const patch: MockPatchPlan = {
      kind: "refusal",
      reason: `invalid_model_patch_plan: ${formatError(error)}`
    };

    return {
      patch,
      trace: {
        patchKind: patch.kind,
        patchPlanPreview: compactText(JSON.stringify(patch)),
        rawOutputPreview: rawOutput ? compactText(rawOutput) : "(empty)",
        modelError: formatError(error)
      }
    };
  }
}

async function buildPatchPrompt(testCase: CodePatchBenchmarkCase): Promise<string> {
  const files = await Promise.all(
    testCase.relevantFiles.map(async (file) => ({
      file,
      content: await readFile(join(repoPath, file), "utf8")
    }))
  );

  // Prompt'ta evaluator oracle yoktur: expectedChangedFiles ve successCriteria
  // modelden gizlenir. Model sadece görev, scope ve dosya içeriklerini görür.
  return JSON.stringify(
    {
      instruction: "Produce the smallest safe patch plan for the task.",
      outputSchema: {
        fileEdit: {
          kind: "file_edit",
          changes: [
            {
              file: "relative file path",
              search: "exact existing text block",
              replace: "replacement text block"
            }
          ]
        },
        refusal: {
          kind: "refusal",
          reason: "short reason"
        }
      },
      task: testCase.task,
      title: testCase.title,
      allowedFiles: testCase.allowedFiles,
      forbiddenFiles: testCase.forbiddenFiles,
      forbiddenChangePatterns: testCase.forbiddenChangePatterns,
      files
    },
    null,
    2
  );
}

function parsePatchPlan(content: string, testCase: CodePatchBenchmarkCase): MockPatchPlan {
  const parsed = JSON.parse(extractJson(content)) as Partial<MockPatchPlan>;

  if (parsed.kind === "refusal") {
    return {
      kind: "refusal",
      reason: String(parsed.reason ?? "model_refusal")
    };
  }

  if (parsed.kind === "file_edit" && Array.isArray(parsed.changes)) {
    return {
      kind: "file_edit",
      changes: parsed.changes.map((change) => ({
        file: String(change.file ?? ""),
        search: String(change.search ?? ""),
        replace: String(change.replace ?? "")
      }))
    };
  }

  throw new Error(`Model did not return a valid patch plan for ${testCase.id}`);
}

function extractJson(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) return trimmed.slice(firstBrace, lastBrace + 1);

  return trimmed;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/$/, "");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compactText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}
