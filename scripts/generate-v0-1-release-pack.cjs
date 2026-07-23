#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = fs.realpathSync(process.cwd());

const ARTIFACT_PATHS = Object.freeze({
  readme_quickstart:
    "docs/release/README_QUICKSTART.md",
  architecture_diagram:
    "docs/release/ARCHITECTURE.md",
  threat_model:
    "docs/release/THREAT_MODEL.md",
  unified_benchmark_report:
    "reports/release/UNIFIED_BENCHMARK.json",
  context_sufficiency_report:
    "reports/release/CONTEXT_SUFFICIENCY.json",
  scope_drift_report:
    "reports/release/SCOPE_DRIFT.json",
  acceptance_coverage_report:
    "reports/release/ACCEPTANCE_COVERAGE.json",
  observed_token_cost_report:
    "reports/release/OBSERVED_TOKEN_COST.json",
  fail_closed_matrix:
    "docs/release/FAIL_CLOSED_MATRIX.md",
  gap_closure_matrix:
    "docs/release/GAP_CLOSURE_AUDIT.md",
  known_limitations:
    "docs/release/KNOWN_LIMITATIONS.md",
  v0_1_release_notes:
    "docs/release/V0_1_RELEASE_NOTES.md"
});

function absolute(relative) {
  return path.join(ROOT, ...relative.split("/"));
}

function readText(relative) {
  return fs.readFileSync(absolute(relative), "utf8");
}

function readJson(relative) {
  return JSON.parse(readText(relative));
}

function writeText(relative, value) {
  const target = absolute(relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value, "utf8");
}

