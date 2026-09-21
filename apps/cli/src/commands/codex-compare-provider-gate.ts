import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentAdapter, AgentRunRequest, AgentRunResult } from "../../../../packages/integrations/src/agent-adapter.js";
import { normalizeCodexProviderFailure } from "../../../../packages/integrations/src/codex-provider-access.js";

export type CompareProviderIdentity = Readonly<{
  providerId: "codex";
  accountAlias: string;
  authMode: "api_key" | "codex_home";
}>;
export type CompareProviderStopCode =
  | "usage_limit_exceeded" | "authentication_failed" | "provider_overloaded"
  | "provider_stream_error_unknown" | "provider_identity_changed";
type Arm = "baseline" | "bounded";
type AuthState = string | Readonly<{ home: string; ino: number; size: number; mtimeMs: number; ctimeMs: number }>;
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const FAILURE_CODES = new Set<string>([
  "usage_limit_exceeded", "authentication_failed", "provider_overloaded", "provider_stream_error_unknown"
]);

function failure(code: CompareProviderStopCode): Error & { code: CompareProviderStopCode } {
  return Object.assign(new Error(code), { code });
}

/** A local operator assertion, never a claim that the provider verified the account. */
function identityOf(env: NodeJS.ProcessEnv): CompareProviderIdentity {
  const alias = env.BOUNDED_CODEX_ACCOUNT_ALIAS;
  const mode = env.BOUNDED_CODEX_AUTH_MODE;
  if (!alias || !ALIAS.test(alias) || (mode !== "api_key" && mode !== "codex_home")) {
    throw failure("authentication_failed");
  }
  return Object.freeze({ providerId: "codex", accountAlias: alias, authMode: mode });
}

function authState(env: NodeJS.ProcessEnv, mode: CompareProviderIdentity["authMode"]): AuthState {
  if (mode === "api_key") {
    const keys = [env.CODEX_API_KEY, env.OPENAI_API_KEY].filter((value): value is string =>
      typeof value === "string" && value.trim().length > 0
    );
    // Ambiguous credentials make local account identity impossible to pin.
    if (!keys.length || keys.some((value) => /\s/.test(value) || value !== keys[0])) {
      throw failure("authentication_failed");
    }
    return keys[0]!; // Process-local equality only; never logged, serialized or hashed.
  }
  if ([env.CODEX_API_KEY, env.OPENAI_API_KEY, env.CODEX_ACCESS_TOKEN].some((key) => key?.trim())) {
    throw failure("authentication_failed");
  }
  const home = path.resolve(env.CODEX_HOME?.trim() || path.join(env.HOME || os.homedir(), ".codex"));
  try {
    const stat = statSync(path.join(home, "auth.json"));
    if (!stat.isFile() || stat.size <= 0) throw failure("authentication_failed");
    return { home, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
  } catch {
    throw failure("authentication_failed");
  }
}

function sameState(a: AuthState, b: AuthState): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  return a.home === b.home && a.ino === b.ino && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function rejected(request: AgentRunRequest, adapter: AgentAdapter, code: CompareProviderStopCode): AgentRunResult {
  return {
    status: "rejected", failureCode: FAILURE_CODES.has(code) ? code as AgentRunResult["failureCode"] : null,
    quotaStatus: "unknown", agentId: adapter.agentId, agentVersion: adapter.agentVersion,
    modelId: request.model, durationMs: 0, finalMessage: "",
    usage: { inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null },
    commands: [], fileChanges: [], diagnostics: [{ code, severity: "error", message: code, retryable: false }]
  };
}

/** One instance MUST wrap the adapter used by discovery, Normal and Bounded. */
export class CodexCompareProviderGate {
  readonly quota = "unknown" as const;
  readonly identity: CompareProviderIdentity;
  private readonly initialAuth: AuthState;
  private readonly observations: Partial<Record<Arm, CompareProviderIdentity>> = {};
  private terminal: CompareProviderStopCode | null = null;

  constructor(
    private readonly model: string,
    private readonly reasoning: string,
    private readonly environment: () => NodeJS.ProcessEnv = () => process.env
  ) {
    if (!MODEL.test(model) || reasoning !== "none") throw failure("authentication_failed");
    const env = environment();
    this.identity = identityOf(env);
    this.initialAuth = authState(env, this.identity.authMode);
  }

  /** Local only: no provider request and no representation of quota as available. */
  preflight(): void { this.verify(); }

  private verify(): CompareProviderIdentity {
    if (this.terminal) throw failure(this.terminal);
    const env = this.environment();
    let current: CompareProviderIdentity;
    try { current = identityOf(env); } catch { this.terminal = "authentication_failed"; throw failure(this.terminal); }
    if (current.accountAlias !== this.identity.accountAlias || current.authMode !== this.identity.authMode ||
        (env.BOUNDED_CODEX_MODEL && env.BOUNDED_CODEX_MODEL !== this.model) ||
        (env.CODEX_MODEL && env.CODEX_MODEL !== this.model)) {
      this.terminal = "provider_identity_changed";
      throw failure(this.terminal);
    }
    try {
      if (!sameState(this.initialAuth, authState(env, current.authMode))) {
        this.terminal = "provider_identity_changed";
        throw failure(this.terminal);
      }
    } catch (error) {
      if (this.terminal !== "provider_identity_changed") this.terminal = "authentication_failed";
      throw error;
    }
    return current;
  }

  private remember(arm: Arm): void {
    try { this.observations[arm] = identityOf(this.environment()); }
    catch { /* Unknown identity is never manufactured or logged. */ }
  }

  armIdentity(arm: Arm): CompareProviderIdentity {
    return this.observations[arm] ?? this.identity;
  }

  stoppedCode(): CompareProviderStopCode | null { return this.terminal; }

  wrap(adapter: AgentAdapter): AgentAdapter {
    return Object.freeze({
      agentId: adapter.agentId, agentVersion: adapter.agentVersion,
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        const arm: Arm | null = request.mode === "baseline" ? "baseline" :
          request.mode === "discovery" ? null : "bounded";
        if (arm) this.remember(arm);
        try { this.verify(); }
        catch { return rejected(request, adapter, this.terminal ?? "authentication_failed"); }

        let result: AgentRunResult;
        try { result = await adapter.run(request); }
        catch (error) {
          const code = normalizeCodexProviderFailure(error);
          this.terminal = code;
          return rejected(request, adapter, code);
        }
        // A provider exception or stream may have started a charge. Never repeat an
        // uncertain invocation or attempt the other arm after a terminal failure.
        if (result.status !== "completed" || result.diagnostics.some((item) => item.severity === "error")) {
          const observed = result.failureCode ?? result.diagnostics.find((item) => item.severity === "error")?.code ?? "";
          const canonical = observed === "codex_provider_auth" ? "authentication_failed"
            : observed === "codex_provider_quota" ? "usage_limit_exceeded"
            : observed === "codex_provider_capacity" ? "provider_overloaded"
            : observed;
          this.terminal = FAILURE_CODES.has(canonical)
            ? canonical as CompareProviderStopCode : "provider_stream_error_unknown";
        }
        if (!this.terminal) {
          try { this.verify(); }
          catch { return rejected(request, adapter, this.terminal ?? "provider_identity_changed"); }
        }
        return result;
      }
    });
  }
}
