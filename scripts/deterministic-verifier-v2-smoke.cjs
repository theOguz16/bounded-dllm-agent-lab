#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const runtime = await import("../dist/packages/product-runtime/src/canonical-runtime.js");
  const {
    DETERMINISTIC_VERIFIER_V2_VERSION,
    VERIFIER_V2_RULES,
    verifyPatchDraftMutationV2: verify,
    hashCanonicalJson
  } = runtime;

  const roots = [];
  const checks = [];
  const check = async (name, fn) => {
    process.stdout.write(`[run] ${name}\n`);
    await fn();
    checks.push(name);
    process.stdout.write(`[ok] ${name}\n`);
  };
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verifier-v2-")));
  roots.push(root);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/service.ts"), "export const value = 1;\n");

  const contentHash = (content) => `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const sourceHashes = {
    "src/service.ts": contentHash("export const value = 1;\n"),
    "src/other.ts": contentHash("export const other = 1;\n")
  };
  const verifyPatchDraftMutationV2 = (input) => verify({
    boundContextFiles: Object.entries(sourceHashes).map(([path, contentHash]) => ({ path, contentHash })),
    ...input
  });
  const mutation = (file = "src/service.ts", patch = "export const value = 2;", confidence = 0.9) => ({
    role: "coder",
    target: "patchDraft",
    summary: "Update fixture.",
    claims: [{ type: "patch_draft", claimVersion: "text-file-update/v1", operation: "update", file, expectedContentHash: sourceHashes[file] ?? sourceHashes["src/service.ts"], description: "Update fixture.", newContent: patch }],
    touchedFiles: [file],
    confidence
  });

  try {
    await check("canonical runtime exports verifier v2 registry", async () => {
      assert.equal(DETERMINISTIC_VERIFIER_V2_VERSION, "deterministic-verifier/v2");
      assert.equal(VERIFIER_V2_RULES.allowlistViolation.id, "DV2_ALLOWLIST_VIOLATION");
      assert.equal(Object.isFrozen(VERIFIER_V2_RULES), true);
    });

    await check("valid allowlisted patch is approved without false positive", async () => {
      const policyHash = hashCanonicalJson({ policy: "verifier-binding" });
      const result = await verifyPatchDraftMutationV2({
        repositoryPath: root,
        mutation: mutation(),
        allowedFiles: ["src/service.ts"],
        forbiddenFiles: [],
        requireExistingTouchedFiles: true,
        policyHash
      });
      assert.equal(result.decision, "approve", JSON.stringify(result));
      assert.equal(result.ok, true);
      assert.deepEqual(result.canonicalTouchedFiles, ["src/service.ts"]);
      assert.equal(result.policyHash, policyHash);
      assert.equal(result.finding.claims[0].policyHash, policyHash);
    });

    await check("malformed policy hash is rejected and bound into the finding", async () => {
      const result = await verifyPatchDraftMutationV2({
        repositoryPath: root,
        mutation: mutation(),
        allowedFiles: ["src/service.ts"],
        policyHash: "caller-authority"
      });
      assert.equal(result.decision, "reject");
      assert(result.issues.some((entry) => entry.ruleId === "DV2_POLICY_BINDING_INVALID"));
      assert.equal(result.finding.claims[0].policyHash, "caller-authority");
    });

    for (const [name, patch] of [
      ["identical", "export const value = 2;"],
      ["conflicting", "export const value = 3;"]
    ]) {
      await check(`${name} claims for the same file are rejected`, async () => {
        const candidate = mutation();
        candidate.claims.push({ ...candidate.claims[0], newContent: patch });
        const result = await verifyPatchDraftMutationV2({
          repositoryPath: root,
          mutation: candidate,
          allowedFiles: ["src/service.ts"],
          requireExistingTouchedFiles: true
        });
        assert.equal(result.decision, "reject", JSON.stringify(result));
        assert.equal(result.ok, false);
        assert.deepEqual(result.issues.filter((entry) => entry.ruleId === "DV2_PATCH_CLAIM_DUPLICATE"), [{
          ruleId: "DV2_PATCH_CLAIM_DUPLICATE",
          severity: "error",
          disposition: "reject",
          message: "Only one patch_draft claim per canonical file is allowed.",
          field: "mutation.claims",
          file: "src/service.ts"
        }]);
        assert.deepEqual(result.finding.claims[0].issues, result.issues);
      });
    }

    await check("one claim per distinct allowlisted file is approved", async () => {
      fs.writeFileSync(path.join(root, "src/other.ts"), "export const other = 1;\n");
      const candidate = mutation();
      candidate.claims.push(...mutation("src/other.ts", "export const other = 2;").claims);
      candidate.touchedFiles.push("src/other.ts");
      const result = await verifyPatchDraftMutationV2({
        repositoryPath: root,
        mutation: candidate,
        allowedFiles: candidate.touchedFiles,
        requireExistingTouchedFiles: true
      });
      assert.equal(result.decision, "approve", JSON.stringify(result));
      assert.equal(result.ok, true);
      assert.deepEqual(result.issues, []);
      assert.deepEqual(result.canonicalClaimFiles, ["src/other.ts", "src/service.ts"]);
    });

    await check("empty allowlist rejects touched files", async () => {
      const result = await verifyPatchDraftMutationV2({
        repositoryPath: root,
        mutation: mutation(),
        allowedFiles: []
      });
      assert.equal(result.decision, "reject");
      assert(result.issues.some((entry) => entry.ruleId === "DV2_ALLOWLIST_VIOLATION"));
    });

    await check("path aliases and traversal fail closed", async () => {
      for (const file of ["./src/service.ts", "src/../src/service.ts", "../outside.ts", "src\\service.ts"]) {
        const result = await verifyPatchDraftMutationV2({
          repositoryPath: root,
          mutation: mutation(file),
          allowedFiles: ["src/service.ts"]
        });
        assert.equal(result.decision, "reject", `${file}: ${JSON.stringify(result)}`);
        assert(result.issues.some((entry) => entry.ruleId === "DV2_PATH_INVALID"));
      }
    });

    await check("symlink path fails closed", async () => {
      const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verifier-v2-outside-")));
      roots.push(outside);
      fs.writeFileSync(path.join(outside, "secret.ts"), "export const secret = true;\n");
      fs.symlinkSync(outside, path.join(root, "linked"), "dir");
      const result = await verifyPatchDraftMutationV2({
        repositoryPath: root,
        mutation: mutation("linked/secret.ts"),
        allowedFiles: ["linked/secret.ts"]
      });
      assert.equal(result.decision, "reject", JSON.stringify(result));
      assert(result.issues.some((entry) => entry.ruleId === "MUTATION_SYMLINK_UNSUPPORTED"));
    });

    await check("missing existing file requests review instead of approval", async () => {
      for (const file of ["src/new.ts", "absent/child.ts", "src/absent/deeper/child.ts"]) {
        const result = await verifyPatchDraftMutationV2({
          repositoryPath: root,
          mutation: mutation(file),
          allowedFiles: [file],
          requireExistingTouchedFiles: true
      });
      assert.equal(result.decision, "reject", JSON.stringify(result));
      assert.equal(result.ok, false);
      assert(result.issues.some((entry) => entry.ruleId === "MUTATION_CREATE_UNSUPPORTED"));
      }
    });

    await check("directory targets and non-directory ancestors are rejected", async () => {
      for (const file of ["src", "src/service.ts/child.ts"]) {
        for (const requireExistingTouchedFiles of [true, false]) {
          const result = await verifyPatchDraftMutationV2({
            repositoryPath: root,
            mutation: mutation(file),
            allowedFiles: [file],
            requireExistingTouchedFiles
          });
          assert.equal(result.decision, "reject", JSON.stringify(result));
          assert.equal(result.ok, false);
          assert(result.issues.some((entry) => entry.ruleId === "MUTATION_FILE_TYPE_UNSUPPORTED"));
        }
      }
    });

    await check("file and dangling symlink targets are rejected", async () => {
      fs.symlinkSync(path.join(root, "src/service.ts"), path.join(root, "file-link.ts"));
      fs.symlinkSync(path.join(root, "missing.ts"), path.join(root, "dangling-link.ts"));
      for (const file of ["file-link.ts", "dangling-link.ts"]) {
        const result = await verifyPatchDraftMutationV2({
          repositoryPath: root,
          mutation: mutation(file),
          allowedFiles: [file],
          requireExistingTouchedFiles: true
        });
        assert.equal(result.decision, "reject", JSON.stringify(result));
        assert(result.issues.some((entry) => entry.ruleId === "MUTATION_SYMLINK_UNSUPPORTED"));
      }
    });

    await check("create remains unsupported even when existence flag is false", async () => {
      for (const file of ["src/new.ts", "absent/child.ts"]) {
        const result = await verifyPatchDraftMutationV2({
          repositoryPath: root,
          mutation: mutation(file),
          allowedFiles: [file],
          requireExistingTouchedFiles: false
        });
        assert.equal(result.decision, "reject", JSON.stringify(result));
      }
    });

    await check("unsafe patch and forbidden file are rejected", async () => {
      const result = await verifyPatchDraftMutationV2({
        repositoryPath: root,
        mutation: mutation("src/service.ts", "console.log(process.env.SECRET);"),
        allowedFiles: ["src/service.ts"],
        forbiddenFiles: ["src/service.ts"]
      });
      assert.equal(result.decision, "reject");
      assert(result.issues.some((entry) => entry.ruleId === "DV2_UNSAFE_PATCH"));
      assert(result.issues.some((entry) => entry.ruleId === "DV2_FORBIDDEN_FILE"));
    });

    await check("low confidence is needs review not reject", async () => {
      const result = await verifyPatchDraftMutationV2({
        repositoryPath: root,
        mutation: mutation("src/service.ts", "export const value = 2;", 0.2),
        allowedFiles: ["src/service.ts"],
        minConfidence: 0.5
      });
      assert.equal(result.decision, "needs_review", JSON.stringify(result));
      assert(result.issues.some((entry) => entry.ruleId === "DV2_LOW_CONFIDENCE"));
    });

    await check("model hash alone cannot replace trusted bound context", async () => {
      const result = await verifyPatchDraftMutationV2({
        repositoryPath: root,
        mutation: mutation(),
        allowedFiles: ["src/service.ts"],
        boundContextFiles: []
      });
      assert.equal(result.decision, "needs_review");
      assert(result.issues.some((entry) => entry.ruleId === "MUTATION_SOURCE_HASH_MISMATCH"));
    });

    console.log(JSON.stringify({
      ok: true,
      decision: "deterministic_verifier_v2_reliability_ready",
      checkCount: checks.length,
      checks
    }, null, 2));
  } finally {
    for (const item of roots) fs.rmSync(item, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
