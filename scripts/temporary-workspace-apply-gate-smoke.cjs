const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

function check(name, fn) {
  try {
    fn();
    console.log(`[ok] ${name}`);
  } catch (error) {
    console.error(`[fail] ${name}`);
    throw error;
  }
}

const file = "packages/product-runtime/src/index.ts";
const originalContent = "export * from './workspace-mutation.js';\n";
const proposedContent =
  "export * from './workspace-mutation.js';\nexport * from './temporary-workspace-apply-gate.js';\n";

function repairDraft(overrides = {}) {
  return {
    role: "remask",
    target: "repairDraft",
    summary: "Repair a bounded patch draft.",
    claims: [
      {
        claimVersion: "text-file-update/v1",
        type: "repair_draft",
        operation: "update",
        file,
        description: "Export temporary workspace apply gate.",
        expectedContentHash: `sha256:${createHash("sha256").update(originalContent).digest("hex")}`,
        newContent: proposedContent
      }
    ],
    touchedFiles: [file],
    confidence: 0.9,
    ...overrides
  };
}

function repairDraftWithClaim(claim, overrides = {}) {
  const normalizedClaim = claim.type === "repair_draft" ? {
    claimVersion: "text-file-update/v1",
    type: "repair_draft",
    operation: "update",
    description: "Update the bounded fixture.",
    expectedContentHash: `sha256:${createHash("sha256").update(originalContent).digest("hex")}`,
    newContent: proposedContent,
    ...claim
  } : claim;
  return repairDraft({
    claims: [normalizedClaim],
    touchedFiles: typeof normalizedClaim.file === "string" ? [normalizedClaim.file] : [],
    ...overrides
  });
}

function verifierFinding(decision = "approve", overrides = {}) {
  return {
    role: "verifier",
    target: "verifierFinding",
    summary: `Deterministic repairDraft verifier returned ${decision}.`,
    claims: [
      {
        type: "deterministic_repair_draft_verifier_finding",
        decision,
        issues: []
      }
    ],
    touchedFiles: [file],
    confidence: 1,
    ...overrides
  };
}

function patchDryRunResult(overrides = {}) {
  return {
    decision: "ready_to_apply",
    issues: [],
    previews: [
      {
        file,
        originalContent,
        proposedContent,
        changed: true,
        addedLines: 1,
        removedLines: 1,
        diffPreview: ""
      }
    ],
    summary: {
      totalFiles: 1,
      changedFiles: 1,
      unchangedFiles: 0,
      totalAddedLines: 1,
      totalRemovedLines: 1
    },
    ...overrides
  };
}

function context(overrides = {}) {
  return {
    fileContents: {
      [file]: originalContent
    },
    ...overrides
  };
}

function assertDecision(result, decision, code) {
  assert.equal(result.decision, decision);

  if (code) {
    assert.ok(result.issues.some((issue) => issue.code === code), JSON.stringify(result.issues));
  }
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "temporary-workspace-apply-smoke-"));
}

function removeIfExists(targetPath) {
  if (targetPath) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
}

