import type { BenchmarkFixture } from "../../fixtures/src/index.js";
import { createMaskedWorkspaceView } from "../../masking-policy/src/index.js";
import { createRefineRequest, type DllmWorkerRefineRequest } from "../../worker-contract/src/index.js";
import { createWorkspace } from "../../workspace-core/src/index.js";

export type OracleLeakageSeverity = "error" | "warn";

export type OracleLeakageFinding = {
  caseId: string;
  severity: OracleLeakageSeverity;
  path: string;
  reason: string;
  preview: string;
};

export type OracleLeakageAuditResult = {
  ok: boolean;
  fixtureCount: number;
  findingCount: number;
  findings: OracleLeakageFinding[];
};

const forbiddenOracleKeys = new Set([
  "answer",
  "answerKey",
  "expected",
  "expectedOutput",
  "expectedResult",
  "expectedEvidenceIds",
  "expectedBoundary",
  "requiredTerms",
  "forbiddenTerms",
  "taskSuccess",
  "requiredTermCoverage",
  "forbiddenTermHitCount",
  "scopeDrift",
  "sensitiveLeakage",
  "correctionOverride",
  "insufficientContext",
  "boundaryAccuracy",
  "evidenceCoverage",
  "traceCompleteness"
]);

export function auditFixturesForOracleLeakage(fixtures: BenchmarkFixture[]): OracleLeakageAuditResult {
  const findings = fixtures.flatMap((fixture) => auditFixtureWorkerRequest(fixture));

  return {
    ok: findings.every((finding) => finding.severity !== "error"),
    fixtureCount: fixtures.length,
    findingCount: findings.length,
    findings
  };
}

export function auditFixtureWorkerRequest(fixture: BenchmarkFixture): OracleLeakageFinding[] {
  const workspace = createWorkspace(`oracle-audit-${fixture.case.id}`, fixture.packet);
  const masked = createMaskedWorkspaceView(workspace, "boundary");
  const request = createRefineRequest({
    requestId: `oracle-audit-${fixture.case.id}`,
    view: "boundary",
    workspace: masked.workspace
  });

  return auditRefineRequestForOracleLeakage(fixture, request);
}

export function auditRefineRequestForOracleLeakage(
  fixture: BenchmarkFixture,
  request: DllmWorkerRefineRequest
): OracleLeakageFinding[] {
  const findings: OracleLeakageFinding[] = [];

  // Oracle audit iki şeyi ayırır:
  // 1. Modelin görmesi gereken kanıt/fact içeriği.
  // 2. Sadece evaluator'ın bilmesi gereken cevap anahtarı ve skor alanları.
  // İkinci grup worker request'ine girerse benchmark "model bildi" değil,
  // "cevap anahtarı sızdı" sonucuna dönüşür.
  walkJson(request, [], (path, value) => {
    const key = path[path.length - 1] ?? "";
    const dottedPath = path.join(".");

    if (forbiddenOracleKeys.has(key)) {
      findings.push({
        caseId: fixture.case.id,
        severity: "error",
        path: dottedPath,
        reason: "Evaluator-only oracle key was present in the worker request.",
        preview: preview(value)
      });
    }

    if (typeof value !== "string") return;

    const evaluatorOnlyTerms = [
      fixture.case.expectedResult,
      ...fixture.case.requiredTerms,
      ...fixture.case.forbiddenTerms,
      ...(fixture.case.expectedBoundary ? [fixture.case.expectedBoundary] : [])
    ].filter(Boolean);

    for (const term of evaluatorOnlyTerms) {
      if (!term || !value.includes(term)) continue;
      if (isAllowedEvidencePath(path)) continue;

      findings.push({
        caseId: fixture.case.id,
        severity: "error",
        path: dottedPath,
        reason: "Evaluator-only answer text appeared outside allowed evidence-bearing packet fields.",
        preview: preview(value)
      });
    }
  });

  return findings;
}

function isAllowedEvidencePath(path: string[]): boolean {
  const dottedPath = path.join(".");

  // Fact, task, goal, scope ve mustNotInfer benchmark input'unun kendisidir; modelin
  // bunları görmesi gerekir. Aynı cümlenin fact içinde bulunması leakage değildir.
  // Leakage, aynı bilginin expectedResult/requiredTerms gibi grading alanlarından
  // veya üretilmiş workspace alanlarından worker'a sızmasıdır.
  return (
    dottedPath.startsWith("workspace.packet.task") ||
    dottedPath.startsWith("workspace.packet.goal") ||
    dottedPath.startsWith("workspace.packet.facts.") ||
    dottedPath.startsWith("workspace.packet.allowedScope.") ||
    dottedPath.startsWith("workspace.packet.forbiddenScope.") ||
    dottedPath.startsWith("workspace.packet.mustNotInfer.") ||
    dottedPath.startsWith("workspace.packet.responseContract")
  );
}

function walkJson(value: unknown, path: string[], visit: (path: string[], value: unknown) => void): void {
  visit(path, value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => walkJson(item, [...path, String(index)], visit));
    return;
  }

  if (typeof value !== "object" || value === null) return;

  for (const [key, child] of Object.entries(value)) {
    walkJson(child, [...path, key], visit);
  }
}

function preview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}
