export const AGENT_ENVIRONMENT_VERSION = "agent-environment/v1" as const;

export const AGENT_ENVIRONMENT_ALLOWED_NAMES = Object.freeze([
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "TMPDIR",
  "TERM",
  "CODEX_HOME",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN"
] as const);

export const AGENT_ENVIRONMENT_ALLOWED_PREFIXES = Object.freeze([
  "LC_"
] as const);

const EXACT_ALLOWED = new Set<string>(AGENT_ENVIRONMENT_ALLOWED_NAMES);

export type AgentEnvironmentSource = Readonly<Record<string, string | undefined>>;
export type AgentEnvironment = Readonly<Record<string, string>>;

function isPathVariable(name: string): boolean {
  return name.toUpperCase() === "PATH";
}

export function isAllowedAgentEnvironmentVariable(name: string): boolean {
  if (isPathVariable(name)) return true;
  if (EXACT_ALLOWED.has(name)) return true;
  return AGENT_ENVIRONMENT_ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function createAgentEnvironment(
  source: AgentEnvironmentSource = process.env
): AgentEnvironment {
  const environment: Record<string, string> = {};

  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    if (!isAllowedAgentEnvironmentVariable(name)) continue;
    environment[name] = value;
  }

  return Object.freeze(environment);
}