(async () => {
  const gatePath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/temporary-workspace-apply-gate.js`
  );
  const indexPath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/index.js`
  );
  const { applyToTemporaryWorkspace } = await import(gatePath.href);
  const runtime = await import(indexPath.href);

  check("valid ready patch applies to temp workspace and returns temp_apply_ready", () => {
    const root = tempRoot();
    try {
      const result = applyToTemporaryWorkspace(
        repairDraft(),
        verifierFinding(),
        patchDryRunResult(),
        context({ tempRoot: root, cleanup: false })
      );

      assertDecision(result, "temp_apply_ready");
      assert.equal(result.issues.length, 0);
      assert.equal(result.appliedFiles.length, 1);
      assert.ok(result.tempWorkspacePath);
      assert.equal(
        fs.readFileSync(path.join(result.tempWorkspacePath, file), "utf8"),
        proposedContent
      );
    } finally {
      removeIfExists(root);
    }
  });

  check("cleanup true removes temp workspace", () => {
    const root = tempRoot();
    try {
      const result = applyToTemporaryWorkspace(
        repairDraft(),
        verifierFinding(),
        patchDryRunResult(),
        context({ tempRoot: root, cleanup: true })
      );

      assertDecision(result, "temp_apply_ready");
      assert.ok(result.tempWorkspacePath);
      assert.equal(fs.existsSync(result.tempWorkspacePath), false);
      assert.equal(result.summary.cleanedUp, true);
    } finally {
      removeIfExists(root);
    }
  });

  check("cleanup false keeps temp workspace", () => {
    const root = tempRoot();
    try {
      const result = applyToTemporaryWorkspace(
        repairDraft(),
        verifierFinding(),
        patchDryRunResult(),
        context({ tempRoot: root, cleanup: false })
      );

      assertDecision(result, "temp_apply_ready");
      assert.ok(result.tempWorkspacePath);
      assert.equal(fs.existsSync(result.tempWorkspacePath), true);
      assert.equal(result.summary.cleanedUp, false);
    } finally {
      removeIfExists(root);
    }
  });

  check("non-remask mutation rejects", () => {
    assertDecision(
      applyToTemporaryWorkspace(
        repairDraft({ role: "coder" }),
        verifierFinding(),
        patchDryRunResult(),
        context()
      ),
      "temp_apply_rejected",
      "MUTATION_SCHEMA_INVALID"
    );
  });

  check("non-repairDraft target rejects", () => {
    assertDecision(
      applyToTemporaryWorkspace(
        repairDraft({ target: "patchDraft" }),
        verifierFinding(),
        patchDryRunResult(),
        context()
      ),
      "temp_apply_rejected",
      "MUTATION_SCHEMA_INVALID"
    );
  });

  check("repair verifier not approved rejects", () => {
    assertDecision(
      applyToTemporaryWorkspace(
        repairDraft(),
        verifierFinding("needs_review"),
        patchDryRunResult(),
        context()
      ),
      "temp_apply_rejected",
      "repair_verifier_not_approved"
    );
  });

  check("patch dry-run not ready rejects", () => {
    assertDecision(
      applyToTemporaryWorkspace(
        repairDraft(),
        verifierFinding(),
        patchDryRunResult({ decision: "needs_review" }),
        context()
      ),
      "temp_apply_rejected",
      "patch_dry_run_not_ready"
    );
  });

  check("missing repair_draft claim needs_review", () => {
    assertDecision(
      applyToTemporaryWorkspace(
        repairDraft({ claims: [{ type: "note" }] }),
        verifierFinding(),
        patchDryRunResult(),
        context()
      ),
      "temp_apply_rejected",
      "MUTATION_SCHEMA_INVALID"
    );
  });

  check("unsafe absolute file path rejects", () => {
    const unsafeFile = path.join(os.tmpdir(), "absolute.ts");

    assertDecision(
      applyToTemporaryWorkspace(
        repairDraftWithClaim({
          type: "repair_draft",
          file: unsafeFile,
          newContent: proposedContent
        }),
        verifierFinding(),
        patchDryRunResult({ previews: [{ ...patchDryRunResult().previews[0], file: unsafeFile }] }),
        context({ fileContents: { [unsafeFile]: originalContent } })
      ),
      "temp_apply_rejected",
      "MUTATION_SCHEMA_INVALID"
    );
  });

  check("unsafe parent traversal rejects", () => {
    const unsafeFile = "packages/product-runtime/../escape.ts";

    assertDecision(
      applyToTemporaryWorkspace(
        repairDraftWithClaim({
          type: "repair_draft",
          file: unsafeFile,
          newContent: proposedContent
        }),
        verifierFinding(),
        patchDryRunResult({ previews: [{ ...patchDryRunResult().previews[0], file: unsafeFile }] }),
        context({ fileContents: { [unsafeFile]: originalContent } })
      ),
      "temp_apply_rejected",
      "MUTATION_SCHEMA_INVALID"
    );
  });

  check(".git path rejects", () => {
    const unsafeFile = ".git/config";

    assertDecision(
      applyToTemporaryWorkspace(
        repairDraftWithClaim({
          type: "repair_draft",
          file: unsafeFile,
          newContent: proposedContent
        }),
        verifierFinding(),
        patchDryRunResult({ previews: [{ ...patchDryRunResult().previews[0], file: unsafeFile }] }),
        context({ fileContents: { [unsafeFile]: originalContent } })
      ),
      "temp_apply_rejected",
      "unsafe_file_path"
    );
  });

  check("backslash path rejects", () => {
    const unsafeFile = "packages\\product-runtime\\src\\index.ts";

    assertDecision(
      applyToTemporaryWorkspace(
        repairDraftWithClaim({
          type: "repair_draft",
          file: unsafeFile,
          newContent: proposedContent
        }),
        verifierFinding(),
        patchDryRunResult({ previews: [{ ...patchDryRunResult().previews[0], file: unsafeFile }] }),
        context({ fileContents: { [unsafeFile]: originalContent } })
      ),
      "temp_apply_rejected",
      "MUTATION_SCHEMA_INVALID"
    );
  });

  check("allowedFiles scope violation needs_review", () => {
    assertDecision(
      applyToTemporaryWorkspace(
        repairDraft(),
        verifierFinding(),
        patchDryRunResult(),
        context({ allowedFiles: ["packages/product-runtime/src/workspace-mutation.ts"] })
      ),
      "temp_apply_needs_review",
      "scope_violation"
    );
  });

  check("forbidden file touch rejects", () => {
    assertDecision(
      applyToTemporaryWorkspace(
        repairDraft(),
        verifierFinding(),
        patchDryRunResult(),
        context({ forbiddenFiles: [file] })
      ),
      "temp_apply_rejected",
      "forbidden_file_touch"
    );
  });

  check("missing original file content needs_review", () => {
    assertDecision(
      applyToTemporaryWorkspace(
        repairDraft(),
        verifierFinding(),
        patchDryRunResult(),
        context({ fileContents: {} })
      ),
      "temp_apply_rejected",
      "MUTATION_CREATE_UNSUPPORTED"
    );
  });

  check("too many files needs_review", () => {
    const claims = Array.from({ length: 33 }, (_, index) => ({
      claimVersion: "text-file-update/v1",
      type: "repair_draft",
      operation: "update",
      file: `packages/product-runtime/src/file-${index}.ts`,
      description: "Update generated fixture.",
      expectedContentHash: `sha256:${createHash("sha256").update("export const value = 0;\n").digest("hex")}`,
      newContent: `export const value${index} = ${index};\n`
    }));
    const fileContents = Object.fromEntries(
      claims.map((claim) => [claim.file, `export const value = 0;\n`])
    );

    assertDecision(
      applyToTemporaryWorkspace(
        repairDraft({ claims, touchedFiles: claims.map((claim) => claim.file) }),
        verifierFinding(),
        patchDryRunResult({
          previews: claims.map((claim) => ({
            file: claim.file,
            originalContent: fileContents[claim.file],
            proposedContent: claim.newContent,
            changed: true,
            addedLines: 1,
            removedLines: 1,
            diffPreview: ""
          }))
        }),
        context({ fileContents })
      ),
      "temp_apply_rejected",
      "MUTATION_FILE_COUNT_EXCEEDED"
    );
  });

  check("proposedPatch too large needs_review", () => {
    assertDecision(
      applyToTemporaryWorkspace(
        repairDraft({
          claims: [
            {
              type: "repair_draft",
              file,
              claimVersion: "text-file-update/v1", operation: "update",
              description: "Update bounded fixture.",
              expectedContentHash: `sha256:${createHash("sha256").update(originalContent).digest("hex")}`,
              newContent: "x".repeat(8)
            }
          ]
        }),
        verifierFinding(),
        patchDryRunResult(),
        context({ maxFileBytes: 4 })
      ),
      "temp_apply_needs_review",
      "proposed_patch_too_large"
    );
  });

  check("no-op patch needs_review", () => {
    assertDecision(
      applyToTemporaryWorkspace(
        repairDraft({
          claims: [
            {
              type: "repair_draft",
              file,
              claimVersion: "text-file-update/v1", operation: "update",
              description: "No-op replacement.",
              expectedContentHash: `sha256:${createHash("sha256").update(originalContent).digest("hex")}`,
              newContent: originalContent
            }
          ]
        }),
        verifierFinding(),
        patchDryRunResult(),
        context()
      ),
      "temp_apply_needs_review",
      "MUTATION_NO_CHANGE"
    );
  });

  check("temp workspace escape attempt rejects", () => {
    const unsafeFile = "../escape.ts";

    assertDecision(
      applyToTemporaryWorkspace(
        repairDraftWithClaim({
          type: "repair_draft",
          file: unsafeFile,
          newContent: proposedContent
        }),
        verifierFinding(),
        patchDryRunResult({ previews: [{ ...patchDryRunResult().previews[0], file: unsafeFile }] }),
        context({ fileContents: { [unsafeFile]: originalContent } })
      ),
      "temp_apply_rejected",
      "MUTATION_SCHEMA_INVALID"
    );
  });

  check("applied file includes diff preview", () => {
    const root = tempRoot();
    try {
      const result = applyToTemporaryWorkspace(
        repairDraft(),
        verifierFinding(),
        patchDryRunResult(),
        context({ tempRoot: root, cleanup: false })
      );

      assertDecision(result, "temp_apply_ready");
      assert.ok(result.appliedFiles[0].diffPreview.includes(`--- ${file}`));
      assert.ok(result.appliedFiles[0].diffPreview.includes(`+++ ${file}`));
      assert.ok(result.appliedFiles[0].diffPreview.includes("+ export * from './temporary-workspace-apply-gate.js';"));
    } finally {
      removeIfExists(root);
    }
  });

  check("applied file changed true", () => {
    const root = tempRoot();
    try {
      const result = applyToTemporaryWorkspace(
        repairDraft(),
        verifierFinding(),
        patchDryRunResult(),
        context({ tempRoot: root, cleanup: false })
      );

      assertDecision(result, "temp_apply_ready");
      assert.equal(result.appliedFiles[0].changed, true);
    } finally {
      removeIfExists(root);
    }
  });

  check("summary counts changed files", () => {
    const result = applyToTemporaryWorkspace(
      repairDraft(),
      verifierFinding(),
      patchDryRunResult(),
      context()
    );

    assertDecision(result, "temp_apply_ready");
    assert.equal(result.summary.totalFiles, 1);
    assert.equal(result.summary.changedFiles, 1);
    assert.equal(result.summary.unchangedFiles, 0);
    assert.equal(result.summary.totalAddedLines, 2);
    assert.equal(result.summary.totalRemovedLines, 1);
  });

  check("context.fileContents is not mutated", () => {
    const fileContents = { [file]: originalContent };

    const result = applyToTemporaryWorkspace(
      repairDraft(),
      verifierFinding(),
      patchDryRunResult(),
      context({ fileContents })
    );

    assertDecision(result, "temp_apply_ready");
    assert.deepEqual(fileContents, { [file]: originalContent });
  });

  check("runtime index exports temporary workspace apply gate", () => {
    assert.equal(typeof runtime.applyToTemporaryWorkspace, "function");
  });

  console.log("temporary workspace apply gate smoke passed");
})();
