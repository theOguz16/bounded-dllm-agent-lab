const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

(async () => {
  const runtime = await import("../dist/packages/product-runtime/src/index.js");
  const { computeTemporaryWorkspaceExecutionSpecificationHash } =
    await import("../dist/packages/product-runtime/src/temporary-workspace-execution-verifier.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "container-runner-"));
  const workspace = path.join(root, "workspace");
  const control = path.join(root, "host-control.txt");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.mkdirSync(path.join(workspace, ".validation-output"));
  fs.writeFileSync(path.join(workspace, "src/a.txt"), "candidate\n");
  fs.writeFileSync(control, "host-secret-control\n");
  const base = {
    tempWorkspacePath: workspace,
    tempApplyDecision: "temp_apply_ready",
    tempWorkspaceCleanedUp: false,
    allowedExecutables: ["node"],
    maxOutputChars: 20_000
  };
  let checks = 0;
  const assertNoContainers = () => {
    const leftovers = execFileSync("docker", ["ps", "--all", "--quiet", "--filter", "name=bounded-validation-"], { encoding: "utf8" }).trim();
    assert.equal(leftovers, "");
  };
  try {
    const boundSpecification = { commands: [{ id: "build", executable: "node", args: ["-v"],
      generatedOutputRoots: ["dist"] }], allowedExecutables: ["node"] };
    assert.notEqual(computeTemporaryWorkspaceExecutionSpecificationHash(boundSpecification),
      computeTemporaryWorkspaceExecutionSpecificationHash({ ...boundSpecification,
        commands: [{ ...boundSpecification.commands[0], generatedOutputRoots: ["build"] }] }));
    checks++;
    const isolationScript = `
      const fs=require('fs');
      let readBlocked=false,writeBlocked=false,sourceBlocked=false;
      try{fs.readFileSync(${JSON.stringify(control)});}catch{readBlocked=true}
      try{fs.writeFileSync(${JSON.stringify(control)},'escape');}catch{writeBlocked=true}
      try{fs.writeFileSync('/candidate-input/src/a.txt','tampered');}catch{sourceBlocked=true}
      fs.writeFileSync('.validation-output/report.txt','ok');
      if(!readBlocked||!writeBlocked||!sourceBlocked||process.env.SSH_AUTH_SOCK||process.env.USERPROFILE)process.exit(1);
    `;
    const isolation = await runtime.runContainerizedWorkspaceExecution({ ...base,
      commands: [{ id: "isolation", executable: "node", args: ["-e", isolationScript], timeoutMs: 10_000 }]
    }, async () => null);
    assert.equal(isolation.decision, "temp_validation_passed", JSON.stringify(isolation));
    assert.equal(fs.readFileSync(control, "utf8"), "host-secret-control\n");
    assert.equal(fs.readFileSync(path.join(workspace, "src/a.txt"), "utf8"), "candidate\n");
    assert.equal(fs.existsSync(path.join(workspace, ".validation-output/report.txt")), false);
    checks++;

    const changedCandidate = await runtime.runContainerizedWorkspaceExecution({ ...base,
      commands: [{ id: "candidate-input-tamper", executable: "node", timeoutMs: 10_000,
        args: ["-e", "require('fs').writeFileSync('src/a.txt','tampered')"] }]
    }, async () => null);
    assert.equal(changedCandidate.decision, "temp_validation_failed", JSON.stringify(changedCandidate));
    assert(changedCandidate.issues.some((entry) => entry.code === "validation_candidate_input_changed"));
    assert.equal(changedCandidate.commandResults[0].passed, false);
    assert.equal(fs.readFileSync(path.join(workspace, "src/a.txt"), "utf8"), "candidate\n");
    assertNoContainers();
    checks++;

    for (const directory of ["dist", "coverage"]) {
      fs.mkdirSync(path.join(workspace, directory));
      const existing = path.join(workspace, directory, "candidate.js");
      fs.writeFileSync(existing, "module.exports = 1;\n");
      const overwrite = await runtime.runContainerizedWorkspaceExecution({ ...base,
        commands: [{ id: `overwrite-${directory}`, executable: "node", timeoutMs: 10_000,
          generatedOutputRoots: [directory],
          args: ["-e", `require('fs').writeFileSync(${JSON.stringify(`${directory}/candidate.js`)},'module.exports = 2;')`] }]
      }, async () => null);
      assert.equal(overwrite.decision, "temp_validation_failed", JSON.stringify(overwrite));
      assert(overwrite.issues.some((entry) => entry.code === "validation_candidate_input_changed"));
      assert.equal(fs.readFileSync(existing, "utf8"), "module.exports = 1;\n");
      assertNoContainers();
      checks++;
    }

    const deletion = await runtime.runContainerizedWorkspaceExecution({ ...base,
      commands: [{ id: "delete-input", executable: "node", timeoutMs: 10_000,
        args: ["-e", "require('fs').unlinkSync('src/a.txt')"] }]
    }, async () => null);
    assert.equal(deletion.decision, "temp_validation_failed", JSON.stringify(deletion));
    assert(deletion.issues.some((entry) => entry.code === "validation_candidate_input_changed"));
    assert.equal(fs.readFileSync(path.join(workspace, "src/a.txt"), "utf8"), "candidate\n");
    checks++;

    const poisoning = await runtime.runContainerizedWorkspaceExecution({ ...base,
      commands: [
        { id: "poison-source", executable: "node", timeoutMs: 10_000,
          args: ["-e", "require('fs').writeFileSync('src/a.txt','poisoned')"] },
        { id: "consume-poison", executable: "node", timeoutMs: 10_000,
          args: ["-e", "if(require('fs').readFileSync('src/a.txt','utf8')==='poisoned')process.exit(0);process.exit(1)"] }
      ]
    }, async () => null);
    assert.equal(poisoning.decision, "temp_validation_failed", JSON.stringify(poisoning));
    assert.deepEqual(poisoning.commandResults.map((entry) => entry.id), ["poison-source"]);
    assert.equal(poisoning.commandResults[0].passed, false);
    assert.equal(fs.readFileSync(path.join(workspace, "src/a.txt"), "utf8"), "candidate\n");
    checks++;

    const escapeLink = path.join(workspace, "escape-link");
    fs.symlinkSync(control, escapeLink);
    const escape = await runtime.runContainerizedWorkspaceExecution({ ...base,
      commands: [{ id: "symlink-escape", executable: "node", timeoutMs: 10_000,
        args: ["-e", "require('fs').writeFileSync('escape-link','escaped')"] }]
    }, async () => null);
    assert.equal(escape.decision, "temp_validation_failed", JSON.stringify(escape));
    assert(escape.issues.some((entry) => entry.code === "validation_workspace_staging_failed"));
    assert.equal(fs.readFileSync(control, "utf8"), "host-secret-control\n");
    fs.unlinkSync(escapeLink);
    checks++;

    fs.rmdirSync(path.join(workspace, ".validation-output"));
    fs.symlinkSync("src", path.join(workspace, ".validation-output"));
    const aliasedOutput = await runtime.runContainerizedWorkspaceExecution({ ...base,
      commands: [{ id: "aliased-output-mount", executable: "node", timeoutMs: 10_000,
        args: ["-e", "require('fs').writeFileSync('.validation-output/a.txt','escaped')"] }]
    }, async () => null);
    assert.equal(aliasedOutput.decision, "temp_validation_failed", JSON.stringify(aliasedOutput));
    assert(aliasedOutput.issues.some((entry) => entry.code === "validation_workspace_staging_failed"));
    assert.equal(fs.readFileSync(path.join(workspace, "src/a.txt"), "utf8"), "candidate\n");
    fs.unlinkSync(path.join(workspace, ".validation-output"));
    fs.mkdirSync(path.join(workspace, ".validation-output"));
    checks++;

    const newOutput = await runtime.runContainerizedWorkspaceExecution({ ...base,
      commands: [
        { id: "create-output", executable: "node", timeoutMs: 10_000,
          generatedOutputRoots: ["dist"],
          args: ["-e", "require('fs').writeFileSync('dist/new-output.js','module.exports=3')"] },
        { id: "read-bound-output", executable: "node", timeoutMs: 10_000,
          args: ["-e", "if(require('./dist/new-output.js')!==3)process.exit(1)"] }
      ]
    }, async () => null);
    assert.equal(newOutput.decision, "temp_validation_passed", JSON.stringify(newOutput));
    assert.deepEqual(newOutput.commandResults.map((entry) => entry.id),
      ["create-output", "read-bound-output"]);
    assert.equal(fs.existsSync(path.join(workspace, "dist/new-output.js")), false);
    checks++;

    for (const [label, created] of [
      ["new-source", "src/poison.js"],
      ["new-config", "config/poison.json"],
      ["output-sibling", "dist-extra/poison.js"]
    ]) {
      const poisoned = await runtime.runContainerizedWorkspaceExecution({ ...base,
        commands: [
          { id: `create-${label}`, executable: "node", timeoutMs: 10_000,
            generatedOutputRoots: ["dist"],
            args: ["-e", `require('fs').mkdirSync(require('path').dirname(${JSON.stringify(created)}),{recursive:true});require('fs').writeFileSync(${JSON.stringify(created)},'poison')`] },
          { id: `consume-${label}`, executable: "node", timeoutMs: 10_000,
            args: ["-e", `if(!require('fs').existsSync(${JSON.stringify(created)}))process.exit(1)`] }
        ]
      }, async () => null);
      assert.equal(poisoned.decision, "temp_validation_failed", JSON.stringify(poisoned));
      assert(poisoned.issues.some((entry) => entry.code === "validation_generated_output_unauthorized"));
      assert.deepEqual(poisoned.commandResults.map((entry) => entry.id), [`create-${label}`]);
      assert.equal(fs.existsSync(path.join(workspace, created)), false);
      checks++;
    }

    const nestedOutput = await runtime.runContainerizedWorkspaceExecution({ ...base,
      commands: [
        { id: "create-nested-output", executable: "node", timeoutMs: 10_000,
          generatedOutputRoots: ["build/generated"],
          args: ["-e", "require('fs').mkdirSync('build/generated/deep',{recursive:true});require('fs').writeFileSync('build/generated/deep/result.js','module.exports=7')"] },
        { id: "consume-nested-output", executable: "node", timeoutMs: 10_000,
          args: ["-e", "if(require('./build/generated/deep/result.js')!==7)process.exit(1)"] }
      ]
    }, async () => null);
    assert.equal(nestedOutput.decision, "temp_validation_passed", JSON.stringify(nestedOutput));
    assert.equal(fs.existsSync(path.join(workspace, "build")), false);
    checks++;

    const producerBound = await runtime.runContainerizedWorkspaceExecution({ ...base,
      commands: [
        { id: "authorized-producer", executable: "node", timeoutMs: 10_000,
          generatedOutputRoots: ["dist"],
          args: ["-e", "require('fs').writeFileSync('dist/first.js','first')"] },
        { id: "unauthorized-producer", executable: "node", timeoutMs: 10_000,
          args: ["-e", "require('fs').writeFileSync('dist/second.js','second')"] }
      ]
    }, async () => null);
    assert.equal(producerBound.decision, "temp_validation_failed", JSON.stringify(producerBound));
    assert(producerBound.issues.some((entry) => entry.code === "validation_generated_output_unauthorized" &&
      entry.commandId === "unauthorized-producer"));
    checks++;

    const traversalRoot = await runtime.runContainerizedWorkspaceExecution({ ...base,
      commands: [{ id: "traversal-root", executable: "node", timeoutMs: 10_000,
        generatedOutputRoots: ["dist/../src"], args: ["-e", "process.exit(0)"] }]
    }, async () => null);
    assert.equal(traversalRoot.decision, "temp_validation_failed", JSON.stringify(traversalRoot));
    assert(traversalRoot.issues.some((entry) => entry.code === "validation_generated_output_authority_invalid"));
    assert.deepEqual(traversalRoot.commandResults, []);
    checks++;

    const unbound = await runtime.runContainerizedWorkspaceExecution({ ...base,
      commands: [{ id: "unbound-output", executable: "node", timeoutMs: 10_000,
        args: ["-e", "require('fs').writeFileSync('dist/unbound.js','unbound')"] }]
    }, async () => null);
    assert.equal(unbound.decision, "temp_validation_failed", JSON.stringify(unbound));
    assert(unbound.issues.some((entry) => entry.code === "validation_generated_output_unauthorized"));
    checks++;

    const network = await runtime.runContainerizedWorkspaceExecution({ ...base,
      commands: [{ id: "network", executable: "node", timeoutMs: 10_000, args: ["-e",
        "const net=require('net');const s=net.connect(53,'1.1.1.1',()=>process.exit(1));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(0),2000)"
      ] }]
    }, async () => null);
    assert.equal(network.decision, "temp_validation_passed", JSON.stringify(network));
    checks++;

    const timeout = await runtime.runContainerizedWorkspaceExecution({ ...base,
      commands: [{ id: "timeout", executable: "node", args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 500 }]
    }, async () => null);
    assert.equal(timeout.decision, "temp_validation_failed", JSON.stringify(timeout));
    assert.equal(timeout.commandResults[0].timedOut, true);
    assertNoContainers();
    checks++;

    const quota = await runtime.runContainerizedWorkspaceExecution({ ...base,
      commands: [{ id: "output-quota", executable: "node", timeoutMs: 10_000,
        args: ["-e", "require('fs').writeFileSync('.validation-output/quota.bin',Buffer.alloc(1024*1024))"] }]
    }, async () => null, { validationOutputBytes: 64 * 1024 });
    assert.equal(quota.decision, "temp_validation_failed", JSON.stringify(quota));
    assert.match(quota.commandResults[0].stderr, /ENOSPC/);
    const quotaFile = path.join(workspace, ".validation-output/quota.bin");
    if (fs.existsSync(quotaFile)) assert(fs.statSync(quotaFile).size <= 64 * 1024);
    assertNoContainers();
    checks++;

    const spawnFailure = await runtime.runContainerizedWorkspaceExecution({ ...base,
      commands: [{ id: "spawn-error", executable: "node", timeoutMs: 10_000,
        args: ["-e", "x".repeat(2 * 1024 * 1024)] }]
    }, async () => null);
    assert.equal(spawnFailure.decision, "temp_validation_failed", JSON.stringify(spawnFailure));
    assert(spawnFailure.issues.some((entry) => entry.code === "validation_container_launch_failed"));
    assertNoContainers();
    checks++;

    const overflow = await runtime.runContainerizedWorkspaceExecution({ ...base,
      maxOutputChars: 1,
      commands: [{ id: "overflow", executable: "node", timeoutMs: 10_000,
        args: ["-e", "process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000)"] }]
    }, async () => null);
    assert.equal(overflow.decision, "temp_validation_failed", JSON.stringify(overflow));
    assert(overflow.issues.some((entry) => entry.code === "validation_container_output_overflow"));
    assertNoContainers();
    checks++;

    const callbackFailure = await runtime.runContainerizedWorkspaceExecution({ ...base,
      commands: [{ id: "callback", executable: "node", args: ["-e", "process.exit(0)"], timeoutMs: 10_000 }]
    }, async () => { throw new Error("forced callback failure"); });
    assert.equal(callbackFailure.decision, "temp_validation_failed", JSON.stringify(callbackFailure));
    assert(callbackFailure.issues.some((entry) => entry.code === "validation_after_command_callback_failed"));
    assertNoContainers();
    checks++;

    const fakeBin = path.join(root, "fake-bin");
    const fakeLog = path.join(root, "fake-runtime.log");
    const fakeState = path.join(root, "fake-runtime-state.json");
    const fakeRuntime = path.join(fakeBin, "fake-container-runtime");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(fakeRuntime, `#!/usr/bin/env node
const fs=require('fs');
const args=process.argv.slice(2), id='a'.repeat(64), stateFile=${JSON.stringify(fakeState)};
fs.appendFileSync(${JSON.stringify(fakeLog)},JSON.stringify(args)+'\\n');
if(args[0]==='run'){
  const label=args[args.indexOf('--label')+1].split('=').slice(1).join('=');
  fs.writeFileSync(stateFile,JSON.stringify({label,image:args.at(-4)}));
  process.stdout.write(id+'\\n');process.exit(0);
}
if(args[0]==='ps'){if(fs.existsSync(stateFile))process.stdout.write(id+'\\n');process.exit(0)}
if(args[0]==='container'&&args[1]==='inspect'&&args.includes('--format')){
  const state=JSON.parse(fs.readFileSync(stateFile));
  process.stdout.write(JSON.stringify(id)+'|'+JSON.stringify(state.label)+'|'+JSON.stringify(state.image)+'\\n');
  process.exit(0);
}
if(args[0]==='rm')process.exit(1);
if(args[0]==='container'&&args[1]==='inspect')process.exit(0);
process.exit(0);
`);
    fs.chmodSync(fakeRuntime, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ""}`;
    try {
      const cleanupFailure = await runtime.runContainerizedWorkspaceExecution({ ...base,
        commands: [{ id: "cleanup-failure", executable: "node", args: ["-e", "process.exit(0)"], timeoutMs: 10_000 }]
      }, async () => null, { runtime: "fake-container-runtime" });
      assert.equal(cleanupFailure.decision, "temp_validation_failed", JSON.stringify(cleanupFailure));
      assert(cleanupFailure.issues.some((entry) => entry.code === "validation_container_cleanup_recovery_required"));
      const calls = fs.readFileSync(fakeLog, "utf8").trim().split("\n").map(JSON.parse);
      assert(calls.some((args) => args[0] === "run"));
      assert(calls.some((args) => args[0] === "kill"));
      assert(calls.some((args) => args[0] === "rm" && args[1] === "--force"));
      assert(calls.some((args) => args[0] === "container" && args[1] === "inspect"));
    } finally {
      process.env.PATH = originalPath;
    }
    checks++;

    const identity = runtime.createValidationContainerIdentity(`sha256:${"1".repeat(64)}`);
    fs.writeFileSync(fakeState, JSON.stringify({
      label: `sha256:${"2".repeat(64)}`,
      image: runtime.DEFAULT_VALIDATION_CONTAINER_IMAGE
    }));
    fs.writeFileSync(fakeLog, "");
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ""}`;
    try {
      const mismatch = runtime.recoverValidationContainer(identity,
        { runtime: "fake-container-runtime" });
      assert.equal(mismatch.decision, "validation_container_identity_mismatch");
      const calls = fs.readFileSync(fakeLog, "utf8").trim().split("\n")
        .filter(Boolean).map(JSON.parse);
      assert.equal(calls.some((args) => args[0] === "kill" || args[0] === "rm"), false);
      assert.equal(fs.existsSync(fakeState), true);
    } finally {
      process.env.PATH = originalPath;
    }
    checks++;

    const tampered = { ...identity, transactionBindingHash: `sha256:${"3".repeat(64)}` };
    assert.equal(runtime.verifyValidationContainerIdentity(tampered), false);
    assert.equal(runtime.recoverValidationContainer(tampered).decision,
      "validation_container_identity_mismatch");
    checks++;

    const daemonUnavailable = runtime.recoverValidationContainer(identity,
      { runtime: "missing-container-runtime" });
    assert.equal(daemonUnavailable.decision, "validation_container_recovery_required");
    checks++;

    let hostCallbackCalled = false;
    const unavailable = await runtime.runContainerizedWorkspaceExecution({ ...base,
      commands: [{ id: "never", executable: "node", args: ["-e", "process.exit(0)"] }]
    }, async () => { hostCallbackCalled = true; return null; }, { runtime: "missing-container-runtime" });
    assert.equal(unavailable.decision, "temp_validation_failed");
    assert(unavailable.issues.some((entry) => entry.code === "validation_container_runtime_unavailable"));
    assert.equal(hostCallbackCalled, false);
    checks++;
    console.log(`containerized workspace execution runner passed (${checks} checks)`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
