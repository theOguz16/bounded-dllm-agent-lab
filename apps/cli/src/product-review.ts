import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  parseUnifiedDiff,
  reviewPatch,
  type RepoPolicy,
  type TaskSpec
} from "../../../packages/product-runtime/src/index.js";

const args = parseArgs(process.argv.slice(2));
if (args.help === "true" || args.h === "true") {
  printHelp();
  process.exit(0);
}

const taskPath = requireArg(args, "task");
const diffPath = requireArg(args, "diff");
const policyPath = requireArg(args, "policy");
const outDir = args["out-dir"] ?? "reports/product-runtime";
const format = parseFormat(args.format ?? "json");
const failOn = parseFailOn(args["fail-on"] ?? "never");

const task = parseTask(await readFile(taskPath, "utf8"), taskPath);
const diff = parseUnifiedDiff(await readFile(diffPath, "utf8"));
const policy = parsePolicy(await readFile(policyPath, "utf8"), policyPath);
const output = reviewPatch({ task, diff, policy });
const baseName = `${new Date().toISOString().replace(/[:.]/g, "-")}-product-review`;
const jsonPath = join(outDir, `${baseName}.json`);
const markdownPath = join(outDir, `${baseName}.md`);

await mkdir(dirname(jsonPath), { recursive: true });
await writeFile(jsonPath, `${JSON.stringify(output, null, 2)}\n`);
await writeFile(markdownPath, `${output.markdownReport}\n`);

const summary = {
  ok: true,
  decision: output.decision,
  riskLevel: output.riskLevel,
  findingCount: output.findings.length,
  metrics: output.metrics,
  remaskRegionCount: output.remaskRegions.length,
  jsonPath,
  markdownPath
};

if (format === "json" || format === "both") {
  console.log(JSON.stringify(summary, null, 2));
}

if (format === "markdown" || format === "both") {
  console.log(output.markdownReport);
}

if (shouldFail(failOn, output.riskLevel)) {
  process.exitCode = 1;
}

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
  if (!value) {
    throw new Error(`Missing required argument --${key}`);
  }
  return value;
}

function printHelp(): void {
  console.log(`Bounded Agent Product Review

Usage:
  npm run product:review -- --task task.md --diff patch.diff --policy policy.yml [options]

Required:
  --task <path>       Markdown or JSON task file.
  --diff <path>       Unified diff file.
  --policy <path>     JSON or simple YAML policy file.

Options:
  --out-dir <path>    Artifact output directory. Default: reports/product-runtime
  --format <value>    Console output: json, markdown, both. Default: json
  --fail-on <value>   CI exit behavior: high, medium, never. Default: never
  --help              Show this help.

Examples:
  npm run product:review -- --task examples/product-runtime/tasks/release-metadata.md --diff examples/product-runtime/diffs/remask-required.diff --policy examples/product-runtime/policies/release-policy.yml
  npm run product:review -- --task task.md --diff patch.diff --policy policy.yml --fail-on high --format both
`);
}

function parseFormat(value: string): "json" | "markdown" | "both" {
  if (value === "json" || value === "markdown" || value === "both") return value;
  throw new Error(`Unknown --format value: ${value}`);
}

function parseFailOn(value: string): "high" | "medium" | "never" {
  if (value === "high" || value === "medium" || value === "never") return value;
  throw new Error(`Unknown --fail-on value: ${value}`);
}

function shouldFail(failOn: "high" | "medium" | "never", riskLevel: "low" | "medium" | "high"): boolean {
  if (failOn === "never") return false;
  if (failOn === "high") return riskLevel === "high";
  return riskLevel === "medium" || riskLevel === "high";
}

function parseTask(content: string, path: string): TaskSpec {
  if (path.endsWith(".json")) {
    const parsed = JSON.parse(content) as Partial<TaskSpec>;
    return {
      id: String(parsed.id ?? "task"),
      title: String(parsed.title ?? "Untitled task"),
      description: String(parsed.description ?? ""),
      authorityFacts: Array.isArray(parsed.authorityFacts) ? parsed.authorityFacts.map(String) : []
    };
  }

  const title = content.split("\n").find((line) => line.trim().length > 0)?.replace(/^#+\s*/, "") ?? "Task";
  return {
    id: title.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "task",
    title,
    description: content,
    authorityFacts: extractAuthorityFacts(content)
  };
}

function parsePolicy(content: string, path: string): RepoPolicy {
  if (path.endsWith(".json")) {
    return normalizePolicy(JSON.parse(content) as Partial<RepoPolicy>);
  }

  return normalizePolicy(parseSimpleYamlPolicy(content));
}

function normalizePolicy(policy: Partial<RepoPolicy>): RepoPolicy {
  return {
    allowed_paths: Array.isArray(policy.allowed_paths) ? policy.allowed_paths.map(String) : [],
    forbidden_paths: Array.isArray(policy.forbidden_paths) ? policy.forbidden_paths.map(String) : [],
    ownership: policy.ownership ?? {},
    paired_files: Array.isArray(policy.paired_files)
      ? policy.paired_files.map((rule) => ({
          source: String(rule.source),
          requires: String(rule.requires),
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

function isArraySection(section: keyof RepoPolicy): section is "allowed_paths" | "forbidden_paths" | "sensitive_patterns" | "required_tests" | "missing_authority_rules" {
  return section === "allowed_paths" ||
    section === "forbidden_paths" ||
    section === "sensitive_patterns" ||
    section === "required_tests" ||
    section === "missing_authority_rules";
}

function extractAuthorityFacts(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => line.toLowerCase().includes("authority:") || line.toLowerCase().includes("approved:"))
    .map((line) => line.replace(/^[-*\s]*/, "").trim());
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}