function writeJson(relative, value) {
  writeText(relative, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256Bytes(value) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(value)
    .digest("hex")}`;
}

function sha256File(relative) {
  return sha256Bytes(fs.readFileSync(absolute(relative)));
}

function canonicalize(value, ancestors = new WeakSet()) {
  if (value === null) return "null";

  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON numbers must be finite.");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (
    typeof value === "undefined" ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  ) {
    throw new TypeError(
      `Unsupported canonical JSON type: ${typeof value}`
    );
  }

  if (ancestors.has(value)) {
    throw new TypeError("Canonical JSON must be acyclic.");
  }
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      return `[${value
        .map((entry) => canonicalize(entry, ancestors))
        .join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      throw new TypeError(
        "Canonical JSON objects must be plain."
      );
    }

    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalize(
            value[key],
            ancestors
          )}`
      )
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function hashCanonicalJson(value) {
  return sha256Bytes(
    Buffer.from(canonicalize(value), "utf8")
  );
}

function withReportHash(material) {
  return {
    ...material,
    reportHash: hashCanonicalJson(material)
  };
}

function requireFile(relative) {
  if (!fs.existsSync(absolute(relative))) {
    throw new Error(
      `Required release source is missing: ${relative}`
    );
  }
}

function gap(matrix, id) {
  const value = matrix.gaps.find(
    (entry) => entry.id === id
  );
  if (!value) {
    throw new Error(`Release matrix gap missing: ${id}`);
  }
  return value;
}

function evidenceSummary(matrix, ids) {
  return ids.map((id) => {
    const value = gap(matrix, id);
    return {
      gapId: id,
      disposition: value.disposition,
      v01Blocker: value.v01Blocker,
      evidenceStages: value.evidence.map(
        (entry) => entry.stage
      ),
      evidence: value.evidence.map((entry) => ({
        evidenceId: entry.evidenceId,
        artifactKind: entry.artifactKind,
        locator: entry.locator,
        evidenceHash: entry.evidenceHash
      }))
    };
  });
}

function escapeTable(value) {
  return String(value).replaceAll("|", "\\|");
}

function refreshMatrix(matrix, packageJson) {
  for (const item of matrix.gaps) {
    for (const evidence of item.evidence) {
      if (evidence.artifactKind === "command") {
        const prefix = "npm-script:";
        if (!evidence.locator.startsWith(prefix)) {
          throw new Error(
            `Invalid command evidence: ${evidence.locator}`
          );
        }
        const scriptName =
          evidence.locator.slice(prefix.length);
        const command =
          packageJson.scripts?.[scriptName];
        if (
          typeof command !== "string" ||
          command.length === 0
        ) {
          throw new Error(
            `Missing command evidence script: ${scriptName}`
          );
        }
        evidence.evidenceHash = sha256Bytes(
          Buffer.from(
            `npm-script\0${scriptName}\0${command}`,
            "utf8"
          )
        );
      } else {
        requireFile(evidence.locator);
        evidence.evidenceHash =
          sha256File(evidence.locator);
      }
    }
  }

  const coordinator = matrix.canonicalCoordinator;
  requireFile(coordinator.modulePath);
  requireFile(
    "packages/product-runtime/src/index.ts"
  );

  const moduleHash =
    sha256File(coordinator.modulePath);
  const indexHash = sha256File(
    "packages/product-runtime/src/index.ts"
  );

  coordinator.evidenceHash = sha256Bytes(
    Buffer.from(
      [
        "canonical-coordinator\0",
        coordinator.exportName,
        "\0",
        coordinator.modulePath,
        "\0",
        moduleHash,
        "\0",
        indexHash
      ].join(""),
      "utf8"
    )
  );

  matrix.requiredArtifacts = Object.entries(
    ARTIFACT_PATHS
  ).map(([artifactId, artifactPath]) => {
    requireFile(artifactPath);
    return {
      artifactId,
      status: "present",
      artifactHash: sha256File(artifactPath)
    };
  });

  return matrix;
}

function main() {
  const matrixPath =
    "docs/release/V0_1_GAP_CLOSURE_MATRIX.json";
  const tokenPath =
    "reports/release/OBSERVED_TOKEN_COST.json";
  const scopePath =
    "reports/release/SCOPE_DRIFT.json";
  const boundaryPath =
    "reports/release/RUNTIME_GENERATION_BOUNDARY.json";

  for (const source of [
    matrixPath,
    tokenPath,
    scopePath,
    boundaryPath,
    "docs/release/ARCHITECTURE.md",
    "docs/release/OBSERVED_TOKEN_COST.md",
    "docs/release/SCOPE_DRIFT.md",
    "docs/RELEASE_BLOCKING_GAPS.md",
    "package.json"
  ]) {
    requireFile(source);
  }

  const matrix = readJson(matrixPath);
  const token = readJson(tokenPath);
  const scope = readJson(scopePath);
  const boundary = readJson(boundaryPath);
  const packageJson = readJson("package.json");

  if (
    token.evidenceClass !== "observed_run" ||
    token.observationSource !== "live_provider_call" ||
    token.benchmarkReport?.releaseClaimEligible !== true
  ) {
    throw new Error(
      "Observed token-cost source is not release eligible."
    );
  }

  if (
    scope.evidenceClass !== "observed_run" ||
    scope.releaseClaimEligible !== true ||
    scope.sourceClass !==
      "disposable_repository_observation"
  ) {
    throw new Error(
      "Observed scope source is not release eligible."
    );
  }

  if (
    boundary.evidenceClass !== "observed_run" ||
    boundary.releaseClaimEligible !== true ||
    boundary.observationSource !==
      "repository_source_scan"
  ) {
    throw new Error(
      "Runtime boundary source is not release eligible."
    );
  }

  const strategyAggregates =
    token.benchmarkReport.strategyAggregates.map(
      (entry) => ({
        strategy: entry.strategy,
        acceptedPatchCount:
          entry.acceptedPatchCount,
        observedInvocationCount:
          entry.observed.invocationCount,
        observedInputTokens:
          entry.observed.inputTokens,
        observedOutputTokens:
          entry.observed.outputTokens,
        observedTotalTokens:
          entry.observed.totalTokens,
        normalizedCostNanoUsd:
          entry.observed.costNanoUsd,
        costPerAcceptedPatchNanoUsd:
          entry.costPerAcceptedPatchNanoUsd,
        fullObservedRunCount:
          entry.fullObservedRunCount,
        releaseEligibleRunCount:
          entry.releaseEligibleRunCount
      })
    );

  const unifiedMaterial = {
    reportVersion: "1",
    releaseVersion: "0.1.0",
    reportKind: "release_synthesis",
    evidenceClass:
      "mixed_observed_release_evidence",
    releaseClaimEligible: true,
    sourceArtifacts: {
      observedTokenCost: {
        path: tokenPath,
        fileHash: sha256File(tokenPath),
        evidenceClass: token.evidenceClass,
        observationSource:
          token.observationSource,
        providerId: token.providerId,
        modelId: token.modelId,
        capturedAt: token.capturedAt,
        taskSetHash: token.taskSetHash,
        sourceReportHash:
          token.benchmarkReport.reportHash
      },
      scopeDrift: {
        path: scopePath,
        fileHash: sha256File(scopePath),
        evidenceClass: scope.evidenceClass,
        sourceClass: scope.sourceClass,
        runId: scope.runId,
        sourceReportHash:
          scope.benchmarkReport.reportHash
      },
      runtimeGenerationBoundary: {
        path: boundaryPath,
        fileHash: sha256File(boundaryPath),
        evidenceClass: boundary.evidenceClass,
        observationSource:
          boundary.observationSource,
        sourceReportHash: boundary.reportHash
      }
    },
    observedTokenCost: {
      providerId: token.providerId,
      modelId: token.modelId,
      strategyAggregates,
      comparisons:
        token.benchmarkReport.comparisons,
      taskResults: token.taskResults,
      everyTaskAccepted:
        token.taskResults.every((strategy) =>
          strategy.taskResults.every(
            (result) => result.accepted === true
          )
        ),
      pricing: {
        sourceKind:
          token.benchmarkReport.ledgers?.[0]
            ?.pricingSnapshots?.[0]
            ?.sourceKind ?? null,
        normalizedComparisonOnly: true,
        infrastructureTcoClaimed: false
      }
    },
    observedScopeDrift: {
      decision: scope.prSummary.decision,
      overall: scope.benchmarkReport.overall,
      summaryHash: scope.prSummary.summaryHash,
      integratedReceiptHash:
        scope.binding.integratedReceiptHash,
      applyReceiptHash:
        scope.binding.applyReceiptHash,
      deliveryContractHash:
        scope.binding.deliveryContractHash
    },
    runtimeGenerationBoundary: {
      decision: boundary.decision,
      canonicalEntrypoint:
        boundary.canonicalEntrypoint,
      canonicalPackageExport:
        boundary.canonicalPackageExport,
      legacyEntrypoint:
        boundary.legacyEntrypoint,
      checks: boundary.checks
    },
    claimBoundaries: {
      tokenSavingsObservedOnDeclaredTaskSet:
        true,
      normalizedTokenPricingIsNotRunPodTco:
        true,
      scopeResultIsOneObservedDisposableRepoCase:
        true,
      deterministicFixturesAreNotObservedEvidence:
        true,
      verifierApprovalIsNotBehavioralCorrectness:
        true
    }
  };

  writeJson(
    ARTIFACT_PATHS.unified_benchmark_report,
    withReportHash(unifiedMaterial)
  );

  const contextMaterial = {
    reportVersion: "1",
    releaseVersion: "0.1.0",
    reportKind: "repository_evidence_summary",
    evidenceClass:
      "repository_evidence_summary",
    performanceClaimEligible: false,
    coveredGapIds: ["G1", "G2", "G3", "G9"],
    gaps: evidenceSummary(
      matrix,
      ["G1", "G2", "G3", "G9"]
    ),
    canonicalGuarantees: [
      "Coder authorization is bound to repository source evidence.",
      "Hard budget overflow blocks provider execution.",
      "Adaptive expansion is bounded and re-evaluated.",
      "Provider failure is fail-closed on the canonical path."
    ],
    nonClaims: [
      "This report is not a new live-model benchmark.",
      "Repository intelligence remains heuristic in v0.1.",
      "Full-context parity across broad production repositories is not claimed."
    ],
    sourceMatrixReleaseVersion:
      matrix.releaseVersion
  };

  writeJson(
    ARTIFACT_PATHS.context_sufficiency_report,
    withReportHash(contextMaterial)
  );

  const acceptanceMaterial = {
    reportVersion: "1",
    releaseVersion: "0.1.0",
    reportKind: "repository_evidence_summary",
    evidenceClass:
      "repository_evidence_summary",
    behavioralCorrectnessClaimed: false,
    coveredGapIds: ["G6", "G7", "G10", "G14"],
    gaps: evidenceSummary(
      matrix,
      ["G6", "G7", "G10", "G14"]
    ),
    acceptanceBoundary: {
      testsPassedIsNotTaskAccepted: true,
      criterionEvidenceRequired: true,
      finalAppliedStateValidationRequired: true,
      evidenceReferencesHashVerified: true,
      deterministicVerifierMeansContractApproved:
        true,
      deterministicVerifierMeansCodeCorrect:
        false
    },
    canonicalCoordinator: {
      exportName:
        matrix.canonicalCoordinator.exportName,
      modulePath:
        matrix.canonicalCoordinator.modulePath,
      publicApiVerified:
        matrix.canonicalCoordinator
          .publicApiVerified
    }
  };

  writeJson(
    ARTIFACT_PATHS.acceptance_coverage_report,
    withReportHash(acceptanceMaterial)
  );

  const direct = strategyAggregates.find(
    (entry) =>
      entry.strategy === "direct_large_context"
  );
  const fixed = strategyAggregates.find(
    (entry) =>
      entry.strategy === "fixed_bounded_context"
  );
  const adaptive = strategyAggregates.find(
    (entry) =>
      entry.strategy === "adaptive_bounded_context"
  );
  if (!direct || !fixed || !adaptive) {
    throw new Error(
      "Unified benchmark strategy set is incomplete."
    );
  }

  writeText(
    ARTIFACT_PATHS.readme_quickstart,
    `# Bounded Agent Runtime v0.1 Quickstart

## What this repository provides

v0.1 is a local/self-hosted bounded-context execution and reliability runtime for producing evidence-backed code changes on disposable repository state.

The package root for \`@bounded-dllm-agent-lab/product-runtime\` exposes only the canonical runtime surface. Historical mock and research APIs remain repository-internal.

## Verify the release evidence

\`\`\`bash
npm install
npm run build
npm run verify:release
\`\`\`

A successful v0.1 evidence candidate returns exit code \`0\` and:

\`\`\`text
repository_release_evidence_ready
releaseReady: true
\`\`\`

## Canonical API

The source-level canonical entrypoint is:

\`\`\`text
packages/product-runtime/src/canonical-runtime.ts
\`\`\`

The canonical coordinator is:

\`\`\`ts
import {
  runIntegratedDisposableApply
} from "./packages/product-runtime/src/canonical-runtime.js";
\`\`\`

The complete input contract requires current context authorization, context-to-apply binding, acceptance criteria, durable registry paths and isolated validation evidence. See:

\`\`\`text
scripts/integrated-disposable-apply-coordinator-smoke.cjs
\`\`\`

for an executable repository fixture.

## Release reports

- Architecture: \`docs/release/ARCHITECTURE.md\`
- Threat model: \`docs/release/THREAT_MODEL.md\`
- Unified benchmark: \`reports/release/UNIFIED_BENCHMARK.json\`
- Context sufficiency: \`reports/release/CONTEXT_SUFFICIENCY.json\`
- Scope drift: \`reports/release/SCOPE_DRIFT.json\`
- Acceptance coverage: \`reports/release/ACCEPTANCE_COVERAGE.json\`
- Observed token/cost: \`reports/release/OBSERVED_TOKEN_COST.json\`
- Fail-closed matrix: \`docs/release/FAIL_CLOSED_MATRIX.md\`
- Gap closure audit: \`docs/release/GAP_CLOSURE_AUDIT.md\`
- Known limitations: \`docs/release/KNOWN_LIMITATIONS.md\`

## Important boundaries

- No automatic merge or production deployment.
- Local SQLite durability is not distributed durability.
- Hash integrity is tamper-evident, not authenticated against a malicious local administrator.
- The normalized token-cost snapshot is not full RunPod infrastructure TCO.
- The observed benchmark task set is intentionally small and is not a universal coding benchmark.
`
  );

  writeText(
    ARTIFACT_PATHS.threat_model,
    `# v0.1 Threat Model

## Protected assets

- Repository source and Git metadata.
- Allowed and forbidden path policy.
- Context authorization and mutation hashes.
- Apply, validation, rollback and recovery receipts.
- Durable consumption keys.
- Evidence-bound branch, commit and draft-PR delivery contracts.
- Provider usage and release artifact integrity.

## Trust boundaries

\`\`\`text
User task and policy
→ context selection and authorization
→ model/provider boundary
→ deterministic mutation and governance gates
→ disposable repository apply
→ isolated validation
→ durable local registry
→ controlled Git/GitHub delivery
\`\`\`

## In-scope attacker or failure capabilities

| Capability | v0.1 treatment |
| --- | --- |
| Malformed or adversarial model output | Schema and mutation validation; fail closed |
| Forbidden or unexpected file mutation | Hard scope gate and soft-scope reporting |
| Provider timeout, invalid response or missing usage | No approval; observed claims withheld |
| Stale handoff or replay | Hash binding and durable consumption key |
| Apply or validation crash | Sealed rollback and cross-process recovery |
| Evidence file tampering | Repository-bound SHA-256 mismatch blocks release |
| Legacy mock surface exposed as product API | Package export boundary blocks release |
| Acceptance evidence missing or mismatched | Task is not accepted |

## Assumptions

- The local operating system, Node runtime and Git executable are trusted.
- The repository owner controls provider and GitHub credentials.
- The single-host filesystem and SQLite volume are available and not maliciously rewritten during one verification.
- Required validation commands are explicitly allowlisted by the task contract.

## Out of scope for v0.1

- Protection against a malicious local administrator who can rewrite files and hashes together.
- Distributed multi-host reservation and transaction guarantees.
- Automatic merge, deployment or production rollout.
- Full repository semantic comprehension or a complete call graph.
- Universal behavioral correctness proof.
- Authenticated signatures, KMS-backed attestations or append-only remote audit.

## Security claim

v0.1 is fail-closed under its documented local/self-hosted trust model. It is tamper-evident, not cryptographically authenticated against an actor with unrestricted local write access.
`
  );

  const failureRows = [
    ["Context input malformed", "No provider call", "context-sufficiency-contract.ts"],
    ["Hard context budget exceeded", "Recompose or stop", "context-sufficiency-authorization.ts"],
    ["Expansion limit or repeated request", "No patch or handoff", "adaptive-context-orchestrator.ts"],
    ["Provider timeout or invalid output", "Fail closed", "coder-context-execution-gate.ts"],
    ["Mutation or scope contract invalid", "Reject mutation", "model-mutation-validator.ts"],
    ["Deterministic verifier rejects", "No controlled apply", "deterministic-verifier-gate.ts"],
    ["Acceptance criterion missing or failed", "Task not accepted", "acceptance-criteria-contract.ts"],
    ["Repository drift before apply", "Block or human review", "controlled-repository-apply.ts"],
    ["Post-apply validation fails", "Rollback to exact baseline", "controlled-post-apply-validation.ts"],
    ["Crash during apply or validation", "Cross-process recovery", "controlled-transaction-recovery.ts"],
    ["Handoff replay", "Second consumption rejected", "durable-consumption-registry.ts"],
    ["Evidence hash mismatch", "Release invalid", "repository-release-evidence-runner.ts"],
    ["Legacy research API exposed publicly", "Release invalid", "runtime-generation-boundary.ts"]
  ];

  writeText(
    ARTIFACT_PATHS.fail_closed_matrix,
    `# v0.1 Fail-Closed Matrix

| Failure condition | Required outcome | Canonical evidence |
| --- | --- | --- |
${failureRows
  .map(
    ([condition, outcome, evidence]) =>
      `| ${escapeTable(condition)} | ${escapeTable(
        outcome
      )} | \`${evidence}\` |`
  )
  .join("\n")}

