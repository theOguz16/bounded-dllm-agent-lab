import {
  runDllmVerifierOnPipelineCandidate,
  type DllmVerifierDecision,
  type DllmVerifierPipelineCandidate
} from "../../../packages/dllm-verifier/src/index.js";

type PipelineSmokeCase = {
  id: string;
  expectedDecision: DllmVerifierDecision;
  candidate: DllmVerifierPipelineCandidate;
};

const cases: PipelineSmokeCase[] = [
  {
    id: "bounded_repair_clean_candidate",
    expectedDecision: "approve",
    candidate: {
      taskId: "bounded_repair_clean_candidate",
      changedFiles: [
        "packages/code-benchmark/src/index.ts",
        "apps/cli/src/code-model-patch-benchmark.ts"
      ],
      proposedTouchedFiles: [
        "packages/code-benchmark/src/index.ts",
        "apps/cli/src/code-model-patch-benchmark.ts"
      ],
      proposedAddedLines: [
        "const decision = verifierDecision;"
      ]
    }
  },
  {
    id: "bounded_repair_unresolved_remask_candidate",
    expectedDecision: "remask_required",
    candidate: {
      taskId: "bounded_repair_unresolved_remask_candidate",
      changedFiles: [
        "packages/code-benchmark/src/index.ts"
      ],
      proposedTouchedFiles: [
        "packages/code-benchmark/src/index.ts"
      ],
      unresolvedConflicts: [
        {
          kind: "remask_unresolved",
          filePath: "packages/code-benchmark/src/index.ts"
        }
      ],
      proposedAddedLines: []
    }
  },
  {
    id: "bounded_repair_stale_authority_candidate",
    expectedDecision: "remask_required",
    candidate: {
      taskId: "bounded_repair_stale_authority_candidate",
      changedFiles: [
        "packages/code-benchmark/src/index.ts"
      ],
      proposedTouchedFiles: [
        "packages/code-benchmark/src/index.ts"
      ],
      unresolvedConflicts: [
        {
          kind: "stale_authority",
          filePath: "packages/code-benchmark/src/index.ts"
        }
      ],
      staleFactCount: 1,
      proposedAddedLines: []
    }
  },
  {
    id: "bounded_repair_scope_broadened_candidate",
    expectedDecision: "reject",
    candidate: {
      taskId: "bounded_repair_scope_broadened_candidate",
      changedFiles: [
        "packages/code-benchmark/src/index.ts"
      ],
      proposedTouchedFiles: [
        "packages/code-benchmark/src/index.ts",
        "apps/cli/src/unrelated-worker.ts"
      ],
      allowedFiles: [
        "packages/code-benchmark/src/index.ts"
      ],
      proposedAddedLines: []
    }
  },
  {
    id: "bounded_repair_sensitive_added_line_candidate",
    expectedDecision: "reject",
    candidate: {
      taskId: "bounded_repair_sensitive_added_line_candidate",
      changedFiles: [
        "apps/cli/src/github-pr-live-fetch.ts"
      ],
      proposedTouchedFiles: [
        "apps/cli/src/github-pr-live-fetch.ts"
      ],
      proposedAddedLines: [
        "authorization: `Bearer ${token}`"
      ]
    }
  }
];

const results = cases.map((testCase) => {
  const output = runDllmVerifierOnPipelineCandidate(testCase.candidate);

  return {
    id: testCase.id,
    expectedDecision: testCase.expectedDecision,
    actualDecision: output.decision,
    passed: output.decision === testCase.expectedDecision,
    signalCount: output.signals.length,
    maskRegionCount: output.maskRegions.length,
    approvedFileCount: output.approvedFiles.length,
    rejectedFileCount: output.rejectedFiles.length,
    summary: output.summary
  };
});

const passedCount = results.filter((result) => result.passed).length;
const ok = passedCount === results.length;

const report = {
  ok,
  smokeName: "dllm-verifier-pipeline-smoke-v1",
  suiteName: "dllm-verifier-pipeline-candidate-integration",
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
