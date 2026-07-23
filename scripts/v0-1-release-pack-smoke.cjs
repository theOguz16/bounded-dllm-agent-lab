#!/usr/bin/env node

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function sha256File(relative) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.resolve(relative)))
    .digest("hex")}`;
}

async function main() {
  const runtime = await import(
    "../dist/packages/product-runtime/src/index.js"
  );
  const {
    hashCanonicalJson,
    runRepositoryReleaseEvidence
  } = runtime;

  const root = fs.realpathSync(process.cwd());
  const matrix = JSON.parse(
    fs.readFileSync(
      path.resolve(
        "docs/release/V0_1_GAP_CLOSURE_MATRIX.json"
      ),
      "utf8"
    )
  );
  const unified = JSON.parse(
    fs.readFileSync(
      path.resolve(
        "reports/release/UNIFIED_BENCHMARK.json"
      ),
      "utf8"
    )
  );
  const context = JSON.parse(
    fs.readFileSync(
      path.resolve(
        "reports/release/CONTEXT_SUFFICIENCY.json"
      ),
      "utf8"
    )
  );
  const acceptance = JSON.parse(
    fs.readFileSync(
      path.resolve(
        "reports/release/ACCEPTANCE_COVERAGE.json"
      ),
      "utf8"
    )
  );

  let checks = 0;
  const check = async (name, callback) => {
    console.log(`[run] ${name}`);
    await callback();
    checks += 1;
    console.log(`[ok] ${name}`);
  };

  const reportCore = (report) => {
    const value = structuredClone(report);
    delete value.reportHash;
    return value;
  };

  await check(
    "all twelve required artifacts are declared present",
    () => {
      assert.equal(
        matrix.requiredArtifacts.length,
        12
      );
      assert.equal(
        matrix.requiredArtifacts.every(
          (entry) =>
            entry.status === "present" &&
            /^sha256:[0-9a-f]{64}$/.test(
              entry.artifactHash
            )
        ),
        true
      );
    }
  );

  await check(
    "every declared artifact hash matches repository bytes",
    () => {
      const paths = {
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
      };

      for (const declaration of matrix.requiredArtifacts) {
        assert.equal(
          declaration.artifactHash,
          sha256File(
            paths[declaration.artifactId]
          ),
          declaration.artifactId
        );
      }
    }
  );

  await check(
    "unified benchmark preserves observed source classes",
    () => {
      assert.equal(
        unified.reportKind,
        "release_synthesis"
      );
      assert.equal(
        unified.releaseClaimEligible,
        true
      );
      assert.equal(
        unified.sourceArtifacts
          .observedTokenCost
          .evidenceClass,
        "observed_run"
      );
      assert.equal(
        unified.sourceArtifacts.scopeDrift
          .evidenceClass,
        "observed_run"
      );
      assert.equal(
        unified.sourceArtifacts
          .runtimeGenerationBoundary
          .evidenceClass,
        "observed_run"
      );
    }
  );

  await check(
    "unified benchmark source hashes match observed reports",
    () => {
      assert.equal(
        unified.sourceArtifacts
          .observedTokenCost.fileHash,
        sha256File(
          "reports/release/OBSERVED_TOKEN_COST.json"
        )
      );
      assert.equal(
        unified.sourceArtifacts
          .scopeDrift.fileHash,
        sha256File(
          "reports/release/SCOPE_DRIFT.json"
        )
      );
      assert.equal(
        unified.sourceArtifacts
          .runtimeGenerationBoundary.fileHash,
        sha256File(
          "reports/release/RUNTIME_GENERATION_BOUNDARY.json"
        )
      );
    }
  );

  await check(
    "unified benchmark keeps normalized cost outside TCO claims",
    () => {
      assert.equal(
        unified.observedTokenCost.pricing
          .normalizedComparisonOnly,
        true
      );
      assert.equal(
        unified.observedTokenCost.pricing
          .infrastructureTcoClaimed,
        false
      );
      assert.equal(
        unified.claimBoundaries
          .normalizedTokenPricingIsNotRunPodTco,
        true
      );
    }
  );

  await check(
    "all observed benchmark tasks remain accepted",
    () => {
      assert.equal(
        unified.observedTokenCost
          .everyTaskAccepted,
        true
      );
      assert.equal(
        unified.observedTokenCost
          .strategyAggregates.length,
        3
      );
    }
  );

  await check(
    "synthesis report hashes are canonical and current",
    () => {
      for (const report of [
        unified,
        context,
        acceptance
      ]) {
        assert.equal(
          report.reportHash,
          hashCanonicalJson(
            reportCore(report)
          )
        );
      }
    }
  );

  await check(
    "context report is evidence summary not a new performance claim",
    () => {
      assert.equal(
        context.reportKind,
        "repository_evidence_summary"
      );
      assert.equal(
        context.performanceClaimEligible,
        false
      );
      assert.deepEqual(
        context.coveredGapIds,
        ["G1", "G2", "G3", "G9"]
      );
      assert.equal(
        context.gaps.every(
          (entry) =>
            entry.disposition === "closed" &&
            entry.evidenceStages.length === 5
        ),
        true
      );
    }
  );

  await check(
    "acceptance report preserves verifier claim boundary",
    () => {
      assert.equal(
        acceptance.acceptanceBoundary
          .deterministicVerifierMeansContractApproved,
        true
      );
      assert.equal(
        acceptance.acceptanceBoundary
          .deterministicVerifierMeansCodeCorrect,
        false
      );
      assert.equal(
        acceptance.acceptanceBoundary
          .criterionEvidenceRequired,
        true
      );
    }
  );

  await check(
    "release documents contain required trust boundaries",
    () => {
      const threat = fs.readFileSync(
        path.resolve(
          "docs/release/THREAT_MODEL.md"
        ),
        "utf8"
      );
      const limitations = fs.readFileSync(
        path.resolve(
          "docs/release/KNOWN_LIMITATIONS.md"
        ),
        "utf8"
      );
      const quickstart = fs.readFileSync(
        path.resolve(
          "docs/release/README_QUICKSTART.md"
        ),
        "utf8"
      );

      assert.match(
        threat,
        /tamper-evident/i
      );
      assert.match(
        limitations,
        /not infrastructure TCO/i
      );
      assert.match(
        quickstart,
        /npm run verify:release/
      );
    }
  );

  await check(
    "repository evidence runner declares v0.1 ready",
    async () => {
      const result =
        await runRepositoryReleaseEvidence({
          repositoryPath: root,
          matrix
        });

      assert.equal(
        result.decision,
        "repository_release_evidence_ready",
        JSON.stringify(result)
      );
      assert.deepEqual(
        result.report.gapAudit.openBlockerIds,
        []
      );
      assert.deepEqual(
        result.report.gapAudit.missingArtifactIds,
        []
      );
      assert.equal(
        result.summary.evidenceLocatorCount,
        result.summary.evidenceMatchedCount
      );
      assert.equal(
        result.summary.missingArtifactCount,
        0
      );
      assert.equal(
        result.report.releaseReady,
        true
      );
    }
  );

  await check(
    "legacy research entrypoint remains outside package exports",
    () => {
      const manifest = JSON.parse(
        fs.readFileSync(
          path.resolve(
            "packages/product-runtime/package.json"
          ),
          "utf8"
        )
      );
      assert.deepEqual(
        manifest.exports,
        {
          ".": "./src/canonical-runtime.ts"
        }
      );
      assert.equal(
        JSON.stringify(manifest.exports)
          .includes("src/index.ts"),
        false
      );
    }
  );

  console.log(
    `v0.1 release pack smoke passed (${checks} checks)`
  );
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
