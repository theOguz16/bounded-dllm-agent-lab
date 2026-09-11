#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} = require("node:fs");
const { tmpdir } = require("node:os");
const {
  basename,
  dirname,
  join,
  resolve,
  sep
} = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = resolve(__dirname, "../..");
const fixturePath = resolve(
  repoRoot,
  "fixtures/product/adversarial-agent/cases.json"
);

const expectedCaseIds = [
  "outside_write",
  "new_file_create",
  "file_delete",
  "rename",
  "symlink",
  "binary_file",
  "oversized_output",
  "changed_file_limit_33",
  "stale_source_mutation",
  "forbidden_file",
  "dotenv_read",
  "secret_environment_read",
  "network_request",
  "infinite_process",
  "malformed_jsonl",
  "fake_token_telemetry",
  "duplicate_event"
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function write(root, relativePath, content) {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function git(root, args, options = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: options.encoding ?? "utf8",
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" }
  });
}

function baseSourceFiles() {
  return {
    "src/allowed.txt": "allowed baseline\n",
    "src/secondary.txt": "secondary baseline\n",
    "src/stale.txt": "current source bytes\n",
    "src/forbidden.txt": "forbidden source bytes\n",
    ".env": "FIXTURE_PRIVATE_VALUE=fixture-only-not-a-real-secret\n"
  };
}

function initSourceRepo(files = baseSourceFiles()) {
  const root = mkdtempSync(join(tmpdir(), "bounded-adversarial-source-"));
  for (const [relativePath, content] of Object.entries(files)) {
    write(root, relativePath, content);
  }
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "Adversarial Fixture"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "adversarial fixture"]);
  return root;
}

function sourceFingerprint(root) {
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const status = git(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all"
  ]);
  const tracked = git(root, ["ls-files", "-z", "--cached"])
    .split("\0")
    .filter(Boolean)
    .sort();
  const files = tracked.map((relativePath) => {
    const target = join(root, relativePath);
    const stat = lstatSync(target);
    return {
      path: relativePath,
      mode: stat.mode & 0o777,
      type: stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : "other",
      hash: stat.isFile() ? sha256(readFileSync(target)) : null
    };
  });
  return sha256(Buffer.from(JSON.stringify({ head, status, files }), "utf8"));
}

function loadFixtureMatrix() {
  const matrix = JSON.parse(readFileSync(fixturePath, "utf8"));
  assert.equal(matrix.schemaVersion, "adversarial-agent-fixture/v1");
  assert.equal(Array.isArray(matrix.cases), true);
  assert.deepEqual(
    matrix.cases.map((entry) => entry.id),
    expectedCaseIds,
    "fixture case order must stay frozen and complete"
  );
  assert.equal(new Set(expectedCaseIds).size, expectedCaseIds.length);
  return matrix;
}

function agentRequest(workingDirectory, overrides = {}) {
  return {
    runId: "adversarial-agent-suite",
    agentId: "codex",
    workingDirectory,
    task: "Execute one deterministic adversarial fixture.",
    model: "fixture-codex-model",
    reasoningEffort: "medium",
    mode: "coder",
    timeoutMs: 5_000,
    networkAllowed: false,
    sandboxMode: "workspace_write",
    ...overrides
  };
}

function fakeClientFromEvents(events) {
  return {
    startThread() {
      return {
        async runStreamed() {
          return {
            events: (async function* () {
              for (const event of events) yield event;
            })()
          };
        }
      };
    }
  };
}

