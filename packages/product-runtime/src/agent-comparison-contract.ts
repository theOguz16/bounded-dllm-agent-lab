export const AGENT_COMPARISON_VERSION = "agent-comparison/v1" as const;
/** Opt-in envelope for real provider comparisons; legacy v1 remains unchanged. */
export const AGENT_COMPARISON_PROVIDER_VERSION = "agent-comparison/v2" as const;

export const AGENT_COMPARISON_ARMS = Object.freeze([
  "baseline",
  "bounded"
] as const);

export const AGENT_COMPARABLE_IDENTITY_FIELDS = Object.freeze([
  "taskHash",
  "sourceRepositorySnapshotHash",
  "sourceCommitSha",
  "agentId",
  "agentVersion",
  "modelId",
  "reasoningEffort",
  "validationSpecHash",
  "networkPolicy",
  "timeoutBudget"
] as const);

export const AGENT_PROVIDER_IDENTITY_FIELDS = Object.freeze([
  "providerId", "accountAlias", "authMode"
] as const);

export type AgentComparisonArm = (typeof AGENT_COMPARISON_ARMS)[number];
export type AgentComparableIdentityField =
  | (typeof AGENT_COMPARABLE_IDENTITY_FIELDS)[number]
  | (typeof AGENT_PROVIDER_IDENTITY_FIELDS)[number];

export type AgentComparableIdentity = Readonly<{
  taskHash: string;
  sourceRepositorySnapshotHash: string;
  sourceCommitSha: string;
  agentId: string;
  agentVersion: string;
  modelId: string;
  reasoningEffort: string;
  validationSpecHash: string;
  networkPolicy: string;
  timeoutBudget: number;
}>;

export type AgentComparableProviderIdentity = AgentComparableIdentity & Readonly<{
  providerId: string;
  accountAlias: string;
  authMode: "api_key" | "codex_home";
}>;

export type AgentComparisonArmRecord = (AgentComparableIdentity | AgentComparableProviderIdentity) & Readonly<{
  arm: AgentComparisonArm;
}>;

export type AgentComparisonContract = Readonly<{
  schemaVersion: typeof AGENT_COMPARISON_VERSION | typeof AGENT_COMPARISON_PROVIDER_VERSION;
  arms: Readonly<{
    baseline: AgentComparisonArmRecord;
    bounded: AgentComparisonArmRecord;
  }>;
  comparable: boolean;
  identityMismatchFields: readonly AgentComparableIdentityField[];
}>;

export class AgentComparisonContractError extends Error {
  readonly code = "agent_comparison_contract_invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "AgentComparisonContractError";
  }
}

const IDENTITY_KEYS = [...AGENT_COMPARABLE_IDENTITY_FIELDS].sort();
const PROVIDER_KEYS = [...AGENT_COMPARABLE_IDENTITY_FIELDS, ...AGENT_PROVIDER_IDENTITY_FIELDS].sort();
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_IDENTITY_TEXT = 256;
const SAFE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_PROVIDER = /^[a-z][a-z0-9_-]{0,63}$/;

