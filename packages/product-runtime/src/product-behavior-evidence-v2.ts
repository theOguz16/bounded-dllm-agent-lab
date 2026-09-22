import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** A new contract: legacy product-behavior-evidence/v1 remains frozen. */
export const TRUSTED_BEHAVIOR_EVIDENCE_VERSION = "trusted-behavior-evidence/v2" as const;
const HASH = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const ID = /^[a-z0-9][a-z0-9._-]{2,127}$/;

type Verdict = "pass" | "assertion_fail" | "infrastructure_fail";
export type TrustedBehaviorExecution = Readonly<{
  workspaceHash: string;
  verdict: Verdict;
  exitCode: number | null;
  outputHash: string;
  artifactHash: string;
}>;
export type TrustedBehaviorCriterion = Readonly<{
  criterionId: string;
  checkHash: string;
  source: TrustedBehaviorExecution;
  reference: TrustedBehaviorExecution;
  wrong: TrustedBehaviorExecution;
  candidate: TrustedBehaviorExecution;
}>;
export type TrustedBehaviorReceipt = Readonly<{
  receiptVersion: typeof TRUSTED_BEHAVIOR_EVIDENCE_VERSION;
  taskId: string;
  taskHash: string;
  sourceCommitSha: string;
  sourceTreeHash: string;
  referenceCommitSha: string;
  referenceTreeHash: string;
  wrongTreeHash: string;
  candidateTreeHash: string;
  catalogHash: string;
  issuedAt: number;
  nonce: string;
  criteria: readonly TrustedBehaviorCriterion[];
  seal: string;
}>;
export type TrustedBehaviorExpectation = Readonly<{
  taskId: string;
  taskHash: string;
  sourceCommitSha: string;
  sourceTreeHash: string;
  referenceCommitSha: string;
  referenceTreeHash: string;
  wrongTreeHash: string;
  candidateTreeHash: string;
  catalogHash: string;
  requiredCriteria: readonly Readonly<{ criterionId: string; checkHash: string }>[];
}>;
export type TrustedBehaviorAssessment = Readonly<{
  behaviorSatisfied: boolean | null;
  criterionCount: number;
  passedCriterionCount: number;
  reason: string;
}>;

export function trustedBehaviorHash(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
    Object.getOwnPropertySymbols(value).length === 0 &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((entry) => "value" in entry);
}
function fields(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((name, index) => name === sorted[index]);
}
function assessment(reason: string, count = 0, passed = 0, value: boolean | null = null): TrustedBehaviorAssessment {
  return Object.freeze({ behaviorSatisfied: value, criterionCount: count, passedCriterionCount: passed, reason });
}
function execution(value: unknown, expectedHash: string): value is TrustedBehaviorExecution {
  if (!plain(value) || !fields(value, ["workspaceHash", "verdict", "exitCode", "outputHash", "artifactHash"])) return false;
  if (value.workspaceHash !== expectedHash || !HASH.test(String(value.outputHash)) || !HASH.test(String(value.artifactHash)) ||
      !["pass", "assertion_fail", "infrastructure_fail"].includes(String(value.verdict)) ||
      !(value.exitCode === null || (Number.isSafeInteger(value.exitCode) && Number(value.exitCode) >= 0))) return false;
  const { artifactHash, ...observation } = value;
  return trustedBehaviorHash(JSON.stringify(observation)) === artifactHash;
}

/**
 * Only a trusted host supplies the expected identities and its ephemeral HMAC key.
 * Candidate/agent data MUST NOT supply either. Invalid or absent proof stays null;
 * an authenticated, executed candidate assertion failure is false.
 */
