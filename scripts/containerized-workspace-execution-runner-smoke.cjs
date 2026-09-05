const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

(async () => {
  const runtime = await import("../dist/packages/product-runtime/src/index.js");
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
    const isolationScript = `
      const fs=require('fs');
      let readBlocked=false,writeBlocked=false,sourceBlocked=false;
      try{fs.readFileSync(${JSON.stringify(control)});}catch{readBlocked=true}
      try{fs.writeFileSync(${JSON.stringify(control)},'escape');}catch{writeBlocked=true}
      try{fs.writeFileSync('src/a.txt','tampered');}catch{sourceBlocked=true}
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