function fail(message: string): never {
  throw new AgentComparisonContractError(message);
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(`${label} must be a plain data object.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return fail(`${label} must not contain symbol properties.`);
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) return fail(`${label} must not contain accessors.`);
  }
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTITY_TEXT ||
    value.trim() !== value ||
    CONTROL.test(value)
  ) {
    return fail(`${field} must be a bounded non-empty string.`);
  }
  return value;
}

function sha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    return fail(`${field} must be a sha256: prefixed lowercase SHA-256 hash.`);
  }
  return value;
}

function gitSha(value: unknown): string {
  if (typeof value !== "string" || !GIT_SHA.test(value)) {
    return fail("sourceCommitSha must be a lowercase 40- or 64-character Git commit SHA.");
  }
  return value;
}

function normalizeIdentity(value: unknown, label: string, providerPinned: boolean): AgentComparableIdentity | AgentComparableProviderIdentity {
  const record = plainObject(value, label);
  const expected = providerPinned ? PROVIDER_KEYS : IDENTITY_KEYS;
  if (Object.keys(record).sort().join("\u0000") !== expected.join("\u0000")) {
    return fail(`${label} must contain the exact comparable identity fields.`);
  }
  if (!Number.isSafeInteger(record.timeoutBudget) || Number(record.timeoutBudget) <= 0) {
    return fail(`${label}.timeoutBudget must be a positive safe integer.`);
  }

  const common: AgentComparableIdentity = {
    taskHash: sha256(record.taskHash, `${label}.taskHash`),
    sourceRepositorySnapshotHash: sha256(
      record.sourceRepositorySnapshotHash,
      `${label}.sourceRepositorySnapshotHash`
    ),
    sourceCommitSha: gitSha(record.sourceCommitSha),
    agentId: boundedText(record.agentId, `${label}.agentId`),
    agentVersion: boundedText(record.agentVersion, `${label}.agentVersion`),
    modelId: boundedText(record.modelId, `${label}.modelId`),
    reasoningEffort: boundedText(record.reasoningEffort, `${label}.reasoningEffort`),
    validationSpecHash: sha256(record.validationSpecHash, `${label}.validationSpecHash`),
    networkPolicy: boundedText(record.networkPolicy, `${label}.networkPolicy`),
    timeoutBudget: Number(record.timeoutBudget)
  };
  if (!providerPinned) return Object.freeze(common);
  const providerId = boundedText(record.providerId, `${label}.providerId`);
  const accountAlias = boundedText(record.accountAlias, `${label}.accountAlias`);
  if (!SAFE_PROVIDER.test(providerId) || !SAFE_ALIAS.test(accountAlias)) {
    return fail(`${label} providerId/accountAlias must use non-secret safe identifiers.`);
  }
  if (record.authMode !== "api_key" && record.authMode !== "codex_home") {
    return fail(`${label}.authMode must be api_key or codex_home.`);
  }
  return Object.freeze({ ...common, providerId, accountAlias, authMode: record.authMode });
}

function armRecord(arm: AgentComparisonArm, identity: AgentComparableIdentity | AgentComparableProviderIdentity): AgentComparisonArmRecord {
  return Object.freeze({ arm, ...identity });
}

/** Legacy v1 identities are accepted only when BOTH arms use the exact v1 shape.
 * A provider-pinned comparison must provide all three non-secret provider fields
 * on both arms; partial/mixed identities fail closed rather than dropping fields.
 */
export function createAgentComparisonContract(input: Readonly<{
  baseline: AgentComparableIdentity | AgentComparableProviderIdentity;
  bounded: AgentComparableIdentity | AgentComparableProviderIdentity;
}>): AgentComparisonContract {
  const record = plainObject(input, "Agent comparison input");
  const keys = Object.keys(record).sort();
  if (keys.join("\u0000") !== "baseline\u0000bounded") {
    return fail("Agent comparison input must contain exactly baseline and bounded arms.");
  }

  const baselineFields = Object.keys(plainObject(record.baseline, "baseline")).sort().join("\u0000");
  const boundedFields = Object.keys(plainObject(record.bounded, "bounded")).sort().join("\u0000");
  const providerPinned = baselineFields === PROVIDER_KEYS.join("\u0000") || boundedFields === PROVIDER_KEYS.join("\u0000");
  if (baselineFields !== boundedFields) {
    return fail("Both arms must supply matching exact comparable identity fields; never downgrade provider identity.");
  }
  const baseline = normalizeIdentity(record.baseline, "baseline", providerPinned);
  const bounded = normalizeIdentity(record.bounded, "bounded", providerPinned);
  const fields = providerPinned
    ? [...AGENT_COMPARABLE_IDENTITY_FIELDS, ...AGENT_PROVIDER_IDENTITY_FIELDS]
    : [...AGENT_COMPARABLE_IDENTITY_FIELDS];
  const identityMismatchFields = fields.filter(
    (field) => baseline[field as keyof AgentComparableIdentity] !== bounded[field as keyof AgentComparableIdentity]
  );

  return Object.freeze({
    schemaVersion: providerPinned ? AGENT_COMPARISON_PROVIDER_VERSION : AGENT_COMPARISON_VERSION,
    arms: Object.freeze({
      baseline: armRecord("baseline", baseline),
      bounded: armRecord("bounded", bounded)
    }),
    comparable: identityMismatchFields.length === 0,
    identityMismatchFields: Object.freeze([...identityMismatchFields])
  });
}
