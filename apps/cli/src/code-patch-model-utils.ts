import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CodePatchBenchmarkCase,
  MockPatchPlan
} from "../../../packages/code-benchmark/src/index.js";

export type GeneratedPatchPlan = {
  patch: MockPatchPlan;
  rawOutput: string;
  modelError: string | null;
};

type PromptFile = {
  file: string;
  content: string;
  contextMode: "full_file" | "excerpt";
};

type PatchPlanEnvelope = Partial<MockPatchPlan> & {
  fileEdit?: Partial<Extract<MockPatchPlan, { kind: "file_edit" }>>;
  refusal?: Partial<Extract<MockPatchPlan, { kind: "refusal" }>>;
};

export async function buildCodePatchPrompt(input: {
  repoPath: string;
  testCase: CodePatchBenchmarkCase;
}): Promise<string> {
  const files = await Promise.all(
    input.testCase.relevantFiles.map(async (file) => createPromptFile(input.repoPath, input.testCase, file))
  );

  // Bu prompt iki model ailesi için ortaktır: autoregressive LLM runner ve dLLM
  // infill runner aynı task/scope/file paketini görür. Böylece sonuç farkı prompt
  // farkından değil, mümkün olduğunca model ve orchestration farkından gelir.
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
      task: input.testCase.task,
      title: input.testCase.title,
      realityLevel: input.testCase.realityLevel,
      allowedFiles: input.testCase.allowedFiles,
      forbiddenFiles: input.testCase.forbiddenFiles,
      forbiddenChangePatterns: input.testCase.forbiddenChangePatterns,
      files
    },
    null,
    2
  );
}

export function parseGeneratedPatchPlan(content: string, testCase: CodePatchBenchmarkCase): MockPatchPlan {
  const parsed = normalizePatchPlanEnvelope(JSON.parse(extractJson(content)) as PatchPlanEnvelope);

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

export function createInvalidPatchPlan(error: unknown): MockPatchPlan {
  // Model JSON sözleşmesini bozarsa benchmark çökmez; bu case ölçülebilir bir
  // patch başarısızlığına dönüşür. Böylece altyapı yerine model davranışını raporda
  // görürüz.
  return {
    kind: "refusal",
    reason: `invalid_model_patch_plan: ${formatError(error)}`
  };
}

export function createPatchTrace(input: {
  patch: MockPatchPlan;
  rawOutput: string;
  modelError: string | null;
}) {
  return {
    patchKind: input.patch.kind,
    patchPlanPreview: compactText(JSON.stringify(input.patch)),
    rawOutputPreview: input.rawOutput ? compactText(input.rawOutput) : "(empty)",
    modelError: input.modelError
  };
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function compactText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

async function createPromptFile(
  repoPath: string,
  testCase: CodePatchBenchmarkCase,
  file: string
): Promise<PromptFile> {
  const content = await readFile(join(repoPath, file), "utf8");
  const shouldExcerpt = content.length > 4_000 || file.toLowerCase().includes("readme");

  if (!shouldExcerpt) {
    return {
      file,
      content,
      contextMode: "full_file"
    };
  }

  return {
    file,
    content: createRelevantExcerpt(testCase, file, content),
    contextMode: "excerpt"
  };
}

function createRelevantExcerpt(testCase: CodePatchBenchmarkCase, file: string, content: string): string {
  const existingSearch = testCase.patch.kind === "file_edit"
    ? testCase.patch.changes.find((change) => change.file === file)?.search
    : undefined;
  const anchor = existingSearch ?? findQuotedTaskAnchor(testCase.task) ?? testCase.title;
  const index = content.indexOf(anchor);

  // Burada oracle sızıntısı yok: excerpt sadece görevle ilişkili mevcut dosya
  // parçasını daraltır. expectedChangedFiles veya scorer cevabı modele verilmez.
  if (index < 0) return content.slice(0, 3_000);

  const start = Math.max(0, index - 1_200);
  const end = Math.min(content.length, index + anchor.length + 1_200);
  return content.slice(start, end);
}

function findQuotedTaskAnchor(task: string): string | undefined {
  const match = task.match(/"([^"]{8,})"/);
  return match?.[1];
}

function normalizePatchPlanEnvelope(parsed: PatchPlanEnvelope): Partial<MockPatchPlan> {
  // Modeller sık sık şemadaki örnek anahtarları root wrapper olarak döndürüyor:
  // { "fileEdit": { "kind": "file_edit", ... } }. Bu gerçek patch niyetidir,
  // parser katılığı yüzünden başarısız sayılmamalıdır.
  if (parsed.fileEdit) return parsed.fileEdit;
  if (parsed.refusal) return parsed.refusal;
  return parsed;
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
