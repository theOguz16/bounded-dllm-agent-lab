const assert = require("node:assert/strict");
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
  "export * from './workspace-mutation.js';\nexport * from './patch-application-dry-run-gate.js';\n";

function repairDraft(overrides = {}) {
  return {
    role: "remask",
    target: "repairDraft",
    summary: "Repair a bounded patch draft.",
    claims: [
      {
        type: "repair_draft",
        file,
        description: "Export patch application dry-run gate.",
        proposedPatch: proposedContent,
        addressesIssueCodes: ["missing_export"]
      }
    ],
    touchedFiles: [file],
    confidence: 0.9,
    ...overrides
  };
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

(async () => {
  const gatePath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/patch-application-dry-run-gate.js`
  );
  const indexPath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/index.js`
  );
  const { dryRunPatchApplication } = await import(gatePath.href);
  const runtime = await import(indexPath.href);

  check("valid approved repairDraft produces ready_to_apply", () => {
    const result = dryRunPatchApplication(repairDraft(), verifierFinding(), context());

    assertDecision(result, "ready_to_apply");
    assert.equal(result.issues.length, 0);
  });

  check("non-remask mutation rejects", () => {
    assertDecision(
      dryRunPatchApplication(repairDraft({ role: "coder" }), verifierFinding(), context()),
      "reject",
      "not_remask_repair_draft"
    );
  });

  check("non-repairDraft target rejects", () => {
    assertDecision(
      dryRunPatchApplication(repairDraft({ target: "patchDraft" }), verifierFinding(), context()),
      "reject",
      "not_repair_draft_target"
    );
  });

  check("missing repair verifier approval rejects", () => {
    assertDecision(
      dryRunPatchApplication(
        repairDraft(),
        verifierFinding("approve", { claims: [] }),
        context()
      ),
      "reject",
      "missing_repair_verifier_approval"
    );
  });

  check("repair verifier needs_review rejects", () => {
    assertDecision(
      dryRunPatchApplication(repairDraft(), verifierFinding("needs_review"), context()),
      "reject",
      "repair_verifier_not_approved"
    );
  });

  check("empty repair claims needs_review", () => {
    assertDecision(
      dryRunPatchApplication(repairDraft({ claims: [] }), verifierFinding(), context()),
      "needs_review",
      "empty_repair_claims"
    );
  });

  check("missing repair_draft claim needs_review", () => {
    assertDecision(
      dryRunPatchApplication(repairDraft({ claims: [{ type: "note" }] }), verifierFinding(), context()),
      "needs_review",
      "missing_repair_draft_claim"
    );
  });

  check("missing file needs_review", () => {
    assertDecision(
      dryRunPatchApplication(
        repairDraft({
          claims: [
            {
              type: "repair_draft",
              description: "Export patch application dry-run gate.",
              proposedPatch: proposedContent,
              addressesIssueCodes: ["missing_export"]
            }
          ]
        }),
        verifierFinding(),
        context()
      ),
      "needs_review",
      "missing_repair_file"
    );
  });

  check("missing proposedPatch needs_review", () => {
    assertDecision(
      dryRunPatchApplication(
        repairDraft({
          claims: [
            {
              type: "repair_draft",
              file,
              description: "Export patch application dry-run gate.",
              addressesIssueCodes: ["missing_export"]
            }
          ]
        }),
        verifierFinding(),
        context()
      ),
      "needs_review",
      "missing_repair_proposed_patch"
    );
  });

  check("invalid proposedPatch needs_review", () => {
    assertDecision(
      dryRunPatchApplication(
        repairDraft({
          claims: [
            {
              type: "repair_draft",
              file,
              description: "Export patch application dry-run gate.",
              proposedPatch: { raw: proposedContent },
              addressesIssueCodes: ["missing_export"]
            }
          ]
        }),
        verifierFinding(),
        context()
      ),
      "needs_review",
      "invalid_repair_proposed_patch"
    );
  });

  check("missing original file content needs_review", () => {
    assertDecision(
      dryRunPatchApplication(repairDraft(), verifierFinding(), context({ fileContents: {} })),
      "needs_review",
      "missing_original_file_content"
    );
  });

  check("repair claim outside touchedFiles needs_review", () => {
    assertDecision(
      dryRunPatchApplication(
        repairDraft({ touchedFiles: ["packages/product-runtime/src/workspace-mutation.ts"] }),
        verifierFinding(),
        context()
      ),
      "needs_review",
      "repair_claim_outside_touched_files"
    );
  });

  check("touched file without repair claim needs_review", () => {
    assertDecision(
      dryRunPatchApplication(
        repairDraft({ touchedFiles: [file, "packages/product-runtime/src/workspace-mutation.ts"] }),
        verifierFinding(),
        context()
      ),
      "needs_review",
      "touched_file_without_repair_claim"
    );
  });

  check("allowedFiles scope violation needs_review", () => {
    assertDecision(
      dryRunPatchApplication(
        repairDraft(),
        verifierFinding(),
        context({ allowedFiles: ["packages/product-runtime/src/workspace-mutation.ts"] })
      ),
      "needs_review",
      "scope_violation"
    );
  });

  check("forbidden file touch rejects", () => {
    assertDecision(
      dryRunPatchApplication(
        repairDraft(),
        verifierFinding(),
        context({ forbiddenFiles: [file] })
      ),
      "reject",
      "forbidden_file_touch"
    );
  });

  check("unsafe proposedPatch rejects", () => {
    assertDecision(
      dryRunPatchApplication(
        repairDraft({
          claims: [
            {
              type: "repair_draft",
              file,
              description: "Read an environment secret.",
              proposedPatch: "const token = process.env.TOKEN;",
              addressesIssueCodes: ["unsafe_patch_content"]
            }
          ]
        }),
        verifierFinding(),
        context()
      ),
      "reject",
      "unsafe_repair_patch_content"
    );
  });

  check("proposedPatch too large needs_review", () => {
    assertDecision(
      dryRunPatchApplication(
        repairDraft(),
        verifierFinding(),
        context({ maxProposedPatchChars: 10 })
      ),
      "needs_review",
      "proposed_patch_too_large"
    );
  });

  check("no-op patch needs_review", () => {
    assertDecision(
      dryRunPatchApplication(
        repairDraft({
          claims: [
            {
              type: "repair_draft",
              file,
              description: "No-op replacement.",
              proposedPatch: originalContent,
              addressesIssueCodes: ["missing_export"]
            }
          ]
        }),
        verifierFinding(),
        context()
      ),
      "needs_review",
      "no_op_patch"
    );
  });

  check("preview includes file", () => {
    const result = dryRunPatchApplication(repairDraft(), verifierFinding(), context());

    assert.equal(result.previews[0].file, file);
  });

  check("preview includes diff markers", () => {
    const result = dryRunPatchApplication(repairDraft(), verifierFinding(), context());

    assert.ok(result.previews[0].diffPreview.includes(`--- ${file}`));
    assert.ok(result.previews[0].diffPreview.includes(`+++ ${file}`));
    assert.ok(result.previews[0].diffPreview.includes("+ export * from './patch-application-dry-run-gate.js';"));
  });

  check("summary counts changed file", () => {
    const result = dryRunPatchApplication(repairDraft(), verifierFinding(), context());

    assert.equal(result.summary.totalFiles, 1);
    assert.equal(result.summary.changedFiles, 1);
    assert.equal(result.summary.unchangedFiles, 0);
    assert.ok(result.summary.totalAddedLines > 0);
  });

  check("runtime index exports patch application dry-run gate", () => {
    assert.equal(runtime.dryRunPatchApplication, dryRunPatchApplication);
  });

  console.log("patch application dry-run gate smoke passed");
})();
