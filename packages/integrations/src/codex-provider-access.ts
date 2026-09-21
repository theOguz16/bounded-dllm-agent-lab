import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentEnvironmentSource } from "./agent-environment.js";

export type CodexProviderFailureCode =
  | "usage_limit_exceeded"
  | "authentication_failed"
  | "provider_overloaded"
  | "provider_stream_error_unknown";

const STOP_CODES = new Set<CodexProviderFailureCode>([
  "usage_limit_exceeded", "authentication_failed"
]);

export function normalizeCodexProviderFailure(error: unknown): CodexProviderFailureCode {
  const seen = new Set<unknown>();
  let candidate = error;
  for (let depth = 0; depth < 4 && candidate !== null && candidate !== undefined && !seen.has(candidate); depth += 1) {
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
    if (/\b(usage_limit_exceeded|insufficient_quota|billing_hard_limit_reached|quota_exceeded)\b/.test(text) ||
        /usage limit exceeded|you have hit your usage limit|quota has been exceeded/.test(text)) {
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
