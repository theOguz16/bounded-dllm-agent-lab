import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { arch, cpus, platform, totalmem } from "node:os";
import { join } from "node:path";
import {
  aggregateScores,
  benchmarkArtifactToMarkdown,
  createBenchmarkArtifact,
  scoreCase,
  type CaseOutputSnapshot,
  type CaseScore
} from "../../../packages/eval-core/src/index.js";
import { createExperimentConfig, createRunManifest, validateRunManifest } from "../../../packages/experiment-core/src/index.js";
import { hardFixtures, validateFixtures } from "../../../packages/fixtures/src/index.js";
import { createMaskedWorkspaceView } from "../../../packages/masking-policy/src/index.js";
import { HttpLlmWorkerEngine } from "../../../packages/providers/src/index.js";
import { isHealthResponse } from "../../../packages/worker-contract/src/index.js";
import { createWorkspace } from "../../../packages/workspace-core/src/index.js";
import type { BoundedContextPacket, ContextFact } from "../../../packages/context-core/src/index.js";

type LlmContextStrategy = "plain" | "rag" | "expanded";

const workerUrl = process.env.LLM_WORKER_URL ?? "http://127.0.0.1:8775";
const engine = new HttpLlmWorkerEngine(workerUrl, "boundary");
const reportDir = "reports";
const contextStrategy = parseContextStrategy(process.env.LLM_CONTEXT_STRATEGY ?? "plain");
const suiteName = createSuiteName(contextStrategy);
const fixtureSubset = hardFixtures;
const createdAt = new Date().toISOString();
const runId = await resolveRunId(createdAt);
const checkpointPath = join(reportDir, `${runId}.checkpoint.json`);
const jsonPath = join(reportDir, `${runId}.json`);
const markdownPath = join(reportDir, `${runId}.md`);
const manifestPath = join(reportDir, `${runId}.manifest.json`);
const fixtureFailures = validateFixtures(fixtureSubset, { expectedFamilyCount: 5 });

if (fixtureFailures.length) {
  throw new Error(JSON.stringify({ ok: false, fixtureFailures }, null, 2));
}

const healthy = await engine.health();
if (!healthy) {
  throw new Error(`LLM worker health check failed for ${workerUrl}`);
}
const workerHealth = await readWorkerHealth(workerUrl);
// Model adı çoğu zaman benchmark terminalinde değil, worker terminalinde env olarak
// tanımlanır. Health metadata'sını okumak manifest'in "hangi model ölçüldü?"
// sorusuna sonradan tahminle değil, çalışan worker'ın kendi beyanıyla cevap verir.
const modelName = process.env.LLM_MODEL ?? workerHealth.modelName ?? "openai-compatible-model";

const checkpoint = await loadCheckpoint();
const runCreatedAt = checkpoint?.createdAt ?? createdAt;
const scores: CaseScore[] = checkpoint?.scores ?? [];
const outputSnapshots: CaseOutputSnapshot[] = checkpoint?.outputSnapshots ?? [];
const completedCaseIds = new Set(checkpoint?.completedCaseIds ?? []);

for (const [index, fixture] of fixtureSubset.entries()) {
  const progress = `${index + 1}/${fixtureSubset.length}`;
  if (completedCaseIds.has(fixture.case.id)) {
    console.error(`[worker-llm-hard-benchmark] ${progress} ${fixture.case.id} skipped from checkpoint`);
    continue;
  }

  console.error(`[worker-llm-hard-benchmark:${contextStrategy}] ${progress} ${fixture.case.id}`);

  const packet = createStrategyPacket(fixture.packet, fixture.case.id);
  const workspace = createWorkspace(`llm-${contextStrategy}-hard-baseline-${fixture.case.id}`, packet);
  const masked = createMaskedWorkspaceView(workspace, "boundary");
  const result = await refineWithRetry(masked.workspace, fixture.case.id);

  // Bu runner'ın amacı dLLM worker'ı tekrar ölçmek değil; aynı hard fixture'ları
  // autoregressive LLM worker'a verip model ailesi karşılaştırmasının ilk gerçek
  // kolonunu üretmektir. Input aynı kalır, oracle yine modele gitmez.
  scores.push(scoreCase(fixture.case, result.workspace));
  completedCaseIds.add(fixture.case.id);
  outputSnapshots.push({
    caseId: fixture.case.id,
    family: fixture.case.family,
    task: packet.task,
    expectedResult: fixture.case.expectedResult,
    requiredTerms: fixture.case.requiredTerms,
    forbiddenTerms: fixture.case.forbiddenTerms,
    finalResult: result.workspace.finalResult ?? ""
  });
  await writeCheckpoint({
    runId,
    suiteName,
    workerUrl,
    createdAt: runCreatedAt,
    completedCaseIds: Array.from(completedCaseIds),
    scores,
    outputSnapshots
  });
}

