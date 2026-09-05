#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const repository = path.resolve(__dirname, "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-package-"));
const run = (command, args, cwd) => execFileSync(command, args, {
  cwd,
  encoding: "utf8",
  env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
  stdio: ["ignore", "pipe", "inherit"]
});

try {
  // Pack with lifecycle scripts enabled, so this also verifies the prepack build.
  run("npm", ["pack", "--pack-destination", temporary], path.join(repository, "packages/product-runtime"));
  const archives = fs.readdirSync(temporary).filter((file) => file.endsWith(".tgz"));
  assert.equal(archives.length, 1);
  const consumer = path.join(temporary, "consumer");
  fs.mkdirSync(consumer);
  fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline",
    path.join(temporary, archives[0])], consumer);
  const installed = path.join(consumer, "node_modules/@bounded-dllm-agent-lab/product-runtime");
  assert.equal(fs.lstatSync(installed).isSymbolicLink(), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8"));
  assert(fs.existsSync(path.join(installed, manifest.types)));
  assert.equal(fs.existsSync(path.join(installed, "src")), false);
  fs.writeFileSync(path.join(consumer, "smoke.mjs"), `
import assert from "node:assert/strict";
import { runBoundedTask, resumeBoundedTask, compileCanonicalPolicy } from "@bounded-dllm-agent-lab/product-runtime";
assert.equal(typeof runBoundedTask, "function");
assert.equal(typeof resumeBoundedTask, "function");
assert.equal(typeof compileCanonicalPolicy, "function");
const result = await runBoundedTask({});
assert.equal(result.decision, "bounded_task_invalid");
console.log("Package-name import and runtime call passed.");
`);
  process.stdout.write(run(process.execPath, ["smoke.mjs"], consumer));
  fs.writeFileSync(path.join(consumer, "smoke.ts"), `
import { runBoundedTask, resumeBoundedTask, compileCanonicalPolicy, type RunBoundedTaskInput, type RunBoundedTaskResult, type TextFileUpdateClaimV1, type CanonicalCompiledPolicy, type DurableBoundedTaskState } from "@bounded-dllm-agent-lab/product-runtime";
const execute: (input: RunBoundedTaskInput) => Promise<RunBoundedTaskResult> = runBoundedTask;
void execute;
const operation: TextFileUpdateClaimV1["operation"] = "update";
void operation;
const compiled: CanonicalCompiledPolicy = compileCanonicalPolicy({
  repositoryPath: ".",
  policyDocument: { schemaVersion: "1", allowed_paths: ["package.json"], forbidden_paths: [] }
});
void compiled;
const resume: typeof runBoundedTask = resumeBoundedTask;
void resume;
declare const durableState: DurableBoundedTaskState;
void durableState.stateHash;
`);
  run(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit", "--strict",
    "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "smoke.ts"], consumer);
  console.log("Packed type declarations passed consumer typecheck.");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
