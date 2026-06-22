import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parsePolicy, starterPolicyYaml, validatePolicy } from "./product-policy-utils.js";

const args = parseArgs(process.argv.slice(2));
if (args.help === "true" || args.h === "true") {
  printHelp();
  process.exit(0);
}

if (args.init === "true") {
  const outPath = args.out ?? "bounded-agent.policy.yml";
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, starterPolicyYaml);

  const policy = parsePolicy(starterPolicyYaml, outPath);
  const validation = validatePolicy(policy);

  console.log(JSON.stringify({
    ok: validation.ok,
    mode: "init",
    policyPath: outPath,
    warningCount: validation.warningCount,
    errorCount: validation.errorCount,
    findings: validation.findings
  }, null, 2));
  process.exit(validation.ok ? 0 : 1);
}

if (args.validate === "true") {
  const policyPath = requireArg(args, "policy");
  const content = await readFile(policyPath, "utf8");
  const validation = validatePolicy(parsePolicy(content, policyPath));

  console.log(JSON.stringify({
    ok: validation.ok,
    mode: "validate",
    policyPath,
    warningCount: validation.warningCount,
    errorCount: validation.errorCount,
    findings: validation.findings,
    normalizedPolicy: validation.policy
  }, null, 2));
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
  --help             Show this help.
`);
}