const report = aggregateScores(scores);
const artifact = createBenchmarkArtifact({
  suiteName,
  engineName: createEngineName(contextStrategy),
  createdAt: runCreatedAt,
  report,
  outputSnapshots
});
const config = createExperimentConfig({
  runId,
  suiteName,
  architectureName: createArchitectureName(contextStrategy),
  engineName: "http-llm-worker",
  modelName,
  modelVersion: `${contextStrategy}-hard-baseline`,
  workerUrl,
  seed: 0,
  maxAttempts: 1,
  ablation: {
    maskPolicyEnabled: true,
    verifierEnabled: false,
    syntheticContextEnabled: false,
    refinementMaxAttempts: 1
  },
  maskPolicyVersion: "role-mask-v1",
  gitCommit: readGitCommit(),
  hardware: {
    platform: platform(),
    arch: arch(),
    cpuCount: cpus().length,
    totalMemoryMb: Math.round(totalmem() / 1024 / 1024)
  },
  createdAt: runCreatedAt
});
const manifest = createRunManifest({
  config,
  report,
  reportPaths: {
    jsonPath,
    markdownPath,
    manifestPath
  }
});
const failures = validateRunManifest(manifest);

if (failures.length) {
  throw new Error(JSON.stringify({ ok: false, failures }, null, 2));
}

