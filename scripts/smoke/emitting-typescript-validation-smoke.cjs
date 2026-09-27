#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

(async () => {
  const runtime = await import("../../dist/packages/product-runtime/src/canonical-runtime.js");
  assert(runtime.DEFAULT_VALIDATION_CONTAINER_LIMITS.memoryBytes >= 1024 * 1024 * 1024);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-emitting-ts-"));
  const workspace = path.join(parent, "candidate");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "test"));
  fs.mkdirSync(path.join(workspace, ".validation-output"));
  fs.mkdirSync(path.join(workspace, "node_modules"));
  fs.cpSync(path.resolve("node_modules/typescript"), path.join(workspace, "node_modules/typescript"),
    { recursive: true });
  fs.mkdirSync(path.join(workspace, "node_modules/.bin"));
  fs.symlinkSync("../typescript/bin/tsc", path.join(workspace, "node_modules/.bin/tsc"));
  const sourceFile = path.join(workspace, "src/index.ts");
  const source = "export const value: number = 3;\n";
  fs.writeFileSync(sourceFile, source);
  fs.writeFileSync(path.join(workspace, "tsconfig.json"), JSON.stringify({
    compilerOptions: { outDir: "dist", module: "commonjs", target: "es2022" },
    include: ["src/**/*.ts"]
  }));
  fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ scripts: {
    build: "tsc -p tsconfig.json",
    typecheck: "tsc -p tsconfig.json --noEmit",
    test: "node --test test/*.test.cjs"
  } }));
  fs.writeFileSync(path.join(workspace, "test/value.test.cjs"),
    "const assert=require('node:assert/strict');" +
    "const test=require('node:test');" +
    "test('emitted candidate',()=>assert.equal(require('../dist/index.js').value,3));\n");
  const { validationSpecification } = await import("../../dist/apps/cli/src/commands/codex.js");
  const detected = { packageJson: { detected: true }, scripts: {
    build: ["build"], typecheck: ["typecheck"], test: ["test"]
  } };
  assert.deepEqual(validationSpecification(detected, workspace).commands[0].generatedOutputRoots,
    ["dist"]);
  fs.writeFileSync(path.join(workspace, "tsconfig.json"), JSON.stringify({
    compilerOptions: { outDir: "../outside", module: "commonjs", target: "es2022" },
    include: ["src/**/*.ts"]
  }));
  assert.deepEqual(validationSpecification(detected, workspace).commands[0].generatedOutputRoots,
    [], "output roots outside the candidate must not be authorized");
  fs.writeFileSync(path.join(workspace, "tsconfig.json"), JSON.stringify({
    compilerOptions: { outDir: "dist", module: "commonjs", target: "es2022" },
    include: ["src/**/*.ts"]
  }));
  const commands = [
    { id: "validation.syntax", checkKind: "syntax", executable: "npm", args: ["run", "build"],
      generatedOutputRoots: ["dist"] },
    { id: "validation.typecheck", checkKind: "typecheck", executable: "npm", args: ["run", "typecheck"] },
    { id: "validation.test", checkKind: "behavior_test", executable: "npm", args: ["run", "test"] }
  ].map((entry) => ({ ...entry, timeoutMs: 30_000, expectedExitCodes: [0] }));
  const run = () => runtime.runContainerizedWorkspaceExecution({
    tempWorkspacePath: workspace, tempApplyDecision: "temp_apply_ready",
    tempWorkspaceCleanedUp: false, commands, allowedExecutables: ["npm"],
    maxCommands: 3, defaultTimeoutMs: 30_000, maxTimeoutMs: 30_000,
    maxOutputChars: 20_000
  }, async () => null);
  const stagedPrefix = "bounded-validation-execution-";
  const stagedBefore = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(stagedPrefix)));
  try {
    const valid = await run();
    assert.equal(valid.decision, "temp_validation_passed", JSON.stringify(valid));
    assert.deepEqual(valid.commandResults.map((entry) => [entry.id, entry.passed]),
      commands.map((entry) => [entry.id, true]));
    assert.equal(fs.readFileSync(sourceFile, "utf8"), source);
    assert.equal(fs.existsSync(path.join(workspace, "dist")), false);
    assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(stagedPrefix) &&
      !stagedBefore.has(name)), []);

    fs.writeFileSync(sourceFile, "export const value: number = 'bad';\n");
    const invalid = await run();
    assert.equal(invalid.decision, "temp_validation_failed", JSON.stringify(invalid));
    assert.deepEqual(invalid.commandResults.map((entry) => entry.id), ["validation.syntax"]);
    assert(invalid.issues.some((entry) => entry.code === "validation_command_failed"));
    assert.equal(fs.readFileSync(sourceFile, "utf8"), "export const value: number = 'bad';\n");
    assert.equal(fs.existsSync(path.join(workspace, "dist")), false);
    assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(stagedPrefix) &&
      !stagedBefore.has(name)), []);
    console.log(JSON.stringify({ ok: true, validCommands: valid.commandResults.map((entry) => entry.id),
      invalidCommands: invalid.commandResults.map((entry) => entry.id),
      candidateInputChangedByValidation: false, generatedOutputRetained: false,
      disposableWorkspaceCleaned: true, networkPolicy: "none" }));
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
