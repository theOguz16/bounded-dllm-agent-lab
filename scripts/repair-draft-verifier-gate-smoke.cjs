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

function repairDraft(overrides = {}) {
  return {
    role: "remask",
    target: "repairDraft",
    summary: "Repair a bounded patch draft.",
    claims: [
      {
        type: "repair_draft",
        file: "packages/product-runtime/src/index.ts",
        description: "Export repairDraft verifier gate.",
        proposedPatch: "export * from './repair-draft-verifier-gate.js';",
        addressesIssueCodes: ["missing_export"]
      }
    ],
    touchedFiles: ["packages/product-runtime/src/index.ts"],
    confidence: 0.9,
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
    `${process.cwd()}/dist/packages/product-runtime/src/repair-draft-verifier-gate.js`
  );
  const indexPath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/index.js`
  );
  const contractPath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/workspace-mutation.js`
  );
  const { verifyRepairDraftMutation } = await import(gatePath.href);
  const runtime = await import(indexPath.href);
  const { validateWorkspaceMutationContract } = await import(contractPath.href);

  check("valid repairDraft is approved", () => {
    const result = verifyRepairDraftMutation(repairDraft());

    assertDecision(result, "approve");
    assert.equal(result.issues.length, 0);
  });

  check("non-remask mutation is rejected", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft({ role: "coder" })),
      "reject",
      "not_remask_repair_draft"
    );
  });

  check("non-repairDraft target is rejected", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft({ target: "patchDraft" })),
      "reject",
      "not_repair_draft_target"
    );
  });

  check("empty claims needs_review", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft({ claims: [] })),
      "needs_review",
      "empty_repair_claims"
    );
  });

  check("missing repair_draft claim needs_review", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft({ claims: [{ type: "note" }] })),
      "needs_review",
      "missing_repair_draft_claim"
    );
  });

  check("missing file needs_review", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft({
        claims: [
          {
            type: "repair_draft",
            description: "Export repairDraft verifier gate.",
            proposedPatch: "export * from './repair-draft-verifier-gate.js';",
            addressesIssueCodes: ["missing_export"]
          }
        ]
      })),
      "needs_review",
      "missing_repair_file"
    );
  });

  check("missing description needs_review", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft({
        claims: [
          {
            type: "repair_draft",
            file: "packages/product-runtime/src/index.ts",
            proposedPatch: "export * from './repair-draft-verifier-gate.js';",
            addressesIssueCodes: ["missing_export"]
          }
        ]
      })),
      "needs_review",
      "missing_repair_description"
    );
  });

  check("missing proposedPatch needs_review", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft({
        claims: [
          {
            type: "repair_draft",
            file: "packages/product-runtime/src/index.ts",
            description: "Export repairDraft verifier gate.",
            addressesIssueCodes: ["missing_export"]
          }
        ]
      })),
      "needs_review",
      "missing_repair_proposed_patch"
    );
  });

  check("missing addressesIssueCodes needs_review", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft({
        claims: [
          {
            type: "repair_draft",
            file: "packages/product-runtime/src/index.ts",
            description: "Export repairDraft verifier gate.",
            proposedPatch: "export * from './repair-draft-verifier-gate.js';"
          }
        ]
      })),
      "needs_review",
      "missing_addressed_issue_codes"
    );
  });

  check("invalid addressesIssueCodes needs_review", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft({
        claims: [
          {
            type: "repair_draft",
            file: "packages/product-runtime/src/index.ts",
            description: "Export repairDraft verifier gate.",
            proposedPatch: "export * from './repair-draft-verifier-gate.js';",
            addressesIssueCodes: "missing_export"
          }
        ]
      })),
      "needs_review",
      "invalid_addressed_issue_codes"
    );
  });

  check("empty addressesIssueCodes needs_review", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft({
        claims: [
          {
            type: "repair_draft",
            file: "packages/product-runtime/src/index.ts",
            description: "Export repairDraft verifier gate.",
            proposedPatch: "export * from './repair-draft-verifier-gate.js';",
            addressesIssueCodes: []
          }
        ]
      })),
      "needs_review",
      "empty_addressed_issue_codes"
    );
  });

  check("repair claim outside touchedFiles needs_review", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft({
        touchedFiles: ["packages/product-runtime/src/repair-draft-verifier-gate.ts"]
      })),
      "needs_review",
      "repair_claim_outside_touched_files"
    );
  });

  check("touched file without repair claim needs_review", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft({
        touchedFiles: [
          "packages/product-runtime/src/index.ts",
          "packages/product-runtime/src/repair-draft-verifier-gate.ts"
        ]
      })),
      "needs_review",
      "touched_file_without_repair_claim"
    );
  });

  check("forbidden file touch is rejected", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft(), {
        forbiddenFiles: ["packages/product-runtime/src/index.ts"]
      }),
      "reject",
      "forbidden_file_touch"
    );
  });

  check("allowedFiles scope violation needs_review", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft(), {
        allowedFiles: ["packages/product-runtime/src/repair-draft-verifier-gate.ts"]
      }),
      "needs_review",
      "scope_violation"
    );
  });

  check("unsafe proposedPatch is rejected", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft({
        claims: [
          {
            type: "repair_draft",
            file: "packages/product-runtime/src/index.ts",
            description: "Read an environment secret.",
            proposedPatch: "const token = process.env.TOKEN;",
            addressesIssueCodes: ["unsafe_patch_content"]
          }
        ]
      })),
      "reject",
      "unsafe_repair_patch_content"
    );
  });

  check("required issue code not addressed needs_review", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft(), {
        requiredIssueCodes: ["missing_proposed_patch"]
      }),
      "needs_review",
      "required_issue_code_not_addressed"
    );
  });

  check("low confidence needs_review", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft({ confidence: 0.49 })),
      "needs_review",
      "low_confidence"
    );
  });

  check("generated finding has role verifier", () => {
    assert.equal(verifyRepairDraftMutation(repairDraft()).finding.role, "verifier");
  });

  check("generated finding has target verifierFinding", () => {
    assert.equal(verifyRepairDraftMutation(repairDraft()).finding.target, "verifierFinding");
  });

  check("generated finding passes WorkspaceMutation contract validation", () => {
    const result = verifyRepairDraftMutation(repairDraft());
    assert.deepEqual(validateWorkspaceMutationContract(result.finding), { ok: true, errors: [] });
  });

  check("runtime index exports repairDraft verifier gate", () => {
    assert.equal(runtime.verifyRepairDraftMutation, verifyRepairDraftMutation);
  });

  console.log("repairDraft verifier gate smoke passed");
})();
