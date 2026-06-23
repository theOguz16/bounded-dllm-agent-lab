import type { RepoPolicy } from "../../../packages/product-runtime/src/index.js";

export type PolicyValidationFinding = {
  severity: "warning" | "error";
  code: string;
  message: string;
};

export type PolicyValidationResult = {
  ok: boolean;
  errorCount: number;
  warningCount: number;
  findings: PolicyValidationFinding[];
  policy: RepoPolicy;
};

export const starterPolicyYaml = `# Bounded Agent policy
# Bu dosya agent'in hangi dosyalara dokunabilecegini, hangi sinirlarda durmasi
# gerektigini ve hangi lokal eksiklerin remask repair olarak isaretlenecegini
# tanimlar. Ilk surum icin dar baslayip takim ihtiyacina gore genisletmek daha
# sagliklidir.

allowed_paths:
  - "packages/**"
  - "apps/**"
  - "docs/**"
  - "package.json"
  - "package-lock.json"

  forbidden_paths:
  - ".env"
  - ".env.*"
  - "secrets/**"
  - "infra/production/**"

ownership:
  "packages/billing/**": "billing-team"
  "packages/auth/**": "auth-team"

paired_files:
  - source: "package.json"
    requires: "package-lock.json"
    reason: "npm package metadata changes must keep the lockfile in sync"

sensitive_patterns:
  - "SECRET"
  - "API_KEY"
  - "TOKEN="
  - "PRIVATE_KEY"

required_tests:

missing_authority_rules:
  - "Authority:"
`;

export function parsePolicy(content: string, path: string): RepoPolicy {
  if (path.endsWith(".json")) {
    return normalizePolicy(JSON.parse(content) as Partial<RepoPolicy>);
  }

  return normalizePolicy(parseSimpleYamlPolicy(content));
}

export function validatePolicy(policy: RepoPolicy): PolicyValidationResult {
  const findings: PolicyValidationFinding[] = [];

  if (!policy.allowed_paths.length) {
    findings.push({
      severity: "warning",
      code: "empty_allowed_paths",
      message: "allowed_paths is empty; every changed file will be treated as in-scope unless forbidden_paths catches it."
    });
  }

  if (!policy.forbidden_paths.length) {
    findings.push({
      severity: "warning",
      code: "empty_forbidden_paths",
      message: "forbidden_paths is empty; the runtime has no hard path boundary to reject."
    });
  }

  if (!(policy.sensitive_patterns ?? []).length) {
    findings.push({
      severity: "warning",
      code: "empty_sensitive_patterns",
      message: "sensitive_patterns is empty; secret-like patch text will not be flagged."
    });
  }

  for (const [index, rule] of (policy.paired_files ?? []).entries()) {
    if (!rule.source || !rule.requires) {
      findings.push({
        severity: "error",
        code: "invalid_paired_file_rule",
        message: `paired_files[${index}] must include both source and requires.`
      });
    }
    if (rule.source && rule.requires && rule.source === rule.requires) {
      findings.push({
        severity: "error",
        code: "self_paired_file_rule",
        message: `paired_files[${index}] points source and requires to the same file.`
      });
    }
  }

  const errorCount = findings.filter((finding) => finding.severity === "error").length;
  const warningCount = findings.filter((finding) => finding.severity === "warning").length;

  return {
    ok: errorCount === 0,
    errorCount,
    warningCount,
    findings,
    policy
  };
}

function normalizePolicy(policy: Partial<RepoPolicy>): RepoPolicy {
  return {
    allowed_paths: Array.isArray(policy.allowed_paths) ? policy.allowed_paths.map(String) : [],
    forbidden_paths: Array.isArray(policy.forbidden_paths) ? policy.forbidden_paths.map(String) : [],
    ownership: policy.ownership ?? {},
    paired_files: Array.isArray(policy.paired_files)
      ? policy.paired_files.map((rule) => ({
          source: String(rule.source ?? ""),
          requires: String(rule.requires ?? ""),
          reason: rule.reason ? String(rule.reason) : undefined
        }))
      : [],
    sensitive_patterns: Array.isArray(policy.sensitive_patterns) ? policy.sensitive_patterns.map(String) : [],
    required_tests: Array.isArray(policy.required_tests) ? policy.required_tests.map(String) : [],
    missing_authority_rules: Array.isArray(policy.missing_authority_rules) ? policy.missing_authority_rules.map(String) : []
  };
}

function parseSimpleYamlPolicy(content: string): Partial<RepoPolicy> {
  const policy: Partial<RepoPolicy> = {};
  const lines = content.split("\n");
  let section: keyof RepoPolicy | null = null;
  let currentPair: Record<string, string> | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    if (!rawLine.startsWith(" ") && line.endsWith(":")) {
      section = line.slice(0, -1) as keyof RepoPolicy;
      if (section === "paired_files") policy.paired_files = [];
      else if (section === "ownership") policy.ownership = {};
      else if (isArraySection(section)) (policy[section] as string[] | undefined) = [];
      currentPair = null;
      continue;
    }

    if (!section) continue;

    if (section === "paired_files") {
      if (line.startsWith("- ")) {
        currentPair = {};
        (policy.paired_files ??= []).push(currentPair as { source: string; requires: string; reason?: string });
        parsePairLine(line.slice(2), currentPair);
      } else if (currentPair) {
        parsePairLine(line, currentPair);
      }
      continue;
    }

    if (section === "ownership") {
      parseMapLine(line, policy.ownership ??= {});
      continue;
    }

    if (isArraySection(section) && line.startsWith("- ")) {
      ((policy[section] as string[] | undefined) ??= []).push(unquote(line.slice(2).trim()));
    }
  }

  return policy;
}

function parsePairLine(line: string, target: Record<string, string>): void {
  const [key, ...rest] = line.split(":");
  if (!key || !rest.length) return;
  target[key.trim()] = unquote(rest.join(":").trim());
}

function parseMapLine(line: string, target: Record<string, string>): void {
  const [key, ...rest] = line.split(":");
  if (!key || !rest.length) return;
  target[unquote(key.trim())] = unquote(rest.join(":").trim());
}

function isArraySection(section: keyof RepoPolicy): section is "allowed_paths" | "forbidden_paths" | "sensitive_patterns" | "required_tests" | "missing_authority_rules" {
  return section === "allowed_paths" ||
    section === "forbidden_paths" ||
    section === "sensitive_patterns" ||
    section === "required_tests" ||
    section === "missing_authority_rules";
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}
