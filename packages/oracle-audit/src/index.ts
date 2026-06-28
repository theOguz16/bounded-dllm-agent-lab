import { createWorkspaceFromPacket } from "../../context-core/src/workspace-adapter.js";
import type { BenchmarkFixture } from "../../fixtures/src/index.js";
import { createMaskedWorkspaceView } from "../../masking-policy/src/index.js";
import type {
  DllmWorkerRefineRequest
} from "../../worker-contract/src/index.js";

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

export function auditFixturesForOracleLeakage(
  fixtures: BenchmarkFixture[]
): OracleLeakageAuditResult {
  const findings = fixtures.flatMap((fixture) => auditFixtureWorkerRequest(fixture));

  return {
    ok: findings.every((finding) => finding.severity !== "error"),
    fixtureCount: fixtures.length,
    findingCount: findings.length,
    findings
  };
}

export function auditFixtureWorkerRequest(
  fixture: BenchmarkFixture
): OracleLeakageFinding[] {
  /**
   * Oracle audit de worker'a giden gerçek request'i denetler.
   * Eski workspace.packet yapısı kaldırıldığı için fixture packet önce canonical
   * workspace'e çevrilir.
   */
  const workspace = createWorkspaceFromPacket(fixture.packet, {
    id: `oracle-audit-${fixture.case.id}`
  });

  const masked = createMaskedWorkspaceView(workspace, "verifier");

  const request: DllmWorkerRefineRequest = {
    requestId: `oracle-audit-${fixture.case.id}`,
    workspace: masked.workspace
  };

  return auditRefineRequestForOracleLeakage(fixture, request);
}

export function auditRefineRequestForOracleLeakage(
  fixture: BenchmarkFixture,
  request: DllmWorkerRefineRequest
): OracleLeakageFinding[] {
  const findings: OracleLeakageFinding[] = [];

  /**
   * Oracle audit iki şeyi ayırır:
   * 1. Modelin görmesi gereken task/scope/fact/authority içeriği.
   * 2. Sadece evaluator'ın bilmesi gereken cevap anahtarı ve skor alanları.
   *
   * İkinci grup worker request'ine girerse benchmark "model bildi" değil,
   * "cevap anahtarı sızdı" sonucuna dönüşür.
   */
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

    if (typeof value !== "string") {
      return;
    }

    const evaluatorOnlyTerms = [
      fixture.case.expectedResult,
      ...fixture.case.requiredTerms,
      ...fixture.case.forbiddenTerms,
      ...(fixture.case.expectedBoundary ? [fixture.case.expectedBoundary] : [])
    ].filter(Boolean);

    for (const term of evaluatorOnlyTerms) {
      if (!term || !value.includes(term)) {
        continue;
      }

      if (isAllowedEvidencePath(path)) {
        continue;
      }

      findings.push({
        caseId: fixture.case.id,
        severity: "error",
        path: dottedPath,
        reason: "Evaluator-only answer text appeared outside allowed evidence-bearing workspace fields.",
        preview: preview(value)
      });
    }
  });

  return findings;
}

function isAllowedEvidencePath(path: string[]): boolean {
  const dottedPath = path.join(".");

  /**
   * Yeni canonical workspace'te artık workspace.packet yok.
   * Modelin görmesi gereken input alanları workspace.task, workspace.scope,
   * workspace.authority, workspace.policy ve workspace.repoFacts altında durur.
   *
   * Bu alanlarda evaluator term'lerinin görünmesi tek başına leakage değildir;
   * çünkü bunlar fixture input'unun worker'a gitmesi gereken kısmıdır.
   */
  return (
    dottedPath === "workspace.task" ||
    dottedPath.startsWith("workspace.task.") ||
    dottedPath === "workspace.scope" ||
    dottedPath.startsWith("workspace.scope.") ||
    dottedPath === "workspace.authority" ||
    dottedPath.startsWith("workspace.authority.") ||
    dottedPath === "workspace.policy" ||
    dottedPath.startsWith("workspace.policy.") ||
    dottedPath === "workspace.repoFacts" ||
    dottedPath.startsWith("workspace.repoFacts.") ||
    dottedPath === "workspace.patchIntent" ||
    dottedPath.startsWith("workspace.patchIntent.")
  );
}

function walkJson(
  value: unknown,
  path: string[],
  visit: (path: string[], value: unknown) => void
): void {
  visit(path, value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => walkJson(item, [...path, String(index)], visit));
    return;
  }

  if (typeof value !== "object" || value === null) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    walkJson(child, [...path, key], visit);
  }
}

function preview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);

  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}