async function main() {
  const matrix = loadFixtureMatrix();
  const workspaceModule = await import(pathToFileURL(resolve(
    repoRoot,
    "dist/packages/integrations/src/disposable-agent-workspace.js"
  )).href);
  const captureModule = await import(pathToFileURL(resolve(
    repoRoot,
    "dist/packages/integrations/src/agent-mutation-capture.js"
  )).href);
  const textContract = await import(pathToFileURL(resolve(
    repoRoot,
    "dist/packages/product-runtime/src/text-file-update-contract.js"
  )).href);
  const environmentModule = await import(pathToFileURL(resolve(
    repoRoot,
    "dist/packages/integrations/src/agent-environment.js"
  )).href);
  const adapterModule = await import(pathToFileURL(resolve(
    repoRoot,
    "dist/packages/integrations/src/codex-agent-adapter.js"
  )).href);
  const parserModule = await import(pathToFileURL(resolve(
    repoRoot,
    "dist/packages/integrations/src/codex-event-parser.js"
  )).href);

  const results = [];
  let liveProviderCalls = 0;
  let externalNetworkCalls = 0;

  async function withSourceInvariant(id, action, files = baseSourceFiles()) {
    const sourceRoot = initSourceRepo(files);
    const before = sourceFingerprint(sourceRoot);
    try {
      const detail = await action(sourceRoot);
      assert.equal(
        sourceFingerprint(sourceRoot),
        before,
        `${id} changed the authoritative source repository`
      );
      results.push({ id, ok: true, detail });
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  }

  async function createWorkspace(
    sourceRoot,
    visibleFiles,
    changeAllowedFiles = visibleFiles,
    forbiddenFiles = ["src/forbidden.txt"]
  ) {
    const head = git(sourceRoot, ["rev-parse", "HEAD"]).trim();
    return workspaceModule.createDisposableAgentWorkspace({
      repositoryPath: sourceRoot,
      sourceSnapshotHash: `sha256:${sha256(Buffer.from(head, "utf8"))}`,
      visibleFiles,
      changeAllowedFiles,
      forbiddenFiles,
      mode: "bounded"
    });
  }

  async function expectCaptureReject(workspace, expectedCode) {
    await assert.rejects(
      () => captureModule.captureAgentMutations({
        workspacePath: workspace.workspacePath,
        sourceManifest: workspace.manifest
      }),
      (error) => {
        assert.equal(error?.code, expectedCode);
        return true;
      }
    );
  }

  await withSourceInvariant("outside_write", async (sourceRoot) => {
    const workspace = await createWorkspace(sourceRoot, ["src/allowed.txt"]);
    const outside = resolve(
      workspace.workspacePath,
      "..",
      `${basename(workspace.workspacePath)}-outside.txt`
    );
    try {
      assert.equal(outside.startsWith(`${resolve(sourceRoot)}${sep}`), false);
      writeFileSync(outside, "fake agent escaped its disposable directory\n");
      assert.equal(existsSync(outside), true);
      await expectCaptureReject(workspace, "agent_mutation_no_changes");
      return "outside write stayed outside source repository";
    } finally {
      rmSync(outside, { force: true });
      rmSync(workspace.workspacePath, { recursive: true, force: true });
    }
  });

  await withSourceInvariant("new_file_create", async (sourceRoot) => {
    const workspace = await createWorkspace(sourceRoot, ["src/allowed.txt"]);
    try {
      writeFileSync(join(workspace.workspacePath, "src/new.txt"), "new file\n");
      await expectCaptureReject(workspace, "agent_mutation_added_unsupported");
      return "agent_mutation_added_unsupported";
    } finally {
      rmSync(workspace.workspacePath, { recursive: true, force: true });
    }
  });

  await withSourceInvariant("file_delete", async (sourceRoot) => {
    const workspace = await createWorkspace(sourceRoot, ["src/allowed.txt"]);
    try {
      unlinkSync(join(workspace.workspacePath, "src/allowed.txt"));
      await expectCaptureReject(workspace, "agent_mutation_deleted_unsupported");
      return "agent_mutation_deleted_unsupported";
    } finally {
      rmSync(workspace.workspacePath, { recursive: true, force: true });
    }
  });

  await withSourceInvariant("rename", async (sourceRoot) => {
    const workspace = await createWorkspace(sourceRoot, ["src/allowed.txt"]);
    try {
      git(workspace.workspacePath, ["mv", "src/allowed.txt", "src/renamed.txt"]);
      await expectCaptureReject(workspace, "agent_mutation_renamed_unsupported");
      return "agent_mutation_renamed_unsupported";
    } finally {
      rmSync(workspace.workspacePath, { recursive: true, force: true });
    }
  });

  await withSourceInvariant("symlink", async (sourceRoot) => {
    const workspace = await createWorkspace(
      sourceRoot,
      ["src/allowed.txt", "src/secondary.txt"]
    );
    try {
      unlinkSync(join(workspace.workspacePath, "src/secondary.txt"));
      symlinkSync("allowed.txt", join(workspace.workspacePath, "src/secondary.txt"));
      await expectCaptureReject(workspace, "agent_mutation_symlink_unsupported");
      return "agent_mutation_symlink_unsupported";
    } finally {
      rmSync(workspace.workspacePath, { recursive: true, force: true });
    }
  });

  await withSourceInvariant("binary_file", async (sourceRoot) => {
    const workspace = await createWorkspace(sourceRoot, ["src/allowed.txt"]);
    try {
      writeFileSync(
        join(workspace.workspacePath, "src/allowed.txt"),
        Buffer.from([0x00, 0xff, 0x01, 0x02])
      );
      await expectCaptureReject(workspace, "agent_mutation_binary_unsupported");
      return "agent_mutation_binary_unsupported";
    } finally {
      rmSync(workspace.workspacePath, { recursive: true, force: true });
    }
  });

  await withSourceInvariant("oversized_output", async (sourceRoot) => {
    const scratch = mkdtempSync(join(tmpdir(), "bounded-adversarial-output-"));
    try {
      const huge = "x".repeat(1024 * 1024 + 1);
      const adapter = new adapterModule.CodexAgentAdapter({
        clientFactory: () => fakeClientFromEvents([
          {
            type: "item.completed",
            item: {
              id: "huge-message",
              type: "agent_message",
              text: huge,
              status: "completed"
            }
          },
          {
            type: "turn.completed",
            usage: { input_tokens: 1, output_tokens: 1 }
          }
        ])
      });
      const result = await adapter.run(agentRequest(scratch, {
        processBudget: { maxStdoutBytes: 1024 * 1024 }
      }));
      assert.equal(result.status, "failed");
      assert.equal(result.failureCode, "agent_output_limit");
      assert.equal(
        result.diagnostics.some((entry) => entry.code === "agent_output_limit"),
        true
      );
      return "agent_output_limit";
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  const manyFiles = {};
  for (let index = 0; index < 33; index += 1) {
    manyFiles[`src/f${String(index).padStart(2, "0")}.txt`] = `before-${index}\n`;
  }
  await withSourceInvariant("changed_file_limit_33", async (sourceRoot) => {
    const visibleFiles = Object.keys(manyFiles).sort();
    const workspace = await createWorkspace(sourceRoot, visibleFiles, visibleFiles, []);
    try {
      for (const [relativePath] of Object.entries(manyFiles)) {
        writeFileSync(join(workspace.workspacePath, relativePath), `changed-${relativePath}\n`);
      }
      await expectCaptureReject(workspace, "agent_mutation_file_count_exceeded");
      return "agent_mutation_file_count_exceeded";
    } finally {
      rmSync(workspace.workspacePath, { recursive: true, force: true });
    }
  }, manyFiles);

  await withSourceInvariant("stale_source_mutation", async (sourceRoot) => {
    const current = readFileSync(join(sourceRoot, "src/stale.txt"));
    const staleClaim = {
      file: "src/stale.txt",
      expectedContentHash: `sha256:${sha256(Buffer.from("stale source bytes\n", "utf8"))}`,
      newContent: "fake agent mutation\n"
    };
    assert.throws(
      () => textContract.validateUpdateSource(staleClaim, current),
      (error) => error?.code === "MUTATION_SOURCE_HASH_MISMATCH"
    );
    return "MUTATION_SOURCE_HASH_MISMATCH";
  });

  await withSourceInvariant("forbidden_file", async (sourceRoot) => {
    const workspace = await createWorkspace(sourceRoot, ["src/allowed.txt"]);
    try {
      const forbidden = join(workspace.workspacePath, "src/forbidden.txt");
      assert.equal(existsSync(forbidden), false, "forbidden file must not be exposed");
      writeFileSync(forbidden, "fake agent attempted forbidden write\n");
      await expectCaptureReject(workspace, "agent_mutation_added_unsupported");
      assert.equal(
        readFileSync(join(sourceRoot, "src/forbidden.txt"), "utf8"),
        "forbidden source bytes\n"
      );
      return "forbidden file absent from workspace and add rejected";
    } finally {
      rmSync(workspace.workspacePath, { recursive: true, force: true });
    }
  });

  await withSourceInvariant("dotenv_read", async (sourceRoot) => {
    const workspace = await createWorkspace(sourceRoot, ["src/allowed.txt"]);
    try {
      assert.equal(existsSync(join(sourceRoot, ".env")), true);
      assert.equal(existsSync(join(workspace.workspacePath, ".env")), false);
      assert.throws(
        () => readFileSync(join(workspace.workspacePath, ".env"), "utf8"),
        (error) => error?.code === "ENOENT"
      );
      return "not_exposed";
    } finally {
      rmSync(workspace.workspacePath, { recursive: true, force: true });
    }
  });

  await withSourceInvariant("secret_environment_read", async () => {
    const sourceEnvironment = {
      PATH: process.env.PATH ?? "",
      HOME: tmpdir(),
      USER: "adversarial-fixture",
      LANG: "C",
      SUPER_SECRET_VALUE: "fixture-env-value"
    };
    const filtered = environmentModule.createAgentEnvironment(sourceEnvironment);
    assert.equal("SUPER_SECRET_VALUE" in filtered, false);
    const child = spawnSync(
      process.execPath,
      ["-e", "process.stdout.write(process.env.SUPER_SECRET_VALUE ?? 'not-exposed')"],
      { env: { ...filtered }, encoding: "utf8", timeout: 5_000 }
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "not-exposed");
    return "not_exposed";
  });

  await withSourceInvariant("network_request", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "bounded-adversarial-network-"));
    let clientFactoryCalls = 0;
    try {
      const adapter = new adapterModule.CodexAgentAdapter({
        clientFactory: () => {
          clientFactoryCalls += 1;
          liveProviderCalls += 1;
          externalNetworkCalls += 1;
          return fakeClientFromEvents([]);
        }
      });
      const result = await adapter.run(agentRequest(scratch, { networkAllowed: true }));
      assert.equal(result.status, "rejected");
      assert.equal(clientFactoryCalls, 0, "network denial must happen before provider creation");
      assert.equal(
        result.diagnostics.some(
          (entry) => entry.code === "codex_isolation_network_policy_required"
        ),
        true
      );
      return "network_policy_required";
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  await withSourceInvariant("infinite_process", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "bounded-adversarial-timeout-"));
    let aborted = false;
    try {
      const adapter = new adapterModule.CodexAgentAdapter({
        clientFactory: () => ({
          startThread() {
            return {
              async runStreamed(_input, turnOptions) {
                return {
                  events: (async function* () {
                    await new Promise((resolvePromise, rejectPromise) => {
                      const signal = turnOptions.signal;
                      if (signal.aborted) {
                        aborted = true;
                        rejectPromise(signal.reason);
                        return;
                      }
                      signal.addEventListener("abort", () => {
                        aborted = true;
                        rejectPromise(signal.reason);
                      }, { once: true });
                    });
                    yield { type: "turn.started" };
                  })()
                };
              }
            };
          }
        })
      });
      const result = await adapter.run(agentRequest(scratch, {
        timeoutMs: 1_000,
        processBudget: { totalTimeoutMs: 25 }
      }));
      assert.equal(result.status, "timed_out");
      assert.equal(result.failureCode, "agent_timeout");
      assert.equal(aborted, true);
      return "agent_timeout";
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  await withSourceInvariant("malformed_jsonl", async () => {
    const parsed = parserModule.parseCodexJsonl('{"type":"turn.started"}\n{"type":');
    assert.equal(parsed.status, "agent_protocol_invalid");
    assert.equal(
      parsed.diagnostics.some((entry) => entry.code === "agent_protocol_invalid"),
      true
    );
    return "agent_protocol_invalid";
  });

  await withSourceInvariant("fake_token_telemetry", async () => {
    const parsed = parserModule.parseCodexJsonl([
      JSON.stringify({ type: "thread.started", thread_id: "telemetry-fixture" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 5,
          cached_input_tokens: 9,
          output_tokens: 1
        }
      })
    ].join("\n"));
    assert.equal(parsed.status, "agent_protocol_invalid");
    assert.equal(parsed.telemetry.usageStatus, "unavailable");
    assert.equal(
      parsed.diagnostics.some((entry) => entry.code === "agent_protocol_invalid"),
      true
    );
    return "agent_protocol_invalid";
  });

  await withSourceInvariant("duplicate_event", async () => {
    const command = {
      type: "item.completed",
      item: {
        id: "duplicate-command",
        type: "command_execution",
        command: "printf fixture",
        aggregated_output: "fixture",
        exit_code: 0,
        status: "completed"
      }
    };
    const parsed = parserModule.parseCodexJsonl([
      JSON.stringify({ type: "thread.started", thread_id: "duplicate-fixture" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify(command),
      JSON.stringify(command),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 1, output_tokens: 1 }
      })
    ].join("\n"));
    assert.equal(parsed.status, "completed");
    assert.equal(parsed.commands.length, 1);
    assert.equal(parsed.telemetry.commandCount, 1);
    return "deduplicated";
  });

  assert.equal(results.length, matrix.cases.length);
  assert.deepEqual(results.map((entry) => entry.id), expectedCaseIds);
  assert.equal(results.every((entry) => entry.ok), true);
  assert.equal(liveProviderCalls, 0);
  assert.equal(externalNetworkCalls, 0);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    suiteVersion: matrix.schemaVersion,
    caseCount: results.length,
    passed: results.length,
    realRepositoryMutated: false,
    liveProviderCalls,
    externalNetworkCalls,
    cases: results
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
