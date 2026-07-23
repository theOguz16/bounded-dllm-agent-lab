#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function copyFile(root, targetRoot, relative) {
  const source = path.join(root, relative);
  const target = path.join(targetRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

async function main() {
  const runtime = await import(
    "../dist/packages/product-runtime/src/index.js"
  );
  const {
    REPOSITORY_VERIFY_RELEASE_COMMAND,
    V01_RELEASE_ARTIFACT_PATHS,
    runRepositoryReleaseEvidence,
    verifyRepositoryReleaseEvidenceReport
  } = runtime;

  const root = fs.realpathSync(process.cwd());
  const matrix = JSON.parse(
    fs.readFileSync(
      path.join(
        root,
        "docs/release/V0_1_GAP_CLOSURE_MATRIX.json"
      ),
      "utf8"
    )
  );

  const temporaryRoots = [];
  let checks = 0;
  const clone = (value) => structuredClone(value);
  const check = async (name, callback) => {
    console.log(`[run] ${name}`);
    await callback();
    checks += 1;
    console.log(`[ok] ${name}`);
  };

  function evidencePaths() {
    return [
      ...new Set(
        matrix.gaps.flatMap((gap) =>
          gap.evidence
            .filter(
              (evidence) =>
                evidence.artifactKind !== "command"
            )
            .map((evidence) => evidence.locator)
        )
      )
    ];
  }

  function fixture() {
    const target = fs.realpathSync(
      fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          "release-evidence-fixture-"
        )
      )
    );
    temporaryRoots.push(target);

    const required = new Set([
      "package.json",
      "packages/product-runtime/src/index.ts",
      matrix.canonicalCoordinator.modulePath,
      ...evidencePaths()
    ]);
    for (const relative of required) {
      copyFile(root, target, relative);
    }
    return target;
  }

  await check(
    "current repository evidence is valid but release blocked",
    async () => {
      const result = await runRepositoryReleaseEvidence({
        repositoryPath: root,
        matrix
      });
      assert.equal(
        result.decision,
        "repository_release_evidence_blocked",
        JSON.stringify(result)
      );
      assert.deepEqual(
        result.report.gapAudit.openBlockerIds,
        ["G5", "G8", "G13"]
      );
      assert.equal(result.report.releaseReady, false);
    }
  );

  await check(
    "release command coordinator and evidence hashes are verified",
    async () => {
      const result = await runRepositoryReleaseEvidence({
        repositoryPath: root,
        matrix
      });
      assert.equal(result.summary.releaseCommandVerified, true);
      assert.equal(
        result.summary.canonicalCoordinatorVerified,
        true
      );
      assert.equal(
        result.summary.evidenceLocatorCount,
        result.summary.evidenceMatchedCount
      );
      assert.ok(result.summary.evidenceLocatorCount > 20);
      assert.equal(
        matrix.observedReleaseCommand,
        "verify:release"
      );
    }
  );

  await check(
    "current report is deterministic and tamper evident",
    async () => {
      const first = await runRepositoryReleaseEvidence({
        repositoryPath: root,
        matrix
      });
      const second = await runRepositoryReleaseEvidence({
        repositoryPath: root,
        matrix
      });
      assert.equal(
        first.report.reportHash,
        second.report.reportHash
      );
      assert.equal(
        verifyRepositoryReleaseEvidenceReport(first.report),
        true
      );
      const tampered = clone(first.report);
      tampered.releaseReady = true;
      assert.equal(
        verifyRepositoryReleaseEvidenceReport(tampered),
        false
      );
    }
  );

  await check(
    "tampered evidence bytes fail closed",
    async () => {
      const target = fixture();
      const relative = evidencePaths()[0];
      fs.appendFileSync(
        path.join(target, relative),
        "\n// tampered\n"
      );
      const result = await runRepositoryReleaseEvidence({
        repositoryPath: target,
        matrix
      });
      assert.equal(
        result.decision,
        "repository_release_evidence_invalid"
      );
      assert.ok(
        result.errors.includes(
          "repository_release_evidence_hash_mismatch"
        )
      );
    }
  );

  await check(
    "missing evidence file fails closed",
    async () => {
      const target = fixture();
      fs.rmSync(path.join(target, evidencePaths()[0]));
      const result = await runRepositoryReleaseEvidence({
        repositoryPath: target,
        matrix
      });
      assert.equal(
        result.decision,
        "repository_release_evidence_invalid"
      );
      assert.ok(
        result.errors.includes(
          "repository_release_evidence_file_missing"
        )
      );
    }
  );

  await check(
    "symlinked evidence is never followed",
    async () => {
      const target = fixture();
      const relative = evidencePaths()[0];
      const absolute = path.join(target, relative);
      const external = path.join(target, "external.txt");
      fs.writeFileSync(external, "external");
      fs.rmSync(absolute);
      fs.symlinkSync(external, absolute);

      const result = await runRepositoryReleaseEvidence({
        repositoryPath: target,
        matrix
      });
      assert.equal(
        result.decision,
        "repository_release_evidence_invalid"
      );
      assert.ok(
        result.errors.includes(
          "repository_release_evidence_symlink_detected"
        )
      );
    }
  );

  await check(
    "verify release script drift is invalid",
    async () => {
      const target = fixture();
      const packagePath = path.join(target, "package.json");
      const packageJson = JSON.parse(
        fs.readFileSync(packagePath, "utf8")
      );
      packageJson.scripts["verify:release"] = "echo unsafe";
      fs.writeFileSync(
        packagePath,
        `${JSON.stringify(packageJson, null, 2)}\n`
      );

      const result = await runRepositoryReleaseEvidence({
        repositoryPath: target,
        matrix
      });
      assert.equal(
        result.decision,
        "repository_release_evidence_invalid"
      );
      assert.ok(
        result.errors.includes(
          "repository_release_evidence_release_command_mismatch"
        )
      );
      assert.notEqual(
        packageJson.scripts["verify:release"],
        REPOSITORY_VERIFY_RELEASE_COMMAND
      );
    }
  );

  await check(
    "canonical coordinator export drift is invalid",
    async () => {
      const target = fixture();
      const modulePath = path.join(
        target,
        matrix.canonicalCoordinator.modulePath
      );
      const source = fs.readFileSync(modulePath, "utf8");
      fs.writeFileSync(
        modulePath,
        source.replace(
          "export async function runIntegratedDisposableApply",
          "async function runIntegratedDisposableApply"
        )
      );

      const result = await runRepositoryReleaseEvidence({
        repositoryPath: target,
        matrix
      });
      assert.equal(
        result.decision,
        "repository_release_evidence_invalid"
      );
      assert.ok(
        result.errors.includes(
          "repository_release_evidence_coordinator_mismatch"
        )
      );
    }
  );

  await check(
    "undeclared release artifact appearance is invalid",
    async () => {
      const target = fixture();
      const artifactPath =
        V01_RELEASE_ARTIFACT_PATHS.readme_quickstart;
      const absolute = path.join(target, artifactPath);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, "quickstart\n");

      const result = await runRepositoryReleaseEvidence({
        repositoryPath: target,
        matrix
      });
      assert.equal(
        result.decision,
        "repository_release_evidence_invalid"
      );
      assert.ok(
        result.errors.includes(
          "repository_release_evidence_artifact_declaration_mismatch"
        )
      );
    }
  );

  await check(
    "tampered matrix evidence hash is invalid",
    async () => {
      const value = clone(matrix);
      value.gaps
        .find((gap) => gap.disposition === "closed")
        .evidence[0]
        .evidenceHash =
          "sha256:0000000000000000000000000000000000000000000000000000000000000000";

      const result = await runRepositoryReleaseEvidence({
        repositoryPath: root,
        matrix: value
      });
      assert.equal(
        result.decision,
        "repository_release_evidence_invalid"
      );
    }
  );

  await check(
    "byte bounds fail before unbounded inspection",
    async () => {
      const result = await runRepositoryReleaseEvidence({
        repositoryPath: root,
        matrix,
        maxFileBytes: 16,
        maxTotalBytes: 32
      });
      assert.equal(
        result.decision,
        "repository_release_evidence_invalid"
      );
      assert.ok(
        result.errors.includes(
          "repository_release_evidence_byte_limit"
        )
      );
    }
  );

  await check(
    "runner uses read-only filesystem and no shell network or Git write",
    async () => {
      const source = fs.readFileSync(
        path.resolve(
          "packages/product-runtime/src/repository-release-evidence-runner.ts"
        ),
        "utf8"
      );
      assert.equal(
        /node:child_process|fetch\s*\(|https?:\/\/|execFile|execSync|shell\s*:\s*true|writeFile|appendFile|rename\(|unlink\(|rm\(|mkdir\(|git\s+(?:add|commit|push|update-ref)/i
          .test(source),
        false
      );
      assert.match(source, /O_NOFOLLOW/);
      assert.match(
        source,
        /repository_release_evidence_blocked/
      );
    }
  );

  console.log(
    `repository release evidence runner smoke passed (${checks} checks)`
  );

  for (const target of temporaryRoots.reverse()) {
    fs.rmSync(
      target,
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
