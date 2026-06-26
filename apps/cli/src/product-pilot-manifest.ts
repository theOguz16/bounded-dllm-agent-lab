import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type ManifestStatus = "pass" | "missing" | "needs_review";

type ManifestArtifact = {
  name: string;
  path: string;
  status: ManifestStatus;
  summary: string;
};

type PilotHandoffManifest = {
  schemaVersion: "pilot-handoff-manifest/v1";
  createdAt: string;
  ok: boolean;
  inputs: {
    dogfoodDir: string;
    externalDir: string;
  };
  artifacts: ManifestArtifact[];
  readiness: {
    dogfoodOk: boolean;
    externalEvidenceOk: boolean;
    docsPresent: boolean;
    artifactOnlyRecommended: true;
    providerLiveCallOptIn: true;
  };
  nextActions: string[];
  manualChecks: string[];
};

const args = parseArgs(process.argv.slice(2));
if (args.help === "true" || args.h === "true") {
  printHelp();
  process.exit(0);
}

const outDir = args["out-dir"] ?? "reports/product-runtime-pilot";
const dogfoodDir = args["dogfood-dir"] ?? "reports/product-runtime-dogfood";
const externalDir = args["external-dir"] ?? "reports/product-runtime-external-evidence";
const createdAt = new Date().toISOString();

await mkdir(outDir, { recursive: true });

const dogfood = await readOptionalJson<Record<string, unknown>>(join(dogfoodDir, "dogfood-validation.json"));
const externalEvidence = await readOptionalJson<Record<string, unknown>>(join(externalDir, "external-evidence.json"));
const artifacts: ManifestArtifact[] = [
  artifact("Dogfood validation", join(dogfoodDir, "dogfood-validation.json"), dogfood, "Workflow/action artifact contract validation."),
  artifact("Dogfood markdown", join(dogfoodDir, "dogfood-validation.md"), await exists(join(dogfoodDir, "dogfood-validation.md")), "Human-readable dogfood action report."),
  artifact("External evidence", join(externalDir, "external-evidence.json"), externalEvidence, "NanoID and p-limit external evidence package."),
  artifact("External evidence markdown", join(externalDir, "external-evidence.md"), await exists(join(externalDir, "external-evidence.md")), "Human-readable external evidence report."),
  artifact("Consumer setup", "docs/CONSUMER_SETUP.md", await exists("docs/CONSUMER_SETUP.md"), "Consumer repository setup guide."),
  artifact("Public pilot readiness", "docs/PUBLIC_PILOT_READINESS.md", await exists("docs/PUBLIC_PILOT_READINESS.md"), "Public pilot gate and manual checks."),
  artifact("Artifact schema", "docs/PRODUCT_ARTIFACT_SCHEMA.md", await exists("docs/PRODUCT_ARTIFACT_SCHEMA.md"), "Stable artifact list for consumers.")
];
const manualChecks = [
  "Tune bounded-agent.policy.yml against the consumer repository ownership model.",
  "Run the first PR in artifact-only mode before enabling PR comment posting.",
  "Inspect product-review JSON, pr-comment.md, team-metrics.md and index.html before trusting the workflow.",
  "Choose provider credentials only after the deterministic policy flow is understood.",
  "Record false blocker and missed blocker examples during the first pilot week."
];
const manifest: PilotHandoffManifest = {
  schemaVersion: "pilot-handoff-manifest/v1",
  createdAt,
  ok: artifacts.every((item) => item.status === "pass"),
  inputs: {
    dogfoodDir,
    externalDir
  },
  artifacts,
  readiness: {
    dogfoodOk: Boolean(dogfood?.ok),
    externalEvidenceOk: Boolean(externalEvidence?.ok),
    docsPresent: artifacts.filter((item) => item.path.startsWith("docs/")).every((item) => item.status === "pass"),
    artifactOnlyRecommended: true,
    providerLiveCallOptIn: true
  },
  nextActions: [
    "Share docs/CONSUMER_PILOT_HANDOFF.md with the pilot user.",
    "Attach dogfood-validation.md and external-evidence.md to the pilot kickoff.",
    "Ask the pilot user to run artifact-only mode on a small documentation or metadata PR.",
    "Collect reviewer feedback in the manifest manual checks."
  ],
  manualChecks
};
const jsonPath = join(outDir, "pilot-handoff-manifest.json");
const markdownPath = join(outDir, "pilot-handoff-manifest.md");

await writeFile(jsonPath, `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(markdownPath, `${toMarkdown(manifest)}\n`);

console.log(JSON.stringify({
  ok: manifest.ok,
  schemaVersion: manifest.schemaVersion,
  artifactCount: artifacts.length,
  jsonPath,
  markdownPath
}, null, 2));

if (args["fail-on-missing"] === "true" && !manifest.ok) {
  process.exitCode = 1;
}

async function readOptionalJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

function artifact(name: string, path: string, value: unknown, summary: string): ManifestArtifact {
  const ok = typeof value === "boolean" ? value : Boolean(value && typeof value === "object" && (value as { ok?: unknown }).ok === true);
  return {
    name,
    path,
    status: ok ? "pass" : "missing",
    summary
  };
}

function toMarkdown(manifest: PilotHandoffManifest): string {
  return [
    "# Consumer Pilot Handoff Manifest",
    "",
    `- Created at: ${manifest.createdAt}`,
    `- Status: ${manifest.ok ? "pass" : "missing evidence"}`,
    `- Dogfood directory: ${manifest.inputs.dogfoodDir}`,
    `- External evidence directory: ${manifest.inputs.externalDir}`,
    "",
    "## Artifacts",
    "",
    "| Artifact | Status | Path | Summary |",
    "| --- | --- | --- | --- |",
    ...manifest.artifacts.map((item) => `| ${item.name} | ${item.status} | ${item.path} | ${item.summary} |`),
    "",
    "## Readiness",
    "",
    `- Dogfood validation: ${manifest.readiness.dogfoodOk ? "pass" : "missing"}`,
    `- External evidence: ${manifest.readiness.externalEvidenceOk ? "pass" : "missing"}`,
    `- Docs present: ${manifest.readiness.docsPresent ? "pass" : "missing"}`,
    `- Artifact-only recommended: ${manifest.readiness.artifactOnlyRecommended ? "yes" : "no"}`,
    `- Provider live call opt-in: ${manifest.readiness.providerLiveCallOptIn ? "yes" : "no"}`,
    "",
    "## Next Actions",
    "",
    ...manifest.nextActions.map((item) => `- ${item}`),
    "",
    "## Manual Checks",
    "",
    ...manifest.manualChecks.map((item) => `- ${item}`)
  ].join("\n");
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
  console.log(`Bounded Agent Pilot Handoff Manifest

Usage:
  npm run product:pilot-manifest

Options:
  --dogfood-dir <path>    Directory containing dogfood-validation.json.
  --external-dir <path>   Directory containing external-evidence.json.
  --out-dir <path>        Output directory. Default: reports/product-runtime-pilot
  --fail-on-missing       Exit non-zero if required evidence is missing.
  --help                  Show this help.
`);
}
