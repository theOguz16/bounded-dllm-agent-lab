#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const {
    buildRuntimeGenerationBoundaryReport,
    verifyRuntimeGenerationBoundaryReport
  } = await import(
    "../dist/packages/product-runtime/src/runtime-generation-boundary.js"
  );

  const root = fs.realpathSync(process.cwd());
  const packageManifest = JSON.parse(
    fs.readFileSync(
      path.join(
        root,
        "packages/product-runtime/package.json"
      ),
      "utf8"
    )
  );
  const canonicalEntrypointSource =
    fs.readFileSync(
      path.join(
        root,
        "packages/product-runtime/src/canonical-runtime.ts"
      ),
      "utf8"
    );
  const legacyEntrypointSource =
    fs.readFileSync(
      path.join(
        root,
        "packages/product-runtime/src/index.ts"
      ),
      "utf8"
    );

  const report =
    buildRuntimeGenerationBoundaryReport({
      packageManifest,
      canonicalEntrypointSource,
      legacyEntrypointSource,
      evidenceClass: "observed_run",
      observationSource:
        "repository_source_scan"
    });

  if (
    report.decision !==
      "runtime_generation_boundary_ready" ||
    report.releaseClaimEligible !== true ||
    !verifyRuntimeGenerationBoundaryReport(report)
  ) {
    throw new Error(
      `Runtime generation boundary is not release eligible: ${JSON.stringify(report)}`
    );
  }

  const target = path.join(
    root,
    "reports/release/RUNTIME_GENERATION_BOUNDARY.json"
  );
  fs.mkdirSync(
    path.dirname(target),
    { recursive: true }
  );
  fs.writeFileSync(
    target,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
  );

  console.log(JSON.stringify({
    decision: report.decision,
    releaseClaimEligible:
      report.releaseClaimEligible,
    canonicalEntrypoint:
      report.canonicalEntrypoint,
    legacyEntrypoint:
      report.legacyEntrypoint,
    reportHash: report.reportHash,
    outputPath:
      "reports/release/RUNTIME_GENERATION_BOUNDARY.json"
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
