import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  captureCandidateSourceSnapshotHash,
  createCandidateHandoff,
  writeCandidateHandoff,
  type BoundedCandidateHandoff
} from "./candidate-handoff.js";
import { applyCommand } from "./commands/apply.js";
import {
  BOUNDED_HUMAN_DECISION_VERSION,
  HUMAN_DECISION_REASONS,
  HUMAN_DECISIONS,
  readHumanDecision,
  recordHumanDecision,
  validateHumanDecisionSelection
} from "./human-decision.js";

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, "dist", "apps", "cli", "src", "index.js");

function hash(char: string): string {
  return `sha256:${char.repeat(64)}`;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", timeout: 5_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function runCli(cwd: string, args: readonly string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, CI: "" }
  });
}

async function createNonTtyApplyFixture(root: string): Promise<{
  repository: string;
  candidate: BoundedCandidateHandoff;
  sourceOriginal: string;
}> {
  const repository = path.join(root, "non-tty-apply");
  const sourceOriginal = "export const value = 1;\n";
  const sourceChanged = "export const value = 2;\n";
  await mkdir(path.join(repository, "src"), { recursive: true });
  git(repository, ["init", "-q"]);
  await writeFile(
    path.join(repository, "package.json"),
    `${JSON.stringify({ name: "human-decision-non-tty-fixture", private: true }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(path.join(repository, "src", "value.ts"), sourceOriginal, "utf8");
  const init = runCli(repository, ["init", "--json"]);
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const candidate = createCandidateHandoff({
    taskId: "codex.fixture.human-decision-non-tty",
    objectiveHash: hash("b"),
    sourceSnapshotHash: captureCandidateSourceSnapshotHash(repository),
    planHash: hash("c"),
    contextBindingHash: hash("d"),
    plannerExecutionBindingHash: hash("e"),
    compiledPolicyHash: hash("f"),
    allowedFiles: ["src/value.ts"],
    forbiddenFiles: [],
    acceptanceCriteriaContract: {},
    validationProfile: "structural_draft",
    phaseVExecutionSpecification: {},
    coderMutation: {
      role: "coder",
      target: "patchDraft",
      summary: "Change fixture value.",
      claims: [{
        claimVersion: "text-file-update/v1",
        type: "patch_draft",
        operation: "update",
        file: "src/value.ts",
        expectedContentHash: sha256(sourceOriginal),
        newContent: sourceChanged,
        description: "Change the fixture value."
      }],
      touchedFiles: ["src/value.ts"]
    },
    verifierFinding: {
      role: "verifier",
      target: "verifierFinding",
      summary: "Fixture candidate approved.",
      claims: [],
      touchedFiles: ["src/value.ts"]
    },
    adaptiveResult: { decision: "fixture" },
    declaredRiskClass: "low",
    candidateFiles: ["src/value.ts"]
  } as Parameters<typeof createCandidateHandoff>[0]);
  await writeCandidateHandoff(repository, candidate);
  return { repository, candidate, sourceOriginal };
}

async function verifyNonTtyWithoutInjectedDecision(root: string): Promise<void> {
  const { repository, candidate, sourceOriginal } = await createNonTtyApplyFixture(root);
  const originalCi = process.env.CI;
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  delete process.env.CI;
  Object.defineProperty(process.stdin, "isTTY", {
    value: false,
    configurable: true
  });
  try {
    const result = await applyCommand({}, repository, {});
    assert.equal(result.exitCode, 3);
    assert.equal(result.output.decision, "approval_required");
    assert.equal(result.output.mutationStarted, false);
    assert.equal(result.output.apply, "NOT_RUN");
    assert.equal("humanDecision" in result.output, false);
    assert.equal(await readHumanDecision(repository, candidate.handoffHash), null);
    assert.equal(await readFile(path.join(repository, "src", "value.ts"), "utf8"), sourceOriginal);
  } finally {
    if (stdinDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
    else delete (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY;
    if (originalCi === undefined) delete process.env.CI;
    else process.env.CI = originalCi;
  }
}

async function main(): Promise<void> {
  const root = await mkdir(path.join(os.tmpdir(), `bounded-human-decision-${process.pid}`), { recursive: true })
    .then(() => path.join(os.tmpdir(), `bounded-human-decision-${process.pid}`));
  try {
    await mkdir(path.join(root, ".bounded", "state"), { recursive: true });
    const candidate = {
      taskId: "codex.fixture.human-decision",
      handoffHash: hash("a")
    } as BoundedCandidateHandoff;

    for (const decision of HUMAN_DECISIONS) {
      const record = await recordHumanDecision(root, candidate, { decision, reason: null }, "2026-01-01T00:00:00.000Z");
      assert.equal(record.schemaVersion, BOUNDED_HUMAN_DECISION_VERSION);
      assert.equal(record.candidateHandoffHash, candidate.handoffHash);
      assert.equal(record.decision, decision);
      assert.equal(record.reason, null);
      assert.match(record.decisionHash, /^sha256:[0-9a-f]{64}$/);
      const roundTrip = await readHumanDecision(root, candidate.handoffHash);
      assert.deepEqual(roundTrip, record);
    }

    for (const reason of HUMAN_DECISION_REASONS) {
      const record = await recordHumanDecision(root, candidate, {
        decision: "needs_manual_edit",
        reason
      }, "2026-01-01T00:00:00.000Z");
      assert.equal(record.reason, reason);
    }

    assert.throws(
      () => validateHumanDecisionSelection({ decision: "invalid" as "accept" }),
      /accept, reject, or needs_manual_edit/
    );
    assert.throws(
      () => validateHumanDecisionSelection({ decision: "reject", reason: "invalid" as "other" }),
      /reason is not supported/
    );

    const valid = await recordHumanDecision(root, candidate, {
      decision: "reject",
      reason: "incorrect_behavior"
    }, "2026-01-01T00:00:00.000Z");
    const artifactPath = path.join(
      root,
      ".bounded",
      "state",
      "human-decisions",
      `${candidate.handoffHash.slice("sha256:".length)}.json`
    );
    const tampered = JSON.parse(await readFile(artifactPath, "utf8")) as Record<string, unknown>;
    tampered.reason = "too_large";
    await writeFile(artifactPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
    await assert.rejects(() => readHumanDecision(root, candidate.handoffHash), /hash does not match/);

    await verifyNonTtyWithoutInjectedDecision(root);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      schemaVersion: valid.schemaVersion,
      decisions: HUMAN_DECISIONS,
      reasons: HUMAN_DECISION_REASONS,
      candidateBound: true,
      optionalReason: true,
      tamperRejected: true,
      nonTtyWithoutInjectedDecision: "approval_required",
      nonTtyMutationStarted: false,
      nonTtyDecisionArtifactCreated: false
    }, null, 2)}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
