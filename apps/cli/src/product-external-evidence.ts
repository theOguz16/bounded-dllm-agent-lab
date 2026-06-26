import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type ChildReport = Record<string, unknown>;

const args = parseArgs(process.argv.slice(2));
if (args.help === "true" || args.h === "true") {
  printHelp();
  process.exit(0);
}

const outDir = args["out-dir"] ?? "reports/product-runtime-external-evidence";
await mkdir(outDir, { recursive: true });

const nanoidPilot = await runCli("product-real-pr-pilot.js", ["--suite", "nanoid", "--out-dir", outDir]);
const pLimitPilot = await runCli("product-real-pr-pilot.js", [
  "--input",
  "examples/product-runtime/real-pr-fixtures/p-limit-github-prs.draft.json",
  "--out-dir",
  outDir
]);
const crossRepo = await runCli("product-cross-repo-validation.js", ["--out-dir", outDir]);
const mixedExternal = await runCli("product-mixed-external-validation.js", ["--out-dir", outDir]);
const evidence = {
  ok: Boolean(nanoidPilot.ok) && Boolean(pLimitPilot.ok) && Boolean(crossRepo.ok) && Boolean(mixedExternal.ok),
  createdAt: new Date().toISOString(),
  suites: {
    nanoidPilot,
    pLimitPilot,
    crossRepo,
    mixedExternal
  },
  readiness: {
    nanoidOk: Boolean(nanoidPilot.ok),
    pLimitOk: Boolean(pLimitPilot.ok),
    crossRepoOk: Boolean(crossRepo.ok),
    mixedExternalOk: Boolean(mixedExternal.ok)
  }
};
const jsonPath = join(outDir, "external-evidence.json");
const markdownPath = join(outDir, "external-evidence.md");

await writeFile(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`);
await writeFile(markdownPath, `${toMarkdown(evidence)}\n`);

console.log(JSON.stringify({
  ok: evidence.ok,
  outDir,
  jsonPath,
  markdownPath,
  nanoidOk: evidence.readiness.nanoidOk,
  pLimitOk: evidence.readiness.pLimitOk,
  crossRepoOk: evidence.readiness.crossRepoOk,
  mixedExternalOk: evidence.readiness.mixedExternalOk
}, null, 2));

if (args["fail-on-regression"] === "true" && !evidence.ok) {
  process.exitCode = 1;
}

async function runCli(fileName: string, values: string[]): Promise<ChildReport> {
  const { spawn } = await import("node:child_process");
  const cliPath = new URL(`./${fileName}`, import.meta.url);

  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath.pathname, ...values], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${fileName} failed with code ${code ?? "unknown"}: ${stderr}`));
        return;
      }
      const jsonStart = stdout.indexOf("{");
      resolve(JSON.parse(stdout.slice(jsonStart)) as ChildReport);
    });
  });
}

type ExternalEvidenceReport = {
  ok: boolean;
  createdAt: string;
  suites: {
    nanoidPilot: ChildReport;
    pLimitPilot: ChildReport;
    crossRepo: ChildReport;
    mixedExternal: ChildReport;
  };
  readiness: {
    nanoidOk: boolean;
    pLimitOk: boolean;
    crossRepoOk: boolean;
    mixedExternalOk: boolean;
  };
};

function toMarkdown(evidence: ExternalEvidenceReport): string {
  return [
    "# External Repo Evidence Package",
    "",
    `- Created at: ${evidence.createdAt}`,
    `- Status: ${evidence.ok ? "pass" : "needs review"}`,
    "",
    "| Suite | Status | Key Metric |",
    "| --- | --- | --- |",
    row("NanoID real PR pilot", evidence.readiness.nanoidOk, `decision accuracy ${percentValue(evidence.suites.nanoidPilot.decisionAccuracy)}`),
    row("p-limit real PR pilot", evidence.readiness.pLimitOk, `decision accuracy ${percentValue(evidence.suites.pLimitPilot.decisionAccuracy)}`),
    row("Cross-repo reviewed validation", evidence.readiness.crossRepoOk, `runtime drift ${String(evidence.suites.crossRepo.runtimeDriftCount ?? "(unknown)")}`),
    row("Mixed external validation", evidence.readiness.mixedExternalOk, `missed blockers ${String(evidence.suites.mixedExternal.missedBlockerCount ?? "(unknown)")}`),
    "",
    "## Reading",
    "",
    "This package groups real upstream PR fixtures, reviewed label overrides and negative controls into one product evidence bundle. A passing result means the current deterministic runtime is stable on the checked external fixtures; it is not a general correctness guarantee."
  ].join("\n");
}

function row(label: string, ok: boolean, metric: string): string {
  return `| ${label} | ${ok ? "pass" : "needs review"} | ${metric} |`;
}

function percentValue(value: unknown): string {
  return typeof value === "number" ? `${Math.round(value * 1000) / 10}%` : "(unknown)";
}

function parseArgs(values: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) parsed[key] = "true";
    else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function printHelp(): void {
  console.log(`Bounded Agent External Evidence

Usage:
  npm run product:external-evidence

Options:
  --out-dir <path>         Output directory. Default: reports/product-runtime-external-evidence
  --fail-on-regression     Exit non-zero if any evidence suite fails.
  --help                   Show this help.
`);
}
