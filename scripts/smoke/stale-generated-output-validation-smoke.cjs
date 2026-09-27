#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

(async () => {
  const runtime = await import("../../dist/packages/product-runtime/src/canonical-runtime.js");
  const { validationSpecification } = await import("../../dist/apps/cli/src/commands/codex.js");
  const { computeTemporaryWorkspaceExecutionSpecificationHash } = await import(
    "../../dist/packages/product-runtime/src/temporary-workspace-execution-verifier.js");
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-stale-output-"));
  const repository = path.join(parent, "repository");
  const candidate = path.join(parent, "candidate");
  const fileHash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  try {
    for (const directory of ["src", "test", "dist", "node_modules/.bin", ".validation-output"]) {
      fs.mkdirSync(path.join(repository, directory), { recursive: true });
    }
    fs.cpSync(path.resolve("node_modules/typescript"), path.join(repository, "node_modules/typescript"),
      { recursive: true });
    fs.symlinkSync("../typescript/bin/tsc", path.join(repository, "node_modules/.bin/tsc"));
    fs.writeFileSync(path.join(repository, ".gitignore"), "dist/\nnode_modules/\n");
    fs.writeFileSync(path.join(repository, "package.json"), JSON.stringify({ scripts: {
      build: "tsc -p tsconfig.json", typecheck: "tsc -p tsconfig.json --noEmit",
      test: "node --test test/value.test.cjs"
    } }));
    fs.writeFileSync(path.join(repository, "tsconfig.json"), JSON.stringify({
      compilerOptions: { outDir: "dist", module: "commonjs", target: "es2022" },
      include: ["src/**/*.ts"]
    }));
    fs.writeFileSync(path.join(repository, "src/index.ts"), "export const value: number = 1;\n");
    fs.writeFileSync(path.join(repository, "test/value.test.cjs"),
      "const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');" +
      "test('fresh output only',()=>{assert.equal(require('../dist/index.js').value,3);" +
      "assert.equal(fs.existsSync('dist/stale.js'),false)});\n");
    fs.writeFileSync(path.join(repository, "dist/index.js"), "exports.value = 1;\n");
    fs.writeFileSync(path.join(repository, "dist/stale.js"), "exports.stale = true;\n");
    execFileSync("git", ["init", "-q", repository]);
    execFileSync("git", ["add", ".gitignore", "package.json", "tsconfig.json", "src", "test"],
      { cwd: repository });
    fs.cpSync(repository, candidate, { recursive: true, verbatimSymlinks: true,
      filter: (source) => path.basename(source) !== ".git" });
    fs.writeFileSync(path.join(candidate, "src/index.ts"), "export const value: number = 3;\n");
    const authorityFiles = ["src/index.ts", "tsconfig.json", "dist/index.js", "dist/stale.js"];
    const before = authorityFiles.map((file) => [file, fileHash(path.join(candidate, file))]);
    const sourceBefore = authorityFiles.map((file) => [file, fileHash(path.join(repository, file))]);
    const detected = { packageJson: { detected: true }, scripts: {
      build: ["build"], typecheck: ["typecheck"], test: ["test"]
    } };
    const specification = validationSpecification(detected, repository);
    assert.deepEqual(specification.commands[0].generatedOutputRoots, ["dist"]);
    assert.deepEqual(specification.commands[0].disposableGeneratedOutputRoots, ["dist"]);
    assert.notEqual(computeTemporaryWorkspaceExecutionSpecificationHash(specification),
      computeTemporaryWorkspaceExecutionSpecificationHash({ ...specification,
        commands: [{ ...specification.commands[0], disposableGeneratedOutputRoots: [] },
          ...specification.commands.slice(1)] }));
    const context = { tempWorkspacePath: candidate, tempApplyDecision: "temp_apply_ready",
      tempWorkspaceCleanedUp: false, ...specification };
    const run = (commands, afterCommand = async () => null) => runtime.runContainerizedWorkspaceExecution(
      { ...context, commands, allowedExecutables: ["npm", "node"] }, afterCommand,
      { runtime: "docker", sourceRepositoryPath: repository });
    const valid = await run(specification.commands);
    assert.equal(valid.decision, "temp_validation_passed", JSON.stringify(valid));
    assert.deepEqual(valid.commandResults.map((entry) => [entry.id, entry.passed]),
      specification.commands.map((entry) => [entry.id, true]));
    assert.equal(fs.readFileSync(path.join(candidate, "dist/index.js"), "utf8"), "exports.value = 1;\n");
    assert.equal(fs.existsSync(path.join(candidate, "dist/stale.js")), true);
    const unauthorizedProducer = await run([specification.commands[0], {
      id: "unauthorized-producer", executable: "node", timeoutMs: 10_000,
      args: ["-e", "require('fs').writeFileSync('dist/poison.js','poison')"]
    }]);
    assert.equal(unauthorizedProducer.decision, "temp_validation_failed");
    assert(unauthorizedProducer.issues.some((entry) =>
      entry.code === "validation_generated_output_unauthorized" &&
      entry.commandId === "unauthorized-producer"));
    const stagedBefore = new Set(fs.readdirSync(os.tmpdir()).filter((name) =>
      name.startsWith("bounded-validation-execution-")));
    const tamperedOutput = await run(specification.commands.slice(0, 2), async (command) => {
      if (command.id === "validation.syntax") {
        const staged = fs.readdirSync(os.tmpdir()).filter((name) =>
          name.startsWith("bounded-validation-execution-") && !stagedBefore.has(name));
        assert.equal(staged.length, 1);
        fs.writeFileSync(path.join(os.tmpdir(), staged[0], "dist/index.js"), "tampered\n");
      }
      return null;
    });
    assert.equal(tamperedOutput.decision, "temp_validation_failed");
    assert.deepEqual(tamperedOutput.commandResults.map((entry) => entry.id), ["validation.syntax"]);
    assert(tamperedOutput.issues.some((entry) => entry.code === "validation_workspace_staging_failed"));
    const candidateDist = path.join(candidate, "dist");
    fs.rmSync(candidateDist, { recursive: true });
    fs.symlinkSync(path.join(repository, "dist"), candidateDist, "dir");
    const aliasedRoot = await run(specification.commands);
    assert.equal(aliasedRoot.decision, "temp_validation_failed");
    assert.deepEqual(aliasedRoot.commandResults, []);
    assert(aliasedRoot.issues.some((entry) => entry.code === "validation_workspace_staging_failed"));
    fs.unlinkSync(candidateDist);
    fs.cpSync(path.join(repository, "dist"), candidateDist, { recursive: true });
    const poisoned = await run([{ id: "poison-source", executable: "node", timeoutMs: 10_000,
      generatedOutputRoots: ["dist"], disposableGeneratedOutputRoots: ["dist"],
      args: ["-e", "require('fs').writeFileSync('src/poison.js','poison')"] }]);
    assert.equal(poisoned.decision, "temp_validation_failed");
    assert(poisoned.issues.some((entry) => entry.code === "validation_generated_output_unauthorized"));
    fs.writeFileSync(path.join(candidate, "src/index.ts"), "export const value: number = 'bad';\n");
    const invalid = await run(specification.commands);
    assert.equal(invalid.decision, "temp_validation_failed");
    assert.deepEqual(invalid.commandResults.map((entry) => entry.id), ["validation.syntax"]);
    assert(invalid.issues.some((entry) => entry.code === "validation_command_failed"));
    fs.writeFileSync(path.join(candidate, "src/index.ts"), "export const value: number = 3;\n");
    execFileSync("git", ["add", "-f", "dist/stale.js"], { cwd: repository });
    assert.throws(() => validationSpecification(detected, repository),
      (error) => error.code === "cli_codex_generated_output_authority_invalid");
    const tracked = await run(specification.commands);
    assert.equal(tracked.decision, "temp_validation_failed");
    assert.deepEqual(tracked.commandResults, []);
    assert(tracked.issues.some((entry) => entry.code === "validation_disposable_output_authority_invalid"));
    execFileSync("git", ["rm", "--cached", "-q", "--", "dist/stale.js"], { cwd: repository });
    const ignorePath = path.join(repository, ".gitignore");
    const originalIgnore = fs.readFileSync(ignorePath);
    fs.writeFileSync(ignorePath, "node_modules/\n");
    assert.throws(() => validationSpecification(detected, repository),
      (error) => error.code === "cli_codex_generated_output_authority_invalid");
    fs.writeFileSync(ignorePath, originalIgnore);
    for (const [file, hash] of before) assert.equal(fileHash(path.join(candidate, file)), hash);
    for (const [file, hash] of sourceBefore) assert.equal(fileHash(path.join(repository, file)), hash);
    console.log(JSON.stringify({ ok: true, validCommands: valid.commandResults.map((entry) => entry.id),
      staleOutputDiscarded: true, generatedRootHashBound: true,
      generatedOutputProducerBound: true, sourcePoisonBlocked: true,
      outputAliasBlocked: true,
      trackedRootBlocked: true, nonIgnoredRootBlocked: true,
      compileFailureFailFast: true, sourceMutations: 0,
      candidateAuthorityMutations: 0, network: "none" }));
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
