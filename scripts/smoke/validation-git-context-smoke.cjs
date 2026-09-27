#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

(async () => {
  const runtime = await import("../../dist/packages/product-runtime/src/containerized-workspace-execution-runner.js");
  const { computeTemporaryWorkspaceExecutionSpecificationHash } = await import(
    "../../dist/packages/product-runtime/src/temporary-workspace-execution-verifier.js");
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "validation-git-context-smoke-"));
  const candidate = path.join(parent, "candidate");
  fs.mkdirSync(path.join(candidate, "src"), { recursive: true });
  fs.mkdirSync(path.join(candidate, ".validation-output"));
  fs.writeFileSync(path.join(candidate, "src/value.txt"), "candidate\n");
  const environment = { image: runtime.GIT_VALIDATION_CONTAINER_IMAGE,
    gitContext: "candidate-baseline/v1" };
  const base = { tempWorkspacePath: candidate, tempApplyDecision: "temp_apply_ready",
    tempWorkspaceCleanedUp: false, allowedExecutables: ["node"], validationEnvironment: environment };
  const run = (commands) => runtime.runContainerizedWorkspaceExecution({ ...base, commands }, async () => null);
  try {
    assert.notEqual(computeTemporaryWorkspaceExecutionSpecificationHash({
      commands: [], allowedExecutables: ["node"], validationEnvironment: environment
    }), computeTemporaryWorkspaceExecutionSpecificationHash({
      commands: [], allowedExecutables: ["node"]
    }));
    const probe = [
      "const assert=require('node:assert/strict'),fs=require('node:fs'),cp=require('node:child_process');",
      "const git=(...args)=>cp.execFileSync('git',args,{encoding:'utf8'}).trim();",
      "assert.equal(git('status','--porcelain'),'');",
      "assert.equal(git('rev-parse','--show-toplevel'),'/workspace');",
      "assert.match(git('rev-parse','HEAD'),/^[0-9a-f]{40}$/);",
      "assert.equal(git('remote','-v'),'');",
      "assert.equal(fs.existsSync('/workspace/.git'),false);",
      "assert.equal(fs.existsSync('/candidate-input/.git'),false);",
      "assert.equal(process.env.HOME,'/nonexistent');",
      "assert.equal(process.env.GIT_DIR,'/validation-git/.git');",
      "assert.equal(process.env.SSH_AUTH_SOCK,undefined);",
      "assert.equal(process.env.GIT_CONFIG_NOSYSTEM,'1');",
      "assert.equal(git('config','--global','--list'),'');",
      "assert.throws(()=>fs.writeFileSync('/validation-git/.git/HEAD','poison'));",
      "assert.throws(()=>git('config','--local','core.editor','poison'));",
      "console.log('git-context-PASS');"
    ].join("\n");
    const valid = await run([
      { id: "git-context", executable: "node", args: ["-e", probe], timeoutMs: 30_000 },
      { id: "fresh-context", executable: "node", args: ["-e",
        "const c=require('node:child_process');if(c.execFileSync('git',['status','--porcelain'],{encoding:'utf8'})!=='')process.exit(1)"] }
    ]);
    assert.equal(valid.decision, "temp_validation_passed", JSON.stringify(valid));
    assert.deepEqual(valid.commandResults.map((entry) => entry.passed), [true, true]);

    const generated = await run([
      { id: "generate", executable: "node", generatedOutputRoots: ["generated"], args: ["-e",
        "const f=require('node:fs');f.mkdirSync('generated');f.writeFileSync('generated/value.txt','derived')"] },
      { id: "bound-generated-input", executable: "node", args: ["-e",
        "const f=require('node:fs'),c=require('node:child_process');if(f.readFileSync('generated/value.txt','utf8')!=='derived'||c.execFileSync('git',['status','--porcelain'],{encoding:'utf8'})!=='')process.exit(1)"] }
    ]);
    assert.equal(generated.decision, "temp_validation_passed", JSON.stringify(generated));
    assert.equal(fs.existsSync(path.join(candidate, "generated")), false);

    const copiedToAuthorizedOutput = await run([
      { id: "copy-synthetic-head", executable: "node", generatedOutputRoots: ["dist"], args: ["-e",
        "const f=require('node:fs');f.mkdirSync('dist');f.copyFileSync('/validation-git/.git/HEAD','dist/git-head.txt')"] },
      { id: "read-authorized-output", executable: "node", args: ["-e",
        "const f=require('node:fs');if(!f.readFileSync('dist/git-head.txt','utf8').trim())process.exit(1)"] }
    ]);
    assert.equal(copiedToAuthorizedOutput.decision, "temp_validation_passed",
      JSON.stringify(copiedToAuthorizedOutput));
    assert.equal(fs.existsSync(path.join(candidate, "dist")), false);

    const tamper = await run([{ id: "git-metadata-write", executable: "node", args: ["-e",
      "require('node:fs').writeFileSync('/validation-git/.git/index','poison')"] },
    { id: "must-not-run", executable: "node", args: ["-e", "process.exit(0)"] }]);
    assert.equal(tamper.decision, "temp_validation_failed");
    assert.deepEqual(tamper.commandResults.map((entry) => entry.id), ["git-metadata-write"]);
    const copiedMetadata = await run([{ id: "copy-git-metadata", executable: "node", args: ["-e",
      "const f=require('node:fs');f.copyFileSync('/validation-git/.git/HEAD','src/copied-head')"] }]);
    assert.equal(copiedMetadata.decision, "temp_validation_failed");
    assert(copiedMetadata.issues.some((entry) => entry.code === "validation_generated_output_unauthorized"));
    assert.equal(fs.existsSync(path.join(candidate, "src/copied-head")), false);
    const nestedMetadata = await run([{ id: "nested-git-metadata", executable: "node",
      generatedOutputRoots: ["dist"], args: ["-e",
        "const f=require('node:fs');f.mkdirSync('dist/.git',{recursive:true});f.copyFileSync('/validation-git/.git/HEAD','dist/.git/HEAD')"] }]);
    assert.equal(nestedMetadata.decision, "temp_validation_failed");
    assert(nestedMetadata.issues.some((entry) => entry.code === "validation_generated_output_unauthorized"));
    assert.equal(fs.existsSync(path.join(candidate, "dist")), false);

    const hostileConfig = await runtime.runContainerizedWorkspaceExecution({ ...base,
      environment: { GIT_DIR: "/workspace" },
      commands: [{ id: "hostile-config", executable: "node", args: ["-v"] }] }, async () => null);
    assert.equal(hostileConfig.decision, "temp_validation_failed");
    assert(hostileConfig.issues.some((entry) => entry.code === "validation_container_environment_invalid"));
    assert.equal(fs.existsSync(path.join(candidate, ".git")), false);
    assert.equal(fs.readFileSync(path.join(candidate, "src/value.txt"), "utf8"), "candidate\n");

    const mismatch = await runtime.runContainerizedWorkspaceExecution({ ...base,
      commands: [{ id: "invalid-image", executable: "node", args: ["-v"] }] },
    async () => null, { image: runtime.DEFAULT_VALIDATION_CONTAINER_IMAGE });
    assert.equal(mismatch.decision, "temp_validation_failed");
    assert.equal(mismatch.issues[0].code, "validation_container_configuration_invalid");
    console.log("validation-git-context-smoke: PASS");
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
