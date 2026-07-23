#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  execFileSync
} = require("node:child_process");

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "AF2B Fixture",
  GIT_AUTHOR_EMAIL: "af2b@example.invalid",
  GIT_COMMITTER_NAME: "AF2B Fixture",
  GIT_COMMITTER_EMAIL: "af2b@example.invalid"
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

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(
    path.dirname(target),
    { recursive: true }
  );
  fs.writeFileSync(target, content);
}

function observedChanges(root, metadata) {
  const lines = git(
    root,
    [
      "diff",
      "--numstat",
      "--no-renames",
      "--"
    ]
  )
    .trim()
    .split("\n")
    .filter(Boolean);

  return lines.map((line) => {
    const [added, deleted, filePath] =
      line.split("\t");
    const annotation =
      metadata[filePath];
    if (!annotation) {
      throw new Error(
        `missing observation metadata: ${filePath}`
      );
    }
    return {
      filePath,
      linesAdded: Number(added),
      linesDeleted: Number(deleted),
      ...annotation
    };
  });
}

async function main() {
  const runtime = await import(
    "../dist/packages/product-runtime/src/index.js"
  );
  const {
    bindObservedSoftScopePrBody,
    buildObservedSoftScopeReleaseReport,
    hashCanonicalJson,
    verifyObservedSoftScopePrBody,
    verifyObservedSoftScopeReleaseReport
  } = runtime;

  const roots = [];
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

  function fixture(mode = "review") {
    const root = fs.realpathSync(
      fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          "af2b-observed-"
        )
      )
    );
    roots.push(root);
    git(root, ["init", "--quiet"]);
    git(root, ["branch", "-m", "main"]);

    write(
      root,
      "src/service.ts",
      "export const value = 1;\n"
    );
    write(
      root,
      "src/helper.ts",
      "export const helper = 1;\n"
    );
    write(
      root,
      "package-lock.json",
      "{}\n"
    );
    git(root, ["add", "--", "."]);
    git(
      root,
      [
        "commit",
        "--quiet",
        "-m",
        "baseline"
      ]
    );

    write(
      root,
      "src/service.ts",
      [
        "export const value = 2;",
        "export const enabled = true;",
        ""
      ].join("\n")
    );

    const metadata = {
      "src/service.ts": {
        changeKind: "bugfix",
        necessity: "required",
        humanReview: "necessary"
      }
    };

    if (mode === "review") {
      write(
        root,
        "src/helper.ts",
        [
          "export const helper = 1;",
          "export const unusedWrapper = () => helper;",
          ""
        ].join("\n")
      );
      metadata["src/helper.ts"] = {
        changeKind: "refactor",
        necessity: "unnecessary",
        humanReview: "unnecessary"
      };
    }

    if (mode === "blocked") {
      write(
        root,
        "package-lock.json",
        '{"changed":true}\n'
      );
      metadata["package-lock.json"] = {
        changeKind: "dependency",
        necessity: "unnecessary",
        humanReview: "unnecessary"
      };
    }

    const input = {
      releaseBindingVersion: "1",
      runId: `af2b-${mode}`,
      strategy: "adaptive_bounded_context",
      sourceClass:
        "disposable_repository_observation",
      integratedReceiptHash:
        hash(`${mode}:integrated`),
      applyReceiptHash:
        hash(`${mode}:apply`),
      deliveryContractHash:
        hash(`${mode}:delivery`),
      expectedFiles: ["src/service.ts"],
      allowedFiles: [
        "src/helper.ts",
        "src/service.ts"
      ],
      forbiddenFiles: [
        "package-lock.json"
      ],
      requestedRefactor: false,
      actualChanges:
        observedChanges(root, metadata),
      newDependencies: [],
      newAbstractions: []
    };

    return { root, input };
  }

  await check(
    "real disposable Git diff builds release-eligible observed report",
    () => {
      const { input } = fixture("review");
      const result =
        buildObservedSoftScopeReleaseReport(
          input
        );
      assert.equal(
        result.decision,
        "observed_soft_scope_release_ready",
        JSON.stringify(result)
      );
      assert.equal(
        result.report.evidenceClass,
        "observed_run"
      );
      assert.equal(
        result.report.releaseClaimEligible,
        true
      );
      assert.equal(
        result.report.sourceClass,
        "disposable_repository_observation"
      );
    }
  );

  await check(
    "allowed unnecessary real diff produces soft review without hard violation",
    () => {
      const { input } = fixture("review");
      const result =
        buildObservedSoftScopeReleaseReport(
          input
        );
      const observed =
        result.report.benchmarkReport
          .caseResults[0];
      assert.equal(
        observed.decision,
        "soft_scope_review"
      );
      assert.equal(
        observed.metrics.hardViolationCount,
        0
      );
      assert.deepEqual(
        observed.metrics
          .unexpectedButAllowedFiles,
        ["src/helper.ts"]
      );
      assert.ok(
        observed.metrics.unnecessaryLoc > 0
      );
    }
  );

  await check(
    "clean real diff remains scope clean",
    () => {
      const { input } = fixture("clean");
      const result =
        buildObservedSoftScopeReleaseReport(
          input
        );
      assert.equal(
        result.report.benchmarkReport
          .caseResults[0].decision,
        "scope_clean"
      );
    }
  );

  await check(
    "forbidden real diff remains a hard block",
    () => {
      const { input } = fixture("blocked");
      const result =
        buildObservedSoftScopeReleaseReport(
          input
        );
      const observed =
        result.report.benchmarkReport
          .caseResults[0];
      assert.equal(
        observed.decision,
        "hard_scope_blocked"
      );
      assert.deepEqual(
        observed.metrics
          .forbiddenTouchedFiles,
        ["package-lock.json"]
      );
    }
  );

  await check(
    "observed report binds integrated apply and delivery receipt hashes",
    () => {
      const { input } = fixture("clean");
      const result =
        buildObservedSoftScopeReleaseReport(
          input
        );
      assert.equal(
        result.report.binding
          .integratedReceiptHash,
        input.integratedReceiptHash
      );
      assert.equal(
        result.report.binding
          .applyReceiptHash,
        input.applyReceiptHash
      );
      assert.equal(
        result.report.binding
          .deliveryContractHash,
        input.deliveryContractHash
      );
    }
  );

  await check(
    "draft PR body receives one canonical soft-scope summary",
    () => {
      const { input } = fixture("review");
      const result =
        buildObservedSoftScopeReleaseReport(
          input
        );
      const bound =
        bindObservedSoftScopePrBody(
          "## Summary\n\nObserved change.",
          result.report
        );
      assert.equal(
        bound.decision,
        "observed_soft_scope_pr_body_bound",
        JSON.stringify(bound)
      );
      assert.equal(
        verifyObservedSoftScopePrBody(
          bound.body,
          result.report
        ),
        true
      );
      assert.match(
        bound.body,
        /## Soft Scope Drift/
      );
      assert.match(
        bound.body,
        /Decision: `soft_scope_review`/
      );
    }
  );

  await check(
    "duplicate soft-scope PR section is rejected",
    () => {
      const { input } = fixture("clean");
      const result =
        buildObservedSoftScopeReleaseReport(
          input
        );
      const first =
        bindObservedSoftScopePrBody(
          "## Summary\n\nObserved change.",
          result.report
        );
      const second =
        bindObservedSoftScopePrBody(
          first.body,
          result.report
        );
      assert.equal(
        second.decision,
        "observed_soft_scope_pr_body_invalid"
      );
    }
  );

  await check(
    "report and PR summary are deterministic",
    () => {
      const { input } = fixture("review");
      const first =
        buildObservedSoftScopeReleaseReport(
          input
        );
      const reordered = clone(input);
      reordered.actualChanges.reverse();
      const second =
        buildObservedSoftScopeReleaseReport(
          reordered
        );
      assert.equal(
        first.report.reportHash,
        second.report.reportHash
      );
      assert.equal(
        first.report.prSummary.markdown,
        second.report.prSummary.markdown
      );
    }
  );

  await check(
    "observed report verifies current",
    () => {
      const { input } = fixture("clean");
      const built =
        buildObservedSoftScopeReleaseReport(
          input
        );
      const verified =
        verifyObservedSoftScopeReleaseReport(
          input,
          built.report
        );
      assert.equal(
        verified.decision,
        "observed_soft_scope_release_current",
        JSON.stringify(verified)
      );
      assert.equal(
        verified.releaseClaimEligible,
        true
      );
    }
  );

  await check(
    "tampered report or summary fails verification",
    () => {
      const { input } = fixture("clean");
      const built =
        buildObservedSoftScopeReleaseReport(
          input
        );
      const tampered = clone(built.report);
      tampered.prSummary.unnecessaryLoc = 99;
      const verified =
        verifyObservedSoftScopeReleaseReport(
          input,
          tampered
        );
      assert.equal(
        verified.decision,
        "observed_soft_scope_release_invalid"
      );
    }
  );

  await check(
    "receipt binding drift changes report hash",
    () => {
      const { input } = fixture("clean");
      const first =
        buildObservedSoftScopeReleaseReport(
          input
        );
      const changed = clone(input);
      changed.applyReceiptHash =
        hash("different-apply");
      const second =
        buildObservedSoftScopeReleaseReport(
          changed
        );
      assert.notEqual(
        first.report.reportHash,
        second.report.reportHash
      );
    }
  );

  await check(
    "invalid receipt hash fails closed",
    () => {
      const { input } = fixture("clean");
      input.applyReceiptHash = "not-a-hash";
      const result =
        buildObservedSoftScopeReleaseReport(
          input
        );
      assert.equal(
        result.decision,
        "observed_soft_scope_release_invalid"
      );
      assert.ok(
        result.errors.includes(
          "observed_soft_scope_hash_invalid"
        )
      );
    }
  );

  await check(
    "cyclic and accessor inputs fail closed",
    () => {
      const { input } = fixture("clean");
      const cyclic = clone(input);
      cyclic.self = cyclic;
      const cyclicResult =
        buildObservedSoftScopeReleaseReport(
          cyclic
        );
      assert.equal(
        cyclicResult.decision,
        "observed_soft_scope_release_invalid"
      );

      const accessor = clone(input);
      Object.defineProperty(
        accessor,
        "runId",
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
        buildObservedSoftScopeReleaseReport(
          accessor
        );
      assert.equal(
        accessorResult.decision,
        "observed_soft_scope_release_invalid"
      );
    }
  );

  await check(
    "core integration performs no filesystem shell network or Git writes",
    () => {
      const source = fs.readFileSync(
        path.resolve(
          "packages/product-runtime/src/observed-soft-scope-release.ts"
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
    `observed soft scope release smoke passed (${checks} checks)`
  );

  for (const root of roots.reverse()) {
    fs.rmSync(
      root,
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
