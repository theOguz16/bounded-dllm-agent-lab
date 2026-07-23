#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const runtime = await import(
    "../dist/packages/product-runtime/src/runtime-generation-boundary.js"
  );
  const {
    buildRuntimeGenerationBoundaryReport,
    verifyRuntimeGenerationBoundaryReport
  } = runtime;

  const packageManifest = JSON.parse(
    fs.readFileSync(
      path.resolve(
        "packages/product-runtime/package.json"
      ),
      "utf8"
    )
  );
  const canonicalEntrypointSource =
    fs.readFileSync(
      path.resolve(
        "packages/product-runtime/src/canonical-runtime.ts"
      ),
      "utf8"
    );
  const legacyEntrypointSource =
    fs.readFileSync(
      path.resolve(
        "packages/product-runtime/src/index.ts"
      ),
      "utf8"
    );

  const input = {
    packageManifest,
    canonicalEntrypointSource,
    legacyEntrypointSource,
    evidenceClass: "observed_run",
    observationSource:
      "repository_source_scan"
  };

  let checks = 0;
  const check = async (name, callback) => {
    console.log(`[run] ${name}`);
    await callback();
    checks += 1;
    console.log(`[ok] ${name}`);
  };

  await check(
    "package root exposes only the canonical runtime entrypoint",
    () => {
      const report =
        buildRuntimeGenerationBoundaryReport(input);
      assert.equal(
        report.decision,
        "runtime_generation_boundary_ready",
        JSON.stringify(report)
      );
      assert.equal(
        report.releaseClaimEligible,
        true
      );
      assert.equal(
        verifyRuntimeGenerationBoundaryReport(report),
        true
      );
      assert.deepEqual(
        Object.keys(packageManifest.exports),
        ["."]
      );
    }
  );

  await check(
    "research subpath export makes the boundary ineligible",
    () => {
      const value = structuredClone(input);
      value.packageManifest.exports[
        "./research"
      ] = "./src/index.ts";
      const report =
        buildRuntimeGenerationBoundaryReport(value);
      assert.equal(
        report.decision,
        "runtime_generation_boundary_blocked"
      );
      assert.equal(
        report.releaseClaimEligible,
        false
      );
    }
  );

  await check(
    "legacy mock symbol in canonical entrypoint is rejected",
    () => {
      const report =
        buildRuntimeGenerationBoundaryReport({
          ...input,
          canonicalEntrypointSource:
            `${canonicalEntrypointSource}\nexport const createMockOrchestrationFlowDefinition = true;\n`
        });
      assert.equal(
        report.decision,
        "runtime_generation_boundary_blocked"
      );
      assert.equal(
        report.checks
          .canonicalLegacySymbolsAbsent,
        false
      );
    }
  );

  await check(
    "missing research-only marker is rejected",
    () => {
      const report =
        buildRuntimeGenerationBoundaryReport({
          ...input,
          legacyEntrypointSource:
            legacyEntrypointSource.replaceAll(
              "RESEARCH_ONLY_COMPATIBILITY_ENTRYPOINT",
              "REMOVED_RESEARCH_MARKER"
            )
        });
      assert.equal(
        report.decision,
        "runtime_generation_boundary_blocked"
      );
      assert.equal(
        report.checks
          .legacyResearchMarkerPresent,
        false
      );
    }
  );

  await check(
    "fixture scan never becomes release evidence",
    () => {
      const report =
        buildRuntimeGenerationBoundaryReport({
          ...input,
          evidenceClass:
            "deterministic_fixture",
          observationSource:
            "fixture_source_scan"
        });
      assert.equal(
        report.decision,
        "runtime_generation_boundary_ready"
      );
      assert.equal(
        report.releaseClaimEligible,
        false
      );
      assert.equal(
        verifyRuntimeGenerationBoundaryReport(report),
        true
      );
    }
  );

  await check(
    "tampered report hash is rejected",
    () => {
      const report =
        buildRuntimeGenerationBoundaryReport(input);
      const tampered =
        structuredClone(report);
      tampered.releaseClaimEligible = false;
      assert.equal(
        verifyRuntimeGenerationBoundaryReport(
          tampered
        ),
        false
      );
    }
  );

  await check(
    "boundary primitive has no filesystem shell network or Git write",
    () => {
      const source = fs.readFileSync(
        path.resolve(
          "packages/product-runtime/src/runtime-generation-boundary.ts"
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
    `runtime generation boundary smoke passed (${checks} checks)`
  );
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
