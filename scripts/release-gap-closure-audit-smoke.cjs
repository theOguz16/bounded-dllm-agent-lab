#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const runtime = await import(
    "../dist/packages/product-runtime/src/index.js"
  );
  const {
    buildV01ReleaseGapClosureAudit,
    hashCanonicalJson,
    verifyV01ReleaseGapClosureAudit
  } = runtime;

  const matrix = JSON.parse(
    fs.readFileSync(
      path.resolve(
        "docs/release/V0_1_GAP_CLOSURE_MATRIX.json"
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
  const clone = (value) =>
    structuredClone(value);
  const hash = (label) =>
    hashCanonicalJson({ label });

  function closeAllBlockers(input) {
    const value = clone(input);
    value.observedReleaseCommand =
      "verify:release";
    value.requiredArtifacts =
      value.requiredArtifacts.map(
        (artifact) => ({
          artifactId: artifact.artifactId,
          status: "present",
          artifactHash: hash(
            `artifact:${artifact.artifactId}`
          )
        })
      );
    value.gaps = value.gaps.map((gap) => {
      if (!gap.v01Blocker) {
        return gap;
      }
      return {
        id: gap.id,
        title: gap.title,
        v01Blocker: true,
        disposition: "closed",
        evidence: [
          "primitive",
          "contract_tests",
          "canonical_integration",
          "live_or_real_evidence",
          "release_artifact"
        ].map((stage) => ({
          stage,
          evidenceId:
            `${gap.id.toLowerCase()}.${stage}`,
          artifactKind: {
            primitive: "module",
            contract_tests: "test",
            canonical_integration:
              "integration",
            live_or_real_evidence:
              "report",
            release_artifact:
              "document"
          }[stage],
          locator:
            `release/${gap.id}/${stage}`,
          evidenceHash: hash(
            `${gap.id}:${stage}`
          )
        }))
      };
    });
    return value;
  }

  await check(
    "current v0.1 matrix is release ready",
    () => {
      const result =
        buildV01ReleaseGapClosureAudit(
          matrix
        );
      assert.equal(
        result.decision,
        "v01_release_gap_audit_ready",
        JSON.stringify(result)
      );
      assert.deepEqual(
        result.audit.openBlockerIds,
        []
      );
      assert.equal(
        result.audit.releaseReady,
        true
      );
    }
  );

  await check(
    "current matrix records repository-bound release command",
    () => {
      const result =
        buildV01ReleaseGapClosureAudit(
          matrix
        );
      assert.equal(
        result.audit.releaseCommandMatched,
        true
      );
      assert.equal(
        result.summary.releaseCommandMatched,
        true
      );
    }
  );

  await check(
    "current matrix declares every required release artifact present",
    () => {
      const result =
        buildV01ReleaseGapClosureAudit(
          matrix
        );
      assert.equal(
        result.audit.missingArtifactIds.length,
        0
      );
      assert.equal(
        result.summary.requiredArtifactsComplete,
        true
      );
    }
  );

  await check(
    "complete blocker chains command coordinator and artifacts make release ready",
    () => {
      const ready =
        closeAllBlockers(matrix);
      const result =
        buildV01ReleaseGapClosureAudit(
          ready
        );
      assert.equal(
        result.decision,
        "v01_release_gap_audit_ready",
        JSON.stringify(result)
      );
      assert.equal(
        result.audit.releaseReady,
        true
      );
      assert.deepEqual(
        result.audit.openBlockerIds,
        []
      );
    }
  );

  await check(
    "input ordering does not change the deterministic audit",
    () => {
      const first =
        closeAllBlockers(matrix);
      const second = clone(first);
      second.gaps.reverse();
      second.requiredArtifacts.reverse();
      const left =
        buildV01ReleaseGapClosureAudit(
          first
        );
      const right =
        buildV01ReleaseGapClosureAudit(
          second
        );
      assert.equal(
        left.audit.auditHash,
        right.audit.auditHash
      );
    }
  );

  await check(
    "duplicate gap IDs are invalid",
    () => {
      const value = clone(matrix);
      value.gaps[1] =
        clone(value.gaps[0]);
      const result =
        buildV01ReleaseGapClosureAudit(
          value
        );
      assert.equal(
        result.decision,
        "v01_release_gap_audit_invalid"
      );
      assert.ok(
        result.errors.includes(
          "release_gap_audit_gap_set_invalid"
        )
      );
    }
  );

  await check(
    "unknown or missing gap IDs are invalid",
    () => {
      const value = clone(matrix);
      value.gaps.pop();
      const result =
        buildV01ReleaseGapClosureAudit(
          value
        );
      assert.equal(
        result.decision,
        "v01_release_gap_audit_invalid"
      );
    }
  );

  await check(
    "closed blocker requires complete five-stage evidence",
    () => {
      const value =
        closeAllBlockers(matrix);
      value.gaps.find(
        (gap) => gap.id === "G5"
      ).evidence.pop();
      const result =
        buildV01ReleaseGapClosureAudit(
          value
        );
      assert.equal(
        result.decision,
        "v01_release_gap_audit_invalid"
      );
      assert.ok(
        result.errors.includes(
          "release_gap_audit_evidence_chain_incomplete"
        )
      );
    }
  );

  await check(
    "release exclusion requires limitation and approval evidence",
    () => {
      const value = clone(matrix);
      delete value.gaps.find(
        (gap) => gap.id === "G11"
      ).exclusion;
      const result =
        buildV01ReleaseGapClosureAudit(
          value
        );
      assert.equal(
        result.decision,
        "v01_release_gap_audit_invalid"
      );
    }
  );

  await check(
    "open non-blockers do not block an otherwise ready release",
    () => {
      const value =
        closeAllBlockers(matrix);
      for (
        const id of ["G4", "G11", "G12"]
      ) {
        const gap = value.gaps.find(
          (entry) => entry.id === id
        );
        gap.disposition = "open";
        gap.evidence = [];
        delete gap.exclusion;
      }
      const result =
        buildV01ReleaseGapClosureAudit(
          value
        );
      assert.equal(
        result.decision,
        "v01_release_gap_audit_ready",
        JSON.stringify(result)
      );
      assert.deepEqual(
        result.audit.openNonBlockerIds,
        ["G4", "G11", "G12"]
      );
    }
  );

  await check(
    "missing canonical coordinator verification blocks release",
    () => {
      const value =
        closeAllBlockers(matrix);
      value.canonicalCoordinator
        .publicApiVerified = false;
      const result =
        buildV01ReleaseGapClosureAudit(
          value
        );
      assert.equal(
        result.decision,
        "v01_release_gap_audit_blocked"
      );
      assert.equal(
        result.audit
          .canonicalCoordinatorVerified,
        false
      );
    }
  );

  await check(
    "missing required artifact blocks release",
    () => {
      const value =
        closeAllBlockers(matrix);
      value.requiredArtifacts[0] = {
        artifactId:
          value.requiredArtifacts[0]
            .artifactId,
        status: "missing"
      };
      const result =
        buildV01ReleaseGapClosureAudit(
          value
        );
      assert.equal(
        result.decision,
        "v01_release_gap_audit_blocked"
      );
      assert.deepEqual(
        result.audit.missingArtifactIds,
        ["readme_quickstart"]
      );
    }
  );

  await check(
    "current audit verifies and tampered audit fails",
    () => {
      const built =
        buildV01ReleaseGapClosureAudit(
          matrix
        );
      const current =
        verifyV01ReleaseGapClosureAudit(
          matrix,
          built.audit
        );
      assert.equal(
        current.decision,
        "v01_release_gap_audit_current",
        JSON.stringify(current)
      );
      const tampered =
        clone(built.audit);
      tampered.releaseReady =
        !tampered.releaseReady;
      const invalid =
        verifyV01ReleaseGapClosureAudit(
          matrix,
          tampered
        );
      assert.equal(
        invalid.decision,
        "v01_release_gap_audit_invalid"
      );
    }
  );

  await check(
    "cyclic and accessor inputs fail closed without writes",
    () => {
      const cyclic = clone(matrix);
      cyclic.self = cyclic;
      const cyclicResult =
        buildV01ReleaseGapClosureAudit(
          cyclic
        );
      assert.equal(
        cyclicResult.decision,
        "v01_release_gap_audit_invalid"
      );

      const accessor = clone(matrix);
      Object.defineProperty(
        accessor,
        "observedReleaseCommand",
        {
          enumerable: true,
          get() {
            throw new Error(
              "accessor must not execute"
            );
          }
        }
      );
      const accessorResult =
        buildV01ReleaseGapClosureAudit(
          accessor
        );
      assert.equal(
        accessorResult.decision,
        "v01_release_gap_audit_invalid"
      );
      assert.equal(
        accessorResult.summary
          .repositoryWritePerformed,
        false
      );
    }
  );

  await check(
    "audit module performs no filesystem shell network or Git write",
    () => {
      const source = fs.readFileSync(
        path.resolve(
          "packages/product-runtime/src/release-gap-closure-audit.ts"
        ),
        "utf8"
      );
      assert.equal(
        /node:fs|node:child_process|fetch\s*\(|https?:\/\/|execFile|execSync|shell\s*:\s*true|git\s+(?:add|commit|push|update-ref)/i
          .test(source),
        false
      );
    }
  );

  console.log(
    `release gap closure audit smoke passed (${checks} checks)`
  );
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