await mkdir(reportDir, { recursive: true });
await writeFile(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`);
await writeFile(markdownPath, benchmarkArtifactToMarkdown(artifact));
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(
  JSON.stringify(
    {
      ok: true,
      workerUrl,
      modelName,
      contextStrategy,
      scenarioCount: fixtureSubset.length,
      checkpointPath,
      jsonPath,
      markdownPath,
      manifestPath,
      summary: {
        taskSuccessRate: report.taskSuccessRate,
        scopeDriftRate: report.scopeDriftRate,
        sensitiveLeakageRate: report.sensitiveLeakageRate,
        evidenceCoverage: report.evidenceCoverage,
        traceCompletenessRate: report.traceCompletenessRate
      }
    },
    null,
    2
  )
);

type LlmHardBenchmarkCheckpoint = {
  runId: string;
  suiteName: string;
  workerUrl: string;
  createdAt: string;
  completedCaseIds: string[];
  scores: CaseScore[];
  outputSnapshots: CaseOutputSnapshot[];
};

function createStrategyPacket(packet: BoundedContextPacket, caseId: string): BoundedContextPacket {
  if (contextStrategy === "plain") return packet;
  if (contextStrategy === "expanded") return createExpandedPacket(packet, caseId);
  return createRagPacket(packet, caseId);
}

function createRagPacket(packet: BoundedContextPacket, caseId: string): BoundedContextPacket {
  const query = [
    packet.task,
    packet.goal,
    ...packet.allowedScope.map((scope) => `${scope.label} ${scope.path ?? ""}`),
    ...packet.mustNotInfer
  ].join(" ");
  const retrievedFacts = retrieveAdditionalFacts(query, packet.id);
  const existingEvidenceIds = new Set(packet.facts.map((fact) => fact.evidenceId));
  const newFacts = retrievedFacts.filter((fact) => !existingEvidenceIds.has(fact.evidenceId));

  // RAG baseline bilinçli olarak bounded packet'e ek retrieval bilgisi ekler.
  // Bu mimariyi adil biçimde test etmek için oracle alanlarını değil, sadece başka
  // fixture packet'lerinden gelebilecek fact benzeri context parçalarını ekliyoruz.
  // Böylece "daha fazla bilgi" fayda mı getiriyor, yoksa distractor/gürültü mü
  // üretiyor sorusunu aynı model üzerinde ölçebiliriz.
  return {
    ...packet,
    id: `${packet.id}-rag`,
    task: `${packet.task}\n\nRAG context strategy: retrieved facts may contain helpful context or distractors. Use only task-relevant, current evidence.`,
    facts: [...packet.facts, ...newFacts],
    responseContract: `${packet.responseContract} Cite only evidence ids that directly support the final result.`,
    contextBudgetTokens: packet.contextBudgetTokens + 450
  };
}

function createExpandedPacket(packet: BoundedContextPacket, caseId: string): BoundedContextPacket {
  const expandedFacts = createExpandedContextFacts(packet.id);
  const existingEvidenceIds = new Set(packet.facts.map((fact) => fact.evidenceId));
  const newFacts = expandedFacts.filter((fact) => !existingEvidenceIds.has(fact.evidenceId));

  // Expanded-context baseline RAG'den farklıdır: burada amaç en alakalı birkaç
  // fact'i almak değil, daha geniş ve gürültülü bir çalışma belleği simüle etmektir.
  // Böylece "context büyüdükçe model daha iyi mi olur, yoksa karar odağı mı dağılır?"
  // sorusunu aynı model ve aynı evaluator üzerinde ölçebiliriz.
  return {
    ...packet,
    id: `${packet.id}-expanded`,
    task: `${packet.task}\n\nExpanded context strategy: the packet includes a wider memory slice with relevant facts and distractors. Prefer the task-local current or correction evidence over adjacent context.`,
    facts: [...packet.facts, ...newFacts],
    responseContract: `${packet.responseContract} Do not merge adjacent tasks into the final result.`,
    contextBudgetTokens: packet.contextBudgetTokens + 1200
  };
}

function retrieveAdditionalFacts(query: string, currentPacketId: string): ContextFact[] {
  const queryTerms = normalizedTerms(query);
  const candidates = hardFixtures
    .filter((fixture) => fixture.packet.id !== currentPacketId)
    .flatMap((fixture) =>
      fixture.packet.facts.map((fact) => ({
        fact: {
          ...fact,
          id: `rag-${fixture.packet.id}-${fact.id}`,
          evidenceId: `rag-${fixture.packet.id}-${fact.evidenceId}`
        },
        score: lexicalOverlapScore(queryTerms, fact.content)
      }))
    )
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.fact.evidenceId.localeCompare(right.fact.evidenceId));

  return candidates.slice(0, 4).map((candidate) => candidate.fact);
}

function createExpandedContextFacts(currentPacketId: string): ContextFact[] {
  const byFamily = new Map(hardFixtures.map((fixture) => [fixture.family, fixture.packet.facts]));
  const selectedFacts = [
    ...(byFamily.get("correction_override") ?? []).slice(0, 4),
    ...(byFamily.get("sensitive_boundary") ?? []).slice(0, 5),
    ...(byFamily.get("scope_drift") ?? []).slice(0, 4),
    ...(byFamily.get("insufficient_context") ?? []).slice(0, 3),
    ...(byFamily.get("conflict_resolution") ?? []).slice(0, 4)
  ];

  return selectedFacts.map((fact, index) => ({
    ...fact,
    id: `expanded-${currentPacketId}-${index + 1}-${fact.id}`,
    evidenceId: `expanded-${currentPacketId}-${index + 1}-${fact.evidenceId}`,
    confidence: Math.max(0.4, fact.confidence - 0.08)
  }));
}

async function refineWithRetry(workspace: Parameters<typeof engine.refineWorkspace>[0], caseId: string) {
  const maxAttempts = Number(process.env.BENCHMARK_RETRY_ATTEMPTS ?? "3");
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await engine.refineWorkspace(workspace);
    } catch (error) {
      lastError = error;
      console.error(`[worker-llm-hard-benchmark] ${caseId} attempt ${attempt}/${maxAttempts} failed: ${formatError(error)}`);
      if (attempt < maxAttempts) await sleep(1500 * attempt);
    }
  }

  throw lastError;
}

async function writeCheckpoint(checkpoint: LlmHardBenchmarkCheckpoint): Promise<void> {
  await mkdir(reportDir, { recursive: true });
  // LLM API koşuları GPU koşuları kadar uzun olmasa bile dış servis hatasına açıktır.
  // Checkpoint aynı case'i tekrar ücretlendirmeden kaldığımız yerden sürdürmemizi sağlar.
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

async function loadCheckpoint(): Promise<LlmHardBenchmarkCheckpoint | undefined> {
  if (process.env.BENCHMARK_RESUME !== "1") return undefined;

  try {
    const raw = await readFile(checkpointPath, "utf8");
    const checkpoint = JSON.parse(raw) as LlmHardBenchmarkCheckpoint;
    console.error(`[worker-llm-hard-benchmark] resuming ${checkpoint.completedCaseIds.length}/${fixtureSubset.length} from ${checkpointPath}`);
    return checkpoint;
  } catch {
    console.error(`[worker-llm-hard-benchmark] no checkpoint found at ${checkpointPath}; starting fresh`);
    return undefined;
  }
}

async function resolveRunId(createdAt: string): Promise<string> {
  if (process.env.BENCHMARK_RUN_ID) return process.env.BENCHMARK_RUN_ID;

  if (process.env.BENCHMARK_RESUME === "1") {
    const latest = await latestCheckpointRunId();
    if (latest) return latest;
  }

  return `${createdAt.replace(/[:.]/g, "-")}-${createRunSuffix(contextStrategy)}`;
}

async function latestCheckpointRunId(): Promise<string | undefined> {
  try {
    const files = await readdir(reportDir);
    const suffix = `-${createRunSuffix(contextStrategy)}.checkpoint.json`;
    const checkpoints = files
      .filter((file) => file.endsWith(suffix))
      .sort()
      .reverse();
    return checkpoints[0]?.replace(/\.checkpoint\.json$/, "");
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readGitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function readWorkerHealth(baseUrl: string) {
  const response = await fetch(`${baseUrl}/health`);
  const body: unknown = await response.json();

  if (!response.ok || !isHealthResponse(body) || body.mode !== "llm") {
    throw new Error(`Invalid LLM worker health response from ${baseUrl}/health`);
  }

  return body;
}

function parseContextStrategy(value: string): LlmContextStrategy {
  if (value === "plain" || value === "rag" || value === "expanded") return value;
  throw new Error(`Unknown LLM_CONTEXT_STRATEGY: ${value}`);
}

function createSuiteName(strategy: LlmContextStrategy): string {
  if (strategy === "rag") return "llm-rag-hard-baseline-v1";
  if (strategy === "expanded") return "llm-expanded-hard-baseline-v1";
  return "llm-hard-baseline-v1";
}

function createRunSuffix(strategy: LlmContextStrategy): string {
  if (strategy === "rag") return "llm-rag-hard-baseline";
  if (strategy === "expanded") return "llm-expanded-hard-baseline";
  return "llm-hard-baseline";
}

function createEngineName(strategy: LlmContextStrategy): string {
  if (strategy === "rag") return "external-llm-worker-rag-hard-baseline";
  if (strategy === "expanded") return "external-llm-worker-expanded-hard-baseline";
  return "external-llm-worker-hard-baseline";
}

function createArchitectureName(strategy: LlmContextStrategy): string {
  if (strategy === "rag") return "external-ar-llm-rag-hard-baseline";
  if (strategy === "expanded") return "external-ar-llm-expanded-hard-baseline";
  return "external-ar-llm-hard-baseline";
}

function lexicalOverlapScore(queryTerms: Set<string>, content: string): number {
  const contentTerms = normalizedTerms(content);
  return [...contentTerms].filter((term) => queryTerms.has(term)).length;
}

function normalizedTerms(value: string): Set<string> {
  const stopWords = new Set([
    "and",
    "are",
    "benchmark",
    "context",
    "current",
    "final",
    "for",
    "from",
    "hard",
    "only",
    "result",
    "should",
    "task",
    "the",
    "this",
    "use",
    "with"
  ]);
  const terms = value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 2 && !stopWords.has(term));

  return new Set(terms);
}
