"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const snapshotExclusions = new Set([".git", ".bounded", "node_modules", "dist"]);

function sha256(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

async function snapshot(root) {
  const entries = [];
  async function walk(directory, prefix = "") {
    for (const name of (await fs.readdir(directory)).sort()) {
      if (prefix === "" && snapshotExclusions.has(name)) continue;
      const absolute = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = await fs.lstat(absolute);
      assert.equal(stat.isSymbolicLink(), false, `snapshot symlink: ${relative}`);
      if (stat.isDirectory()) await walk(absolute, relative);
      else if (stat.isFile()) entries.push([relative, sha256(await fs.readFile(absolute))]);
    }
  }
  await walk(root);
  return sha256(JSON.stringify(entries));
}

async function copyFixtureWorkspace(repository, target) {
  await fs.cp(repository, target, {
    recursive: true,
    filter: (source) => !snapshotExclusions.has(path.basename(source))
  });
}

async function materializeCandidate(repository, candidate, target) {
  await copyFixtureWorkspace(repository, target);
  const claim = candidate.coderMutation.claims.find((item) => item.file === "src/calculate.js");
  assert.ok(claim && typeof claim.newContent === "string");
  await fs.writeFile(path.join(target, claim.file), claim.newContent, "utf8");
}

async function createTrustedChecker(parent) {
  const trustedRoot = path.join(parent, "trusted-host");
  const checker = path.join(trustedRoot, "calculate-acceptance.mjs");
  await fs.mkdir(trustedRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(checker, [
    "import assert from 'node:assert/strict';",
    "import { pathToFileURL } from 'node:url';",
    "const workspace = process.argv[2];",
    "const moduleUrl = pathToFileURL(`${workspace}/src/calculate.js`);",
    "moduleUrl.searchParams.set('run', `${process.pid}-${Date.now()}`);",
    "const { calculate } = await import(moduleUrl.href);",
    "const actual = calculate(4);",
    "assert.equal(actual, 12);",
    "process.stdout.write(JSON.stringify({ criterionId: 'calculate.multiplies-by-three', actual, expected: 12 }));",
    ""
  ].join("\n"), { encoding: "utf8", mode: 0o400 });
  assert.equal(path.relative(parent, checker).startsWith("trusted-host/"), true);
  return checker;
}

async function executeAcceptance(checker, workspace, evidenceDirectory, label) {
  const result = spawnSync(process.execPath, [checker, workspace], {
    cwd: path.dirname(checker),
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, CI: "1" },
    maxBuffer: 1024 * 1024
  });
  const output = {
    label,
    exitCode: result.status,
    signal: result.signal,
    stdout: String(result.stdout ?? "").slice(0, 32_768),
    stderr: String(result.stderr ?? "").slice(0, 32_768)
  };
  const bytes = Buffer.from(`${JSON.stringify(output, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(evidenceDirectory, `${label}.json`), bytes, {
    flag: "wx",
    mode: 0o600
  });
  const observation = {
    workspaceHash: await snapshot(workspace),
    verdict: result.status === null ? "infrastructure_fail" : result.status === 0 ? "pass" : "assertion_fail",
    exitCode: result.status,
    outputHash: sha256(bytes)
  };
  return {
    log: { ...output, outputHash: observation.outputHash },
    execution: { ...observation, artifactHash: sha256(JSON.stringify(observation)) }
  };
}

function executeFixtureCheck(workspace, command) {
  const result = spawnSync("npm", ["run", command], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, CI: "1" },
    maxBuffer: 1024 * 1024
  });
  return {
    command,
    exitCode: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
    outputHash: sha256(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)
  };
}

module.exports = { sha256, snapshot, copyFixtureWorkspace, materializeCandidate, createTrustedChecker, executeAcceptance, executeFixtureCheck };
