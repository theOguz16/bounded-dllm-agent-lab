import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parsePolicy, starterPolicyYaml, validatePolicy } from "./product-policy-utils.js";

const args = parseArgs(process.argv.slice(2));
if (args.help === "true" || args.h === "true") {
  printHelp();
  process.exit(0);
}

const format = parseFormat(args.format ?? "json");

if (args.init === "true") {
  const outPath = args.out ?? "bounded-agent.policy.yml";
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, starterPolicyYaml);

  const policy = parsePolicy(starterPolicyYaml, outPath);
  const validation = validatePolicy(policy);
  const summary = {
    ok: validation.ok,
    mode: "init",
    policyPath: outPath,
    warningCount: validation.warningCount,
    errorCount: validation.errorCount,
    qualityScore: validation.qualityScore,
    qualityGrade: validation.qualityGrade,
    findings: validation.findings
  };

  printFormatted(summary, createPolicyMarkdown("init", outPath, validation), format);
  process.exit(validation.ok ? 0 : 1);
}

if (args.validate === "true") {
  const policyPath = requireArg(args, "policy");
  const content = await readFile(policyPath, "utf8");
  const validation = validatePolicy(parsePolicy(content, policyPath));
  const summary = {
    ok: validation.ok,
    mode: "validate",
    policyPath,
    warningCount: validation.warningCount,
    errorCount: validation.errorCount,
    qualityScore: validation.qualityScore,
    qualityGrade: validation.qualityGrade,
    findings: validation.findings,
    normalizedPolicy: validation.policy
  };

  printFormatted(summary, createPolicyMarkdown("validate", policyPath, validation), format);
  process.exit(validation.ok ? 0 : 1);
}

throw new Error("Choose either --init or --validate. Run with --help for usage.");

function parseArgs(values: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];

    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }

    parsed[key] = next;
    index += 1;
  }

  return parsed;
}

function requireArg(args: Record<string, string>, key: string): string {
  const value = args[key];
  if (!value) throw new Error(`Missing required argument --${key}`);
  return value;
}

function parseFormat(value: string): "json" | "markdown" | "both" {
  if (value === "json" || value === "markdown" || value === "both") return value;
  throw new Error(`Unknown --format value: ${value}`);
}

function printFormatted(summary: unknown, markdown: string, value: "json" | "markdown" | "both"): void {
  if (value === "json" || value === "both") {
    console.log(JSON.stringify(summary, null, 2));
  }
  if (value === "markdown" || value === "both") {
    console.log(markdown);
  }
}

function createPolicyMarkdown(
  mode: "init" | "validate",
  policyPath: string,
  validation: ReturnType<typeof validatePolicy>
): string {
  const findingRows = validation.findings.length
    ? validation.findings.map((finding) => [finding.severity, finding.code, finding.message])
    : [["info", "no_findings", "Policy validation passed without findings."]];

  return [
    "# Bounded Agent Policy Validation",
    "",
    `- Mode: ${mode}`,
    `- Policy: ${policyPath}`,
    `- OK: ${validation.ok ? "yes" : "no"}`,
    `- Errors: ${validation.errorCount}`,
    `- Warnings: ${validation.warningCount}`,
    `- Quality score: ${Math.round(validation.qualityScore * 100)}%`,
    `- Quality grade: ${validation.qualityGrade}`,
    "",
    "## Findings",
    "",
    table(["Severity", "Code", "Message"], findingRows),
    "",
    "## Policy Shape",
    "",
    table(
      ["Section", "Count"],
      [
        ["allowed_paths", validation.policy.allowed_paths.length.toString()],
        ["forbidden_paths", validation.policy.forbidden_paths.length.toString()],
        ["paired_files", (validation.policy.paired_files ?? []).length.toString()],
        ["owner_aliases", Object.keys(validation.policy.owner_aliases ?? {}).length.toString()],
        ["sensitive_patterns", (validation.policy.sensitive_patterns ?? []).length.toString()],
        ["required_tests", (validation.policy.required_tests ?? []).length.toString()],
        ["required_test_mappings", (validation.policy.required_test_mappings ?? []).length.toString()],
        ["missing_authority_rules", (validation.policy.missing_authority_rules ?? []).length.toString()]
      ]
    )
  ].join("\n");
}

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`)
  ].join("\n");
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function printHelp(): void {
  console.log(`Bounded Agent Policy

Usage:
  npm run product:policy -- --init --out bounded-agent.policy.yml
  npm run product:policy -- --validate --policy bounded-agent.policy.yml

Options:
  --init             Create a starter policy file.
  --validate         Validate an existing policy file.
  --out <path>       Output path for --init. Default: bounded-agent.policy.yml
  --policy <path>    Policy path for --validate.
  --format <value>   Console output: json, markdown, both. Default: json
  --help             Show this help.
`);
}
