export const AGENT_OUTPUT_REDACTION_VERSION = "agent-output-redaction/v1" as const;
export const AGENT_OUTPUT_REDACTED = "[REDACTED]" as const;

export type AgentOutputRedactionEnvironment = Readonly<Record<string, string | undefined>>;

export type AgentOutputRedactionOptions = Readonly<{
  environment?: AgentOutputRedactionEnvironment;
  secrets?: readonly string[];
}>;

export type AgentOutputRedactor = Readonly<{
  redactText(value: string): string;
  redactValue(value: unknown): unknown;
  containsKnownCredentialValue(value: string): boolean;
}>;

const CREDENTIAL_NAME =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret|password|credential|authorization|private[_-]?key)/i;

const PRIVATE_KEY =
  /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g;
const KNOWN_API_KEY =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[A-Z0-9]{16})\b/g;
const AUTHORIZATION_HEADER = /(\bAuthorization\s*[:=]\s*)[^\r\n]+/gi;
const BEARER_TOKEN = /(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCredentialFieldName(name: string): boolean {
  const normalized = name.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return (normalized.endsWith("token") && !normalized.endsWith("pertoken")) ||
    /secret|password|credential|apikey|authorization|privatekey/.test(normalized);
}

export function isCredentialEnvironmentVariable(name: string): boolean {
  return CREDENTIAL_NAME.test(name);
}

function collectKnownCredentialValues(options: AgentOutputRedactionOptions): readonly string[] {
  const values = new Set<string>();

  for (const value of options.secrets ?? []) {
    if (typeof value === "string" && value.length >= 4) values.add(value);
  }

  for (const [name, value] of Object.entries(options.environment ?? process.env)) {
    if (
      typeof value === "string" &&
      value.length >= 4 &&
      isCredentialEnvironmentVariable(name)
    ) {
      values.add(value);
    }
  }

  return Object.freeze(
    [...values].sort((left, right) => right.length - left.length)
  );
}

function redactKnownValues(value: string, secrets: readonly string[]): string {
  let output = value;
  for (const secret of secrets) output = output.replaceAll(secret, AGENT_OUTPUT_REDACTED);
  return output;
}

function redactCredentialAssignments(value: string): string {
  return value.split("\n").map((line) => {
    const prefixMatch = /^([+\- ]?)(.*)$/.exec(line);
    const prefix = prefixMatch?.[1] ?? "";
    const body = prefixMatch?.[2] ?? line;
    if (!CREDENTIAL_NAME.test(body)) return line;

    const separator = /[:=]/.exec(body);
    if (!separator || separator.index === undefined) return line;
    const head = body.slice(0, separator.index + 1);
    return `${prefix}${head} ${AGENT_OUTPUT_REDACTED}`;
  }).join("\n");
}

function redactTextWithSecrets(value: string, secrets: readonly string[]): string {
  let output = redactKnownValues(value, secrets);
  output = output
    .replace(PRIVATE_KEY, AGENT_OUTPUT_REDACTED)
    .replace(KNOWN_API_KEY, AGENT_OUTPUT_REDACTED)
    .replace(AUTHORIZATION_HEADER, `$1${AGENT_OUTPUT_REDACTED}`)
    .replace(BEARER_TOKEN, `$1${AGENT_OUTPUT_REDACTED}`);
  return redactCredentialAssignments(output);
}

function redactValueWithSecrets(
  value: unknown,
  secrets: readonly string[],
  seen: Set<object>,
  fieldName?: string
): unknown {
  if (fieldName && isCredentialFieldName(fieldName)) return AGENT_OUTPUT_REDACTED;
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactTextWithSecrets(value, secrets);
  if (typeof value === "undefined") return null;
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError("Agent output redaction only accepts JSON-compatible values.");
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Agent output redaction does not accept cyclic values.");
    seen.add(value);
    const output = value.map((item) => redactValueWithSecrets(item, secrets, seen));
    seen.delete(value);
    return output;
  }
  if (isObject(value)) {
    if (seen.has(value)) throw new TypeError("Agent output redaction does not accept cyclic values.");
    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = redactValueWithSecrets(item, secrets, seen, key);
    }
    seen.delete(value);
    return output;
  }
  throw new TypeError("Agent output redaction received an unsupported value.");
}

/**
 * Creates a boundary redactor for agent-controlled output.
 *
 * This must be applied when output is logged, surfaced, or serialized to a run
 * artifact. It must not be inserted before canonical hashing/signing/evidence
 * derivation that intentionally operates on the raw source value. Stored-file
 * integrity hashes may hash the already-redacted bytes because those hashes
 * describe the bytes that are actually persisted.
 */
export function createAgentOutputRedactor(
  options: AgentOutputRedactionOptions = {}
): AgentOutputRedactor {
  const secrets = collectKnownCredentialValues(options);

  return Object.freeze({
    redactText(value: string): string {
      if (typeof value !== "string") {
        throw new TypeError("Agent output text must be a string.");
      }
      return redactTextWithSecrets(value, secrets);
    },
    redactValue(value: unknown): unknown {
      return redactValueWithSecrets(value, secrets, new Set<object>());
    },
    containsKnownCredentialValue(value: string): boolean {
      return secrets.some((secret) => value.includes(secret));
    }
  });
}