export function evaluateTrustedBehaviorEvidence(
  evidence: unknown | null,
  expectation: TrustedBehaviorExpectation,
  hostKey: Buffer,
  now: number = Date.now(),
  maxAgeMs = 15 * 60_000
): TrustedBehaviorAssessment {
  if (!plain(expectation) || !Array.isArray(expectation.requiredCriteria) || expectation.requiredCriteria.length === 0 ||
      expectation.requiredCriteria.length > 32 || !Buffer.isBuffer(hostKey) || hostKey.length < 32 ||
      !Number.isSafeInteger(now) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) return assessment("trusted_authority_unavailable");
  const required = new Map<string, string>();
  for (const item of expectation.requiredCriteria) {
    if (!plain(item) || !fields(item, ["criterionId", "checkHash"]) ||
        typeof item.criterionId !== "string" || !ID.test(item.criterionId) ||
        typeof item.checkHash !== "string" || !HASH.test(item.checkHash) || required.has(item.criterionId)) return assessment("invalid_trusted_catalog");
    required.set(item.criterionId, item.checkHash);
  }
  if (evidence === null) return assessment("missing_evidence", required.size);
  if (!plain(evidence) || !fields(evidence, ["receiptVersion", "taskId", "taskHash", "sourceCommitSha", "sourceTreeHash", "referenceCommitSha", "referenceTreeHash", "wrongTreeHash", "candidateTreeHash", "catalogHash", "issuedAt", "nonce", "criteria", "seal"])) return assessment("invalid_evidence", required.size);
  if (evidence.receiptVersion !== TRUSTED_BEHAVIOR_EVIDENCE_VERSION ||
      expectation.taskId !== evidence.taskId || !ID.test(String(evidence.taskId)) ||
      !COMMIT.test(String(evidence.sourceCommitSha)) || !COMMIT.test(String(evidence.referenceCommitSha)) ||
      !["taskHash", "sourceCommitSha", "sourceTreeHash", "referenceCommitSha", "referenceTreeHash", "wrongTreeHash", "candidateTreeHash", "catalogHash"].every((name) => expectation[name as keyof TrustedBehaviorExpectation] === evidence[name] &&
        (name.endsWith("CommitSha") ? COMMIT : HASH).test(String(evidence[name]))) ||
      !Number.isSafeInteger(evidence.issuedAt) || Number(evidence.issuedAt) > now ||
      now - Number(evidence.issuedAt) > maxAgeMs || typeof evidence.nonce !== "string" || !/^[0-9a-f]{32}$/.test(evidence.nonce) ||
      typeof evidence.seal !== "string" || !/^[0-9a-f]{64}$/.test(evidence.seal) || !Array.isArray(evidence.criteria)) return assessment("stale_or_wrong_identity", required.size);
  const { seal, ...unsigned } = evidence;
  const expectedSeal = createHmac("sha256", hostKey).update(JSON.stringify(unsigned)).digest("hex");
  if (!timingSafeEqual(Buffer.from(seal), Buffer.from(expectedSeal))) return assessment("unauthenticated_evidence", required.size);
  if (evidence.criteria.length !== required.size) return assessment("missing_or_extra_criterion", required.size);
  const seen = new Set<string>();
  let passed = 0;
  let assertionFailure = false;
  for (const criterion of evidence.criteria) {
    if (!plain(criterion) || !fields(criterion, ["criterionId", "checkHash", "source", "reference", "wrong", "candidate"]) ||
        typeof criterion.criterionId !== "string" || seen.has(criterion.criterionId) ||
        required.get(criterion.criterionId) !== criterion.checkHash) return assessment("missing_or_wrong_criterion", required.size);
    seen.add(criterion.criterionId);
    if (!execution(criterion.source, expectation.sourceTreeHash) ||
        !execution(criterion.reference, expectation.referenceTreeHash) ||
        !execution(criterion.wrong, expectation.wrongTreeHash) ||
        !execution(criterion.candidate, expectation.candidateTreeHash)) return assessment("missing_execution_artifact", required.size);
    if (criterion.source.verdict !== "assertion_fail" || criterion.reference.verdict !== "pass" ||
        criterion.wrong.verdict !== "assertion_fail") return assessment("triad_not_proven", required.size);
    if (criterion.candidate.verdict === "infrastructure_fail") return assessment("candidate_execution_unavailable", required.size);
    if (criterion.candidate.verdict === "pass") passed++;
    else assertionFailure = true;
  }
  return assessment(assertionFailure ? "acceptance_assertion_failed" : "trusted_acceptance_passed", required.size, passed, !assertionFailure);
}

/** The signer is restricted to the trusted runner, never bundled in a candidate workspace. */
export function sealTrustedBehaviorEvidence(
  unsigned: Omit<TrustedBehaviorReceipt, "seal">,
  hostKey: Buffer
): TrustedBehaviorReceipt {
  if (!Buffer.isBuffer(hostKey) || hostKey.length < 32) throw new Error("Trusted signing key unavailable");
  return Object.freeze({ ...unsigned, seal: createHmac("sha256", hostKey).update(JSON.stringify(unsigned)).digest("hex") });
}
