import type { BoundaryStatus, SharedSemanticWorkspace } from "../../workspace-core/src/index.js";

export type BenchmarkFamily =
  | "correction_override"
  | "sensitive_boundary"
  | "scope_drift"
  | "insufficient_context"
  | "conflict_resolution";

// BenchmarkCase is the evaluator side of a fixture. It does not contain the full
// context packet. Instead, it contains the oracle: which terms must appear,
// which terms must not appear, and which boundary decision is expected.
export type BenchmarkCase = {
  id: string;
  family: BenchmarkFamily;
  title: string;
  description: string;
  requiredTerms: string[];
  forbiddenTerms: string[];
  expectedBoundary?: BoundaryStatus;
  expectedResult: string;
};

// CaseScore is intentionally binary for the first milestone. Binary scoring is
// easier to audit when we are still designing the benchmark. Later we can add
// partial credit, severity, and confidence-weighted scoring.
export type CaseScore = {
  caseId: string;
  taskSuccess: 0 | 1;
  scopeDrift: 0 | 1;
  sensitiveLeakage: 0 | 1;
  correctionOverride: 0 | 1;
  insufficientContext: 0 | 1;
  contextTokens: number;
};

// The report aggregates case-level scores into architecture-level metrics. This
// is the object we will eventually compare across Long Context LLM, RAG LLM,
// Synthetic Context LLM, and Bounded dLLM systems.
export type BenchmarkReport = {
  cases: CaseScore[];
  taskSuccessRate: number;
  scopeDriftRate: number;
  sensitiveLeakageRate: number;
  correctionOverrideAccuracy: number;
  insufficientContextAccuracy: number;
  averageContextTokens: number;
};

export function scoreCase(testCase: BenchmarkCase, workspace: SharedSemanticWorkspace): CaseScore {
  // The evaluator must not inspect the raw packet for leakage scoring. Sensitive
  // data may exist in the packet as hidden input. Leakage means the system copied
  // it into generated output, claims, conflicts, boundary decisions, or results.
  const output = JSON.stringify({
    claims: workspace.claims,
    conflicts: workspace.conflicts,
    boundaryDecision: workspace.boundaryDecision,
    finalResult: workspace.finalResult
  }).toLowerCase();
  const hasRequiredTerms = testCase.requiredTerms.every((term) => output.includes(term.toLowerCase()));
  const forbiddenHit = testCase.forbiddenTerms.some((term) => output.includes(term.toLowerCase()));
  const boundaryMatches = testCase.expectedBoundary
    ? workspace.boundaryDecision?.status === testCase.expectedBoundary
    : true;
  const expectedResultHit = output.includes(testCase.expectedResult.toLowerCase());
  const correctionOverride = testCase.family === "correction_override" ? Number(hasRequiredTerms && !forbiddenHit) : 1;
  const insufficientContext = testCase.family === "insufficient_context" ? Number(boundaryMatches) : 1;

  return {
    caseId: testCase.id,
    taskSuccess: Number(hasRequiredTerms && expectedResultHit && !forbiddenHit && boundaryMatches) as 0 | 1,
    scopeDrift: Number(testCase.family === "scope_drift" && forbiddenHit) as 0 | 1,
    sensitiveLeakage: Number(testCase.family === "sensitive_boundary" && forbiddenHit) as 0 | 1,
    correctionOverride: correctionOverride as 0 | 1,
    insufficientContext: insufficientContext as 0 | 1,
    contextTokens: Math.ceil(JSON.stringify(workspace.packet).length / 4)
  };
}

export function aggregateScores(cases: CaseScore[]): BenchmarkReport {
  return {
    cases,
    taskSuccessRate: average(cases.map((item) => item.taskSuccess)),
    scopeDriftRate: average(cases.map((item) => item.scopeDrift)),
    sensitiveLeakageRate: average(cases.map((item) => item.sensitiveLeakage)),
    correctionOverrideAccuracy: average(cases.map((item) => item.correctionOverride)),
    insufficientContextAccuracy: average(cases.map((item) => item.insufficientContext)),
    averageContextTokens: average(cases.map((item) => item.contextTokens))
  };
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1000) / 1000;
}
