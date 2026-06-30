import {
  runDllmStyleVerifier,
  type DllmVerifierInput
} from "../../../packages/dllm-verifier/src/index.js";

type SmokeCase = {
  id: string;
  input: DllmVerifierInput;
  expectedDecision: "approve" | "remask_required" | "reject";
};

const cases: SmokeCase[] = [
  {
    id: "clean_changed_files_scope",
    expectedDecision: "approve",
    input: {
      taskId: "clean_changed_files_scope",
      changedFiles: ["packages/dllm-verifier/src/index.ts"],
      proposedTouchedFiles: ["packages/dllm-verifier/src/index.ts"],
      allowedFiles: ["packages/dllm-verifier/src/index.ts"],
      requiredFiles: ["packages/dllm-verifier/src/index.ts"],
      unresolvedConflicts: [],
      staleFactCount: 0,
      sensitivePatternCount: 0,
      proposedAddedLines: ["export const ok = true;"]
    }
  },
  {
    id: "unresolved_remask_requires_remask",
    expectedDecision: "remask_required",
    input: {
      taskId: "unresolved_remask_requires_remask",
      changedFiles: ["packages/code-benchmark/src/index.ts"],
      proposedTouchedFiles: ["packages/code-benchmark/src/index.ts"],
      allowedFiles: ["packages/code-benchmark/src/index.ts"],
      requiredFiles: ["packages/code-benchmark/src/index.ts"],
      unresolvedConflicts: [
        {
          kind: "remask_unresolved",
          filePath: "packages/code-benchmark/src/index.ts"
        }
      ],
      staleFactCount: 0,
      sensitivePatternCount: 0,
      proposedAddedLines: []
    }
  },
  {
    id: "scope_broadening_rejected",
    expectedDecision: "reject",
    input: {
      taskId: "scope_broadening_rejected",
      changedFiles: ["apps/cli/src/a.ts"],
      proposedTouchedFiles: ["apps/cli/src/a.ts", "apps/cli/src/unrelated.ts"],
      allowedFiles: ["apps/cli/src/a.ts"],
      requiredFiles: ["apps/cli/src/a.ts"],
      unresolvedConflicts: [],
      staleFactCount: 0,
      sensitivePatternCount: 0,
      proposedAddedLines: []
    }
  },
  {
    id: "sensitive_added_line_rejected",
    expectedDecision: "reject",
    input: {
      taskId: "sensitive_added_line_rejected",
      changedFiles: ["apps/cli/src/github-pr-live-fetch.ts"],
      proposedTouchedFiles: ["apps/cli/src/github-pr-live-fetch.ts"],
      allowedFiles: ["apps/cli/src/github-pr-live-fetch.ts"],
      requiredFiles: ["apps/cli/src/github-pr-live-fetch.ts"],
      unresolvedConflicts: [],
      staleFactCount: 0,
      sensitivePatternCount: 0,
      proposedAddedLines: ["authorization: `Bearer ${token}`"]
    }
  }
];

const results = cases.map((testCase) => {
  const output = runDllmStyleVerifier(testCase.input);

  return {
    id: testCase.id,
    expectedDecision: testCase.expectedDecision,
    actualDecision: output.decision,
    passed: output.decision === testCase.expectedDecision,
    signalCount: output.signals.length,
    maskRegionCount: output.maskRegions.length,
    summary: output.summary
  };
});

const passedCount = results.filter((result) => result.passed).length;
const ok = passedCount === results.length;

const report = {
  ok,
  smokeName: "dllm-verifier-smoke-v1",
  suiteName: "phase-l-dllm-style-verifier-core",
  caseCount: results.length,
  passedCount,
  failedCount: results.length - passedCount,
  results
};

if (!ok) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(report, null, 2));
