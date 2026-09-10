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

export function emitCliOutput(value: CliJson, json: boolean, secrets: readonly string[]): void {
  const safe = redactCliValue(value, secrets) as CliJson;
  if (json) {
    process.stdout.write(`${JSON.stringify(safe)}\n`);
    return;
  }
  if (emitDoctorOutput(safe)) return;
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
