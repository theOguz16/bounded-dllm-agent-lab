export type CliJson = Record<string, unknown>;

function isCredentialField(key: string): boolean {
  const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return (normalized.endsWith("token") && !normalized.endsWith("pertoken")) ||
    /secret|password|credential|apikey|authorization/.test(normalized);
}

export function collectCliSecrets(environment: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(environment)
    .filter(([name, value]) =>
      typeof value === "string" &&
      value.length >= 4 &&
      /(?:key|token|secret|credential|password)/i.test(name)
    )
    .map(([, value]) => value as string);
}

export function redactCliValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return secrets.reduce(
      (text, secret) => secret.length >= 4 ? text.replaceAll(secret, "[REDACTED]") : text,
      value
    );
  }
  if (Array.isArray(value)) return value.map((item) => redactCliValue(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as CliJson).map(([key, item]) => [
        key,
        isCredentialField(key) ? "[REDACTED]" : redactCliValue(item, secrets)
      ])
    );
  }
  return value;
}

function emitDoctorOutput(value: CliJson): boolean {
  if (value.command !== "doctor" || !Array.isArray(value.checks)) return false;
  const sections = ["Environment", "Repository", "Codex", "Validation"];
  for (const section of sections) {
    process.stdout.write(`${section}\n`);
    const checks = value.checks.filter((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      return (candidate as CliJson).section === section;
    });
    for (const candidate of checks) {
      const item = candidate as CliJson;
      const ok = item.ok === true;
      const suffix = !ok && typeof item.detail === "string" ? ` — ${item.detail}` : "";
      process.stdout.write(`${ok ? "✓" : "✗"} ${String(item.label)}${suffix}\n`);
    }
    if (section !== sections[sections.length - 1]) process.stdout.write("\n");
  }
  return true;
}

function readableBytes(value: unknown): string {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return "unavailable";
  const bytes = value as number;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round((bytes / 1024) * 10) / 10} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

function tokenValue(value: unknown): string {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? String(value) : "unavailable";
}

function emitCodexOutput(value: CliJson): boolean {
  if (value.command !== "codex") return false;
  const context = value.context && typeof value.context === "object" && !Array.isArray(value.context)
    ? value.context as CliJson : {};
  const tokens = value.tokens && typeof value.tokens === "object" && !Array.isArray(value.tokens)
    ? value.tokens as CliJson : {};
  const candidate = value.candidate && typeof value.candidate === "object" && !Array.isArray(value.candidate)
    ? value.candidate as CliJson : {};
  const validation = value.validation && typeof value.validation === "object" && !Array.isArray(value.validation)
    ? value.validation as CliJson : {};
  const count = Number.isSafeInteger(context.fileCount) ? Number(context.fileCount) : 0;
  const changed = Number.isSafeInteger(candidate.changedFileCount)
    ? Number(candidate.changedFileCount) : 0;

  process.stdout.write("Agent\n");
  process.stdout.write(`${String(value.agent ?? "Codex")}\n\n`);
  process.stdout.write("Model\n");
  process.stdout.write(`${String(value.model ?? "unavailable")}\n\n`);
  process.stdout.write("Reasoning\n");
  process.stdout.write(`${String(value.reasoning ?? "unavailable")}\n\n`);
  process.stdout.write("Context\n");
  process.stdout.write(`${count} ${count === 1 ? "file" : "files"} / ${readableBytes(context.bytes)}\n\n`);
  process.stdout.write("Tokens\n");
  process.stdout.write(`input ${tokenValue(tokens.input)}\n`);
  process.stdout.write(`cached ${tokenValue(tokens.cached)}\n`);
  process.stdout.write(`output ${tokenValue(tokens.output)}\n`);
  process.stdout.write(`reasoning ${tokenValue(tokens.reasoning)}\n`);
  process.stdout.write(`total ${tokenValue(tokens.total)}\n\n`);
  process.stdout.write("Candidate\n");
  process.stdout.write(`${changed} ${changed === 1 ? "file" : "files"} changed\n\n`);
  process.stdout.write("Validation\n");
  process.stdout.write(`scope ${String(validation.scope ?? "NOT_RUN")}\n`);
  process.stdout.write(`typecheck ${String(validation.typecheck ?? "NOT_RUN")}\n`);
  process.stdout.write(`tests ${String(validation.tests ?? "NOT_RUN")}\n`);
  process.stdout.write(`behavior ${String(validation.behavior ?? "NOT_DEMONSTRATED")}\n\n`);
  process.stdout.write("Apply\n");
  process.stdout.write(`${String(value.apply ?? "NOT_RUN")}\n`);
  if (value.failure && typeof value.failure === "object" && !Array.isArray(value.failure)) {
    const failure = value.failure as CliJson;
    process.stdout.write(`\nfailure: ${String(failure.code)} — ${String(failure.message)}\n`);
  }
  return true;
}

export function emitCliOutput(value: CliJson, json: boolean, secrets: readonly string[]): void {
  const safe = redactCliValue(value, secrets) as CliJson;
  if (json) {
    process.stdout.write(`${JSON.stringify(safe)}\n`);
    return;
  }
  if (emitDoctorOutput(safe)) return;
  if (emitCodexOutput(safe)) return;
  process.stdout.write(`${safe.ok ? "OK" : "STOPPED"}: ${safe.command ?? "error"} ${safe.taskId ?? ""}\n`);
  for (const field of ["mode", "state", "decision", "route", "outcome", "receiptHash", "nextStep"]) {
    if (safe[field] !== undefined && safe[field] !== null) {
      process.stdout.write(`${field}: ${String(safe[field])}\n`);
    }
  }
  if (safe.failure) {
    process.stdout.write(
      `failure: ${String((safe.failure as CliJson).code)} — ${String((safe.failure as CliJson).message)}\n`
    );
  }
}

export function emitCliError(value: CliJson, json: boolean, secrets: readonly string[]): void {
  const safe = redactCliValue(value, secrets) as CliJson;
  if (json) process.stdout.write(`${JSON.stringify(safe)}\n`);
  else process.stderr.write(`ERROR ${String(safe.code)}: ${String(safe.message)}\n`);
}
