import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentEnvironmentSource } from "./agent-environment.js";
import type { AgentProviderFailureClass } from "./agent-adapter.js";

export type CodexProviderFailureCode =
  | "usage_limit_exceeded"
  | "authentication_failed"
  | "provider_overloaded"
  | "provider_stream_error_unknown";

const STOP_CODES = new Set<CodexProviderFailureCode>([
  "usage_limit_exceeded", "authentication_failed"
]);

function structuredError(value: unknown): unknown {
  if (typeof value !== "string") return value;
  // Worker stderr may include a warning before its final structured error.
  for (const line of value.trim().split(/\r?\n/).slice(-8).reverse()) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch { /* Ignore non-JSON diagnostic lines. */ }
  }
  return value;
}

/** Inspect only known error fields. The returned value contains no input text. */
export function classifyCodexProviderError(error: unknown): Readonly<{
  failureClass: AgentProviderFailureClass;
  httpStatus: number | null;
}> {
  const value = structuredError(error);
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
  const nested = record?.error && typeof record.error === "object" && !Array.isArray(record.error)
    ? record.error as Record<string, unknown> : null;
  const rawStatus = record?.status ?? nested?.status;
  const httpStatus = typeof rawStatus === "number" && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599
    ? rawStatus : null;
  const code = typeof (record?.code ?? nested?.code) === "string"
    ? String(record?.code ?? nested?.code).slice(0, 128).toLowerCase() : "";
  const message = typeof value === "string" ? value :
    typeof (record?.message ?? nested?.message) === "string" ? String(record?.message ?? nested?.message) : "";
  const text = `${code} ${message}`.toLowerCase().slice(0, 4096);
  let failureClass: AgentProviderFailureClass = "unknown";
  if (httpStatus === 401 || /\b(authentication_failed|invalid_api_key|unauthorized|missing bearer|bearer token missing)\b/.test(text)) {
    failureClass = "auth";
  } else if (httpStatus === 429 || /\b(usage_limit_exceeded|insufficient_quota|billing_hard_limit_reached|quota_exceeded|rate_limit_exceeded|rate_limit_error)\b|usage limit exceeded|rate limit exceeded/.test(text)) {
    failureClass = "quota";
  } else if (/\b(model_not_found|unsupported_model|model_unsupported|invalid_model)\b|model[^\n]{0,100}\b(not found|unsupported|not supported|not available)\b/.test(text)) {
    failureClass = "model_unsupported";
  } else if (httpStatus === 413 || /\b(context_length_exceeded|input_too_large|request_too_large|prompt_too_long)\b|maximum context length|context window[^\n]{0,80}exceed|input[^\n]{0,80}too large/.test(text)) {
    failureClass = "context_input_too_large";
  } else if (httpStatus === 503 || /\b(server_overloaded|provider_overloaded|overloaded_error)\b|server (is )?overloaded|temporarily overloaded/.test(text)) {
    failureClass = "capacity_overload";
  }
  return { failureClass, httpStatus };
}

export function normalizeCodexProviderFailure(error: unknown): CodexProviderFailureCode {
  const seen = new Set<unknown>();
  let candidate = error;
  for (let depth = 0; depth < 4 && candidate !== null && candidate !== undefined && !seen.has(candidate); depth += 1) {
    candidate = structuredError(candidate);
    seen.add(candidate);
    if (typeof candidate !== "object" && typeof candidate !== "string") break;
    const record = typeof candidate === "object" ? candidate as Record<string, unknown> : null;
    const nestedError = record?.error && typeof record.error === "object"
      ? record.error as Record<string, unknown> : null;
    const status = record?.status ?? record?.statusCode ?? nestedError?.status;
    const code = String(record?.code ?? nestedError?.code ?? "");
    const message = typeof candidate === "string" ? candidate : String(record?.message ?? nestedError?.message ?? "");
    const text = `${code} ${message}`.toLowerCase();
    if (status === 401 || /\b(authentication_failed|invalid_api_key|unauthorized|missing bearer|bearer token missing)\b/.test(text)) {
      return "authentication_failed";
    }
    if (status === 429 || /\b(usage_limit_exceeded|insufficient_quota|billing_hard_limit_reached|quota_exceeded|rate_limit_exceeded|rate_limit_error)\b/.test(text) ||
        /usage limit exceeded|you have hit your usage limit|quota has been exceeded|rate limit exceeded/.test(text)) {
      return "usage_limit_exceeded";
    }
    if (status === 503 || /\b(server_overloaded|provider_overloaded|overloaded_error)\b/.test(text) ||
        /server (is )?overloaded|temporarily overloaded/.test(text)) {
      return "provider_overloaded";
    }
    candidate = record?.cause;
  }
  return "provider_stream_error_unknown";
}

export type CodexLocalAuthCheck = (environment: AgentEnvironmentSource) => Promise<boolean>;

export async function codexLocalAuthCheck(environment: AgentEnvironmentSource): Promise<boolean> {
  // Presence is not proof of a valid token or available quota. Never read or log a token.
  for (const name of ["CODEX_API_KEY", "OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"] as const) {
    if (environment[name]?.trim()) return true;
  }
  const home = environment.CODEX_HOME?.trim() || path.join(environment.HOME || os.homedir(), ".codex");
  try {
    const metadata = await stat(path.join(home, "auth.json"));
    return metadata.isFile() && metadata.size > 0;
  } catch {
    return false;
  }
}

export class CodexProviderAccessGate {
  readonly quota = "unknown" as const;
  private stopped: CodexProviderFailureCode | null = null;

  constructor(
    private readonly environment: AgentEnvironmentSource,
    private readonly authCheck: CodexLocalAuthCheck = codexLocalAuthCheck
  ) {}

  async preflight(): Promise<CodexProviderFailureCode | null> {
    if (this.stopped !== null) return this.stopped;
    // Local check only. Do not turn unknown quota into available.
    if (!(await this.authCheck(this.environment))) {
      this.stopped = "authentication_failed";
    }
    return this.stopped;
  }

  observe(error: unknown): CodexProviderFailureCode {
    const code = normalizeCodexProviderFailure(error);
    if (STOP_CODES.has(code)) this.stopped = code;
    return code;
  }

  stoppedCode(): CodexProviderFailureCode | null {
    return this.stopped;
  }
}
