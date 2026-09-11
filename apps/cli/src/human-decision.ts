import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { hashCanonicalJson } from "../../../packages/product-runtime/src/canonical-runtime.js";
import type { BoundedCandidateHandoff } from "./candidate-handoff.js";
import { CliError } from "./cli-errors.js";

export const BOUNDED_HUMAN_DECISION_VERSION = "bounded-human-decision/v1" as const;
export const HUMAN_DECISIONS = ["accept", "reject", "needs_manual_edit"] as const;
export const HUMAN_DECISION_REASONS = [
  "incorrect_behavior",
  "too_large",
  "unnecessary_change",
  "bad_style",
  "missed_test",
  "other"
] as const;

export type HumanDecision = (typeof HUMAN_DECISIONS)[number];
export type HumanDecisionReason = (typeof HUMAN_DECISION_REASONS)[number];

export type HumanDecisionSelection = Readonly<{
  decision: HumanDecision;
  reason?: HumanDecisionReason | null;
}>;

export type BoundedHumanDecisionRecord = Readonly<{
  schemaVersion: typeof BOUNDED_HUMAN_DECISION_VERSION;
  taskId: string;
  candidateHandoffHash: string;
  decision: HumanDecision;
  reason: HumanDecisionReason | null;
  recordedAt: string;
  decisionHash: string;
}>;

const MAX_DECISION_BYTES = 64 * 1024;

export function isHumanDecision(value: string): value is HumanDecision {
  return (HUMAN_DECISIONS as readonly string[]).includes(value);
}

export function isHumanDecisionReason(value: string): value is HumanDecisionReason {
  return (HUMAN_DECISION_REASONS as readonly string[]).includes(value);
}

export function validateHumanDecisionSelection(value: HumanDecisionSelection): HumanDecisionSelection {
  if (!isHumanDecision(value.decision)) {
    throw new CliError("cli_human_decision_invalid", "Human decision must be accept, reject, or needs_manual_edit.");
  }
  const reason = value.reason ?? null;
  if (reason !== null && !isHumanDecisionReason(reason)) {
    throw new CliError("cli_human_decision_reason_invalid", "Human decision reason is not supported.");
  }
  return Object.freeze({ decision: value.decision, reason });
}

function artifactMaterial(record: Omit<BoundedHumanDecisionRecord, "decisionHash">): unknown {
  return record;
}

async function ensureSafeDirectory(directory: string, label: string): Promise<void> {
  const stat = await lstat(directory).catch(() => null);
  if (stat === null) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const created = await lstat(directory);
    if (!created.isDirectory() || created.isSymbolicLink()) {
      throw new CliError("cli_human_decision_state_unsafe", `${label} is unsafe.`);
    }
    return;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CliError("cli_human_decision_state_unsafe", `${label} is unsafe.`);
  }
}

async function decisionDirectory(repositoryRoot: string): Promise<string> {
  const bounded = path.join(repositoryRoot, ".bounded");
  const state = path.join(bounded, "state");
  const decisions = path.join(state, "human-decisions");
  await ensureSafeDirectory(bounded, ".bounded directory");
  await ensureSafeDirectory(state, ".bounded/state directory");
  await ensureSafeDirectory(decisions, "human decision directory");
  return decisions;
}

function decisionFilename(candidateHandoffHash: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(candidateHandoffHash)) {
    throw new CliError("cli_human_decision_invalid", "Candidate handoff hash is invalid.");
  }
  return `${candidateHandoffHash.slice("sha256:".length)}.json`;
}

export async function recordHumanDecision(
  repositoryRoot: string,
  candidate: BoundedCandidateHandoff,
  selection: HumanDecisionSelection,
  recordedAt = new Date().toISOString()
): Promise<BoundedHumanDecisionRecord> {
  const validated = validateHumanDecisionSelection(selection);
  const withoutHash: Omit<BoundedHumanDecisionRecord, "decisionHash"> = {
    schemaVersion: BOUNDED_HUMAN_DECISION_VERSION,
    taskId: candidate.taskId,
    candidateHandoffHash: candidate.handoffHash,
    decision: validated.decision,
    reason: validated.reason ?? null,
    recordedAt
  };
  const record: BoundedHumanDecisionRecord = Object.freeze({
    ...withoutHash,
    decisionHash: hashCanonicalJson(artifactMaterial(withoutHash))
  });
  const directory = await decisionDirectory(repositoryRoot);
  const target = path.join(directory, decisionFilename(candidate.handoffHash));
  const existing = await lstat(target).catch(() => null);
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new CliError("cli_human_decision_state_unsafe", "Human decision target is unsafe.");
  }
  const body = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(body) > MAX_DECISION_BYTES) {
    throw new CliError("cli_human_decision_invalid", "Human decision artifact exceeds the local state size limit.");
  }
  const temporary = path.join(directory, `${path.basename(target)}.${process.pid}.tmp`);
  try {
    await writeFile(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    if (error instanceof CliError) throw error;
    throw new CliError("cli_human_decision_write_failed", "Human decision could not be persisted.");
  }
  return record;
}

export async function readHumanDecision(
  repositoryRoot: string,
  candidateHandoffHash: string
): Promise<BoundedHumanDecisionRecord | null> {
  const directory = await decisionDirectory(repositoryRoot);
  const target = path.join(directory, decisionFilename(candidateHandoffHash));
  const stat = await lstat(target).catch(() => null);
  if (stat === null) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DECISION_BYTES) {
    throw new CliError("cli_human_decision_state_unsafe", "Human decision artifact is unsafe or too large.");
  }
  const parsed = JSON.parse(await readFile(target, "utf8")) as Partial<BoundedHumanDecisionRecord>;
  if (parsed.schemaVersion !== BOUNDED_HUMAN_DECISION_VERSION ||
      typeof parsed.taskId !== "string" || parsed.candidateHandoffHash !== candidateHandoffHash ||
      typeof parsed.decision !== "string" || !isHumanDecision(parsed.decision) ||
      (parsed.reason !== null && (typeof parsed.reason !== "string" || !isHumanDecisionReason(parsed.reason))) ||
      typeof parsed.recordedAt !== "string" || typeof parsed.decisionHash !== "string") {
    throw new CliError("cli_human_decision_invalid", "Human decision artifact is invalid.");
  }
  const { decisionHash, ...material } = parsed as BoundedHumanDecisionRecord;
  if (decisionHash !== hashCanonicalJson(artifactMaterial(material))) {
    throw new CliError("cli_human_decision_invalid", "Human decision artifact hash does not match its contents.");
  }
  return Object.freeze(parsed as BoundedHumanDecisionRecord);
}
