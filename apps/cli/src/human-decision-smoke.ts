import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { BoundedCandidateHandoff } from "./candidate-handoff.js";
import {
  BOUNDED_HUMAN_DECISION_VERSION,
  HUMAN_DECISION_REASONS,
  HUMAN_DECISIONS,
  readHumanDecision,
  recordHumanDecision,
  validateHumanDecisionSelection
} from "./human-decision.js";

function hash(char: string): string {
  return `sha256:${char.repeat(64)}`;
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

    process.stdout.write(`${JSON.stringify({
      ok: true,
      schemaVersion: valid.schemaVersion,
      decisions: HUMAN_DECISIONS,
      reasons: HUMAN_DECISION_REASONS,
      candidateBound: true,
      optionalReason: true,
      tamperRejected: true
    }, null, 2)}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
