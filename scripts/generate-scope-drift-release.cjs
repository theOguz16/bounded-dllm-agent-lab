#!/usr/bin/env node

const {
  createHash
} = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  execFileSync
} = require("node:child_process");

const root = fs.realpathSync(process.cwd());
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "AF2B Release Generator",
  GIT_AUTHOR_EMAIL:
    "af2b-release@example.invalid",
  GIT_COMMITTER_NAME:
    "AF2B Release Generator",
  GIT_COMMITTER_EMAIL:
    "af2b-release@example.invalid"
};

function git(cwd, args) {
  return execFileSync(
    "git",
    args,
    {
      cwd,
      env: gitEnv,
      encoding: "utf8"
    }
  );
}

function write(targetRoot, relative, content) {
  const target =
    path.join(targetRoot, relative);
  fs.mkdirSync(
    path.dirname(target),
    { recursive: true }
  );
  fs.writeFileSync(target, content);
}

function sha256Bytes(value) {
  return `sha256:${
    createHash("sha256")
      .update(value)
      .digest("hex")
  }`;
}

function sha256Parts(parts) {
  const digest = createHash("sha256");
  for (const part of parts) {
    digest.update(part);
  }
  return `sha256:${digest.digest("hex")}`;
}

async function main() {
  const runtime = await import(
    "../dist/packages/product-runtime/src/index.js"
  );

  const temporaryRoot =
    fs.realpathSync(
      fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          "af2b-release-observed-"
        )
      )
    );

  try {
    git(temporaryRoot, ["init", "--quiet"]);
    git(
      temporaryRoot,
      ["branch", "-m", "main"]
    );

    write(
      temporaryRoot,
      "src/service.ts",
      "export const value = 1;\n"
    );
    write(
      temporaryRoot,
      "test/service.test.ts",
      "export const expected = 1;\n"
    );
    git(
      temporaryRoot,
      ["add", "--", "."]
    );
    git(
      temporaryRoot,
      [
        "commit",
        "--quiet",
        "-m",
        "baseline"
      ]
    );

    write(
      temporaryRoot,
      "src/service.ts",
      [
        "export const value = 2;",
        "export const enabled = true;",
        ""
      ].join("\n")
    );
    write(
      temporaryRoot,
      "test/service.test.ts",
      [
        "export const expected = 2;",
        "export const verified = true;",
        ""
      ].join("\n")
    );

    const metadata = {
      "src/service.ts": {
        changeKind: "bugfix",
        necessity: "required",
        humanReview: "necessary"
      },
      "test/service.test.ts": {
        changeKind: "test",
        necessity: "required",
        humanReview: "necessary"
      }
    };

    const actualChanges = git(
      temporaryRoot,
      [
        "diff",
        "--numstat",
        "--no-renames",
        "--"
      ]
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [
          added,
          deleted,
          filePath
        ] = line.split("\t");
        return {
          filePath,
          linesAdded: Number(added),
          linesDeleted: Number(deleted),
          ...metadata[filePath]
        };
      });

    const hash = (label) =>
      runtime.hashCanonicalJson({
        artifactType:
          "af2b_release_binding",
        label
      });

    const input = {
      releaseBindingVersion: "1",
      runId:
        "af2b-release-disposable-observed-v1",
      strategy:
        "adaptive_bounded_context",
      sourceClass:
        "disposable_repository_observation",
      integratedReceiptHash:
        hash("integrated"),
      applyReceiptHash:
        hash("apply"),
      deliveryContractHash:
        hash("delivery"),
      expectedFiles: [
        "src/service.ts",
        "test/service.test.ts"
      ],
      allowedFiles: [
        "src/service.ts",
        "test/service.test.ts"
      ],
      forbiddenFiles: [
        "package-lock.json"
      ],
      requestedRefactor: false,
      actualChanges,
      newDependencies: [],
      newAbstractions: []
    };

    const built =
      runtime
        .buildObservedSoftScopeReleaseReport(
          input
        );
    if (
      built.decision !==
        "observed_soft_scope_release_ready" ||
      built.report === null ||
      built.report.benchmarkReport
        .caseResults[0].decision !==
        "scope_clean"
    ) {
      throw new Error(
        "release scope report was not clean"
      );
    }

    const reportPath = path.join(
      root,
      "reports/release/SCOPE_DRIFT.json"
    );
    fs.mkdirSync(
      path.dirname(reportPath),
      { recursive: true }
    );
    fs.writeFileSync(
      reportPath,
      `${JSON.stringify(
        built.report,
        null,
        2
      )}\n`
    );

    const summary =
      built.report.prSummary;
    const documentation = [
      "# v0.1 Scope Drift Evidence",
      "",
      "This artifact records the AF.2b observed-run scope integration.",
      "",
      `- Evidence class: \`${built.report.evidenceClass}\``,
      `- Source class: \`${built.report.sourceClass}\``,
      `- Release-claim eligible: \`${built.report.releaseClaimEligible}\``,
      `- Decision: \`${summary.decision}\``,
      `- Hard violations: ${summary.hardViolationCount}`,
      `- Unexpected-but-allowed files: ${summary.unexpectedButAllowedFileCount}`,
      `- Missing expected files: ${summary.missingExpectedFileCount}`,
      `- Unnecessary LOC: ${summary.unnecessaryLoc}`,
      `- Report hash: \`${built.report.reportHash}\``,
      "",
      "The observation comes from an actual disposable Git repository diff.",
      "It validates scope-accounting semantics and PR-summary integration.",
      "It is not a claim about model quality, token savings, or production latency.",
      ""
    ].join("\n");
    const documentationPath =
      path.join(
        root,
        "docs/release/SCOPE_DRIFT.md"
      );
    fs.mkdirSync(
      path.dirname(documentationPath),
      { recursive: true }
    );
    fs.writeFileSync(
      documentationPath,
      documentation
    );

    const matrixPath =
      path.join(
        root,
        "docs/release/V0_1_GAP_CLOSURE_MATRIX.json"
      );
    const matrix =
      JSON.parse(
        fs.readFileSync(
          matrixPath,
          "utf8"
        )
      );

    const evidence = [
      {
        stage: "primitive",
        evidenceId: "g5.primitive",
        artifactKind: "module",
        locator:
          "packages/product-runtime/src/soft-scope-drift-benchmark.ts"
      },
      {
        stage: "contract_tests",
        evidenceId: "g5.contract_tests",
        artifactKind: "test",
        locator:
          "scripts/soft-scope-drift-benchmark-smoke.cjs"
      },
      {
        stage: "canonical_integration",
        evidenceId:
          "g5.canonical_integration",
        artifactKind: "integration",
        locator:
          "packages/product-runtime/src/observed-soft-scope-release.ts"
      },
      {
        stage: "live_or_real_evidence",
        evidenceId:
          "g5.live_or_real_evidence",
        artifactKind: "report",
        locator:
          "reports/release/SCOPE_DRIFT.json"
      },
      {
        stage: "release_artifact",
        evidenceId:
          "g5.release_artifact",
        artifactKind: "document",
        locator:
          "docs/release/SCOPE_DRIFT.md"
      }
    ].map((entry) => ({
      ...entry,
      evidenceHash:
        sha256Bytes(
          fs.readFileSync(
            path.join(root, entry.locator)
          )
        )
    }));

    const g5 =
      matrix.gaps.find(
        (gap) => gap.id === "G5"
      );
    g5.disposition = "closed";
    g5.evidence = evidence;
    delete g5.exclusion;

    const scopeArtifact =
      matrix.requiredArtifacts.find(
        (artifact) =>
          artifact.artifactId ===
            "scope_drift_report"
      );
    scopeArtifact.status = "present";
    scopeArtifact.artifactHash =
      sha256Bytes(
        fs.readFileSync(reportPath)
      );

    const indexPath =
      path.join(
        root,
        "packages/product-runtime/src/index.ts"
      );
    const indexBytes =
      fs.readFileSync(indexPath);
    const g13 =
      matrix.gaps.find(
        (gap) => gap.id === "G13"
      );
    for (
      const entry
      of g13.evidence
    ) {
      if (
        entry.locator ===
          "packages/product-runtime/src/index.ts"
      ) {
        entry.evidenceHash =
          sha256Bytes(indexBytes);
      }
    }

    const coordinator =
      matrix.canonicalCoordinator;
    const coordinatorBytes =
      fs.readFileSync(
        path.join(
          root,
          coordinator.modulePath
        )
      );
    coordinator.evidenceHash =
      sha256Parts([
        "canonical-coordinator\0",
        coordinator.exportName,
        "\0",
        coordinator.modulePath,
        "\0",
        sha256Bytes(
          coordinatorBytes
        ),
        "\0",
        sha256Bytes(indexBytes)
      ]);

    fs.writeFileSync(
      matrixPath,
      `${JSON.stringify(
        matrix,
        null,
        2
      )}\n`
    );

    console.log(
      "OK: observed SCOPE_DRIFT.json generated"
    );
    console.log(
      "OK: scope drift release document generated"
    );
    console.log(
      "OK: G5 five-stage evidence chain closed"
    );
    console.log(
      "OK: scope_drift_report artifact declared present"
    );
    console.log(
      "OK: repository-bound coordinator and G13 hashes refreshed"
    );
  } finally {
    fs.rmSync(
      temporaryRoot,
      {
        recursive: true,
        force: true
      }
    );
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