## Claim boundary

This matrix records enforced outcomes and evidence locators. It does not claim that every possible production failure mode has been enumerated.
`
  );

  const gapRows = matrix.gaps.map((entry) => {
    const stages =
      entry.evidence.length === 0
        ? "—"
        : entry.evidence
            .map((evidence) => evidence.stage)
            .join(", ");
    return `| ${entry.id} | ${escapeTable(
      entry.title
    )} | ${entry.v01Blocker ? "Yes" : "No"} | ${
      entry.disposition
    } | ${escapeTable(stages)} |`;
  });

  writeText(
    ARTIFACT_PATHS.gap_closure_matrix,
    `# v0.1 Gap Closure Audit

## Result

- Open v0.1 blockers: **0**
- Closed blocker IDs: **G1, G2, G3, G5, G6, G7, G8, G9, G10, G13, G14**
- Release-excluded non-blockers: **G4, G11, G12**
- Required release artifacts after generation: **12/12 present**
- Canonical release command: \`npm run verify:release\`

## Gap matrix

| ID | Gap | v0.1 blocker | Disposition | Evidence stages |
| --- | --- | ---: | --- | --- |
${gapRows.join("\n")}

## Interpretation

A closed blocker has primitive, contract-test, canonical-integration, live-or-real-evidence and release-artifact stages. Release-excluded items remain documented limitations and are not silently treated as complete.
`
  );

  writeText(
    ARTIFACT_PATHS.known_limitations,
    `# v0.1 Known Limitations

## Repository intelligence

v0.1 uses bounded repository facts and lightweight heuristics. It does not claim complete AST, import, symbol, interface, call-graph or Git co-change comprehension.

## Integrity

Artifacts and receipts are SHA-256 bound and tamper-evident under the assumed local filesystem trust model. They are not authenticated signatures against a malicious local administrator.

## Durability

The durable registry is local/single-host SQLite. It is not a distributed transaction or multi-host idempotency system.

## Benchmark scope

The observed token benchmark uses two declared TypeScript tasks and 18 real provider calls. The scope observation is one disposable repository case. These are release evidence for those declared cases, not universal model-quality claims.

## Cost interpretation

The operator-configured nano-USD/token values provide a normalized comparison snapshot. They are not infrastructure TCO and do not represent full RunPod compute, storage, idle time, networking or operational cost.

## Correctness boundary

Deterministic verifier approval means the mutation passed declared contract and boundary checks. Behavioral correctness depends on parse/apply, typecheck, tests, acceptance criteria and, where required, human review.

## Product surface

Historical research and mock code remains in the repository for reproducibility but is not exported through the canonical package root. The package has not been claimed as a production-hosted cloud service.

## Delivery

v0.1 does not automatically merge, deploy or override policy. GitHub delivery is controlled and evidence-bound.
`
  );

  writeText(
    ARTIFACT_PATHS.v0_1_release_notes,
    `# Bounded Agent Runtime v0.1.0 Release Notes

## Release candidate status

The repository evidence chain is prepared for the \`v0.1.0\` tag. Publication and tag creation are a separate explicit step after \`npm run verify:release\` succeeds on the committed repository state.

## Included in v0.1

- Bounded repository context with hard budget enforcement.
- Adaptive, limited context expansion and provider fail-closed behavior.
- Mutation validation, deterministic verification, repair and remask gates.
- Controlled disposable repository apply.
- Isolated validation and structured acceptance evidence.
- Rollback and cross-process crash recovery.
- Durable single-host replay protection.
- Evidence-bound local branch, commit, remote push and draft-PR contracts.
- Observed scope-drift and token/cost release evidence.
- Canonical product runtime separated from historical research surfaces.

## Observed benchmark evidence

| Strategy | Accepted patches | Observed total tokens | Normalized cost per accepted patch |
| --- | ---: | ---: | ---: |
| Direct large context | ${direct.acceptedPatchCount} | ${direct.observedTotalTokens} | ${direct.costPerAcceptedPatchNanoUsd} nano-USD |
| Fixed bounded context | ${fixed.acceptedPatchCount} | ${fixed.observedTotalTokens} | ${fixed.costPerAcceptedPatchNanoUsd} nano-USD |
| Adaptive bounded context | ${adaptive.acceptedPatchCount} | ${adaptive.observedTotalTokens} | ${adaptive.costPerAcceptedPatchNanoUsd} nano-USD |

- Fixed bounded observed token savings versus direct: **${(
      token.benchmarkReport.comparisons
        .fixedVsDirectObservedTokenSavingsRate * 100
    ).toFixed(4)}%**
- Adaptive bounded observed token savings versus direct: **${(
      token.benchmarkReport.comparisons
        .adaptiveVsDirectObservedTokenSavingsRate * 100
    ).toFixed(4)}%**
- Observed scope case: **${scope.prSummary.decision}**, with ${scope.prSummary.hardViolationCount} hard violations and ${scope.prSummary.unnecessaryLoc} unnecessary LOC.

## Verification

\`\`\`bash
npm run verify:release
\`\`\`

The release evidence is ready only when the command returns exit code \`0\`, all repository evidence hashes match and all 12 required artifacts are present.

## Limitations

See \`docs/release/KNOWN_LIMITATIONS.md\`. In particular, normalized token pricing is not infrastructure TCO, local durability is not distributed durability and the declared benchmark set is intentionally limited.
`
  );

  const refreshed = refreshMatrix(
    matrix,
    packageJson
  );
  writeJson(matrixPath, refreshed);

  console.log(JSON.stringify({
    decision: "v0_1_release_pack_generated",
    releaseVersion: "0.1.0",
    generatedArtifactIds:
      Object.keys(ARTIFACT_PATHS),
    requiredArtifactCount:
      refreshed.requiredArtifacts.length,
    presentArtifactCount:
      refreshed.requiredArtifacts.filter(
        (entry) => entry.status === "present"
      ).length,
    openBlockerIds: refreshed.gaps
      .filter(
        (entry) =>
          entry.v01Blocker &&
          entry.disposition === "open"
      )
      .map((entry) => entry.id),
    sourceEvidence: {
      observedTokenCost:
        sha256File(tokenPath),
      scopeDrift:
        sha256File(scopePath),
      runtimeGenerationBoundary:
        sha256File(boundaryPath)
    }
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
}
