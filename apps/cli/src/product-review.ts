import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  parseUnifiedDiff,
  reviewPatch,
  type TaskSpec
} from "../../../packages/product-runtime/src/index.js";
import { parsePolicy } from "./product-policy-utils.js";

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

function extractAuthorityFacts(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => line.toLowerCase().includes("authority:") || line.toLowerCase().includes("approved:"))
    .map((line) => line.replace(/^[-*\s]*/, "").trim());
}
