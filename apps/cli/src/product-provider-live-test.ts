import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createProviderAdapterChatRequest,
  createSecretSafeProviderConfigSummary,
  executeOpenAiCompatibleRoleAdapter,
  parseUnifiedDiff,
  reviewPatch,
  type ProviderBackedRoleAdapterConfig
} from "../../../packages/product-runtime/src/index.js";
import { parsePolicy } from "./product-policy-utils.js";

type ProviderLiveTestReport = {
  schemaVersion: "provider-live-test/v1";
  createdAt: string;
  ok: boolean;
  status: "missing_provider_env" | "live_attempted" | "dry_run";
  live: boolean;
  safeConfig: ReturnType<typeof createSecretSafeProviderConfigSummary>;
  requestPreview: {
    model: string;
    messageCount: number;
    serializedContainsCredential: boolean;
  };
  output?: {
    adapterName: string;
    role: string;
    mode: string;
    confidence: number;
    summary: string;
    claimCount: number;
    rejectedClaimCount: number;
  };
  manualNextStep: string;
};

const args = parseArgs(process.argv.slice(2));
if (args.help === "true" || args.h === "true") {
  printHelp();
  process.exit(0);
}

const outDir = args["out-dir"] ?? "reports/product-runtime-provider";
const token = process.env.BOUNDED_AGENT_PROVIDER_TOKEN ?? process.env.OPENAI_API_KEY ?? process.env.LLM_API_KEY;
const baseUrl = args["base-url"] ?? process.env.BOUNDED_AGENT_PROVIDER_BASE_URL ?? process.env.LLM_API_BASE_URL ?? "https://api.openai.com/v1";
const model = args.model ?? process.env.BOUNDED_AGENT_PROVIDER_MODEL ?? process.env.LLM_MODEL ?? "gpt-4.1-mini";
const live = args.live === "true";
const config: ProviderBackedRoleAdapterConfig = {
  adapterName: "openai-compatible-verifier-live-test",
  role: "verifier",
  mode: "openai_compatible",
  model,
  baseUrl,
  apiKeyEnv: token ? selectedEnvName() : undefined,
  apiKey: live ? token : undefined,
  dryRun: !live
};
const task = {
  id: "provider-live-test",
  title: "Provider live adapter test",
  description: "Authority: repository maintenance update is approved.",
  authorityFacts: ["repository maintenance update is approved"]
};
const policy = parsePolicy([
  "allowed_paths:",
  "  - package.json",
  "forbidden_paths:",
  "  - .env",
  "ownership:",
  "paired_files:",
  "sensitive_patterns:",
  "  - CREDENTIAL_VALUE",
  "missing_authority_rules:"
].join("\n"), "provider-live-test-policy.yml");
const diff = parseUnifiedDiff("diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@\n-  \"version\": \"0.1.0\"\n+  \"version\": \"0.1.1\"\n");
const review = reviewPatch({ task, policy, diff });
const input = {
  role: "verifier" as const,
  task,
  diff,
  policy,
  workspace: review.workspace,
  roleView: review.workspace.roleViews.verifier
};
const safeConfig = createSecretSafeProviderConfigSummary(config);
const request = createProviderAdapterChatRequest(config, input);
const missingCredential = live && !token;
const output = missingCredential
  ? undefined
  : await executeOpenAiCompatibleRoleAdapter(config, input);
const report: ProviderLiveTestReport = {
  schemaVersion: "provider-live-test/v1",
  createdAt: new Date().toISOString(),
  ok: live ? Boolean(token && output && output.confidence > 0) : true,
  status: missingCredential ? "missing_provider_env" : live ? "live_attempted" : "dry_run",
  live,
  safeConfig,
  requestPreview: {
    model: request.model,
    messageCount: request.messages.length,
    serializedContainsCredential: token ? JSON.stringify(request).includes(token) : false
  },
  output: output
    ? {
        adapterName: output.adapterName,
        role: output.role,
        mode: output.mode,
        confidence: output.confidence,
        summary: output.summary,
        claimCount: output.claims.length,
        rejectedClaimCount: output.claims.filter((claim) => claim.status === "rejected").length
      }
    : undefined,
  manualNextStep: token
    ? "Inspect provider-live-test.json and confirm the provider response was expected."
    : "Set BOUNDED_AGENT_PROVIDER_TOKEN or OPENAI_API_KEY, then rerun with --live."
};
const jsonPath = join(outDir, "provider-live-test.json");
const markdownPath = join(outDir, "provider-live-test.md");

await mkdir(outDir, { recursive: true });
await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(markdownPath, `${toMarkdown(report)}\n`);

console.log(JSON.stringify({
  ok: report.ok,
  status: report.status,
  live: report.live,
  credentialPresent: Boolean(token),
  jsonPath,
  markdownPath
}, null, 2));

if (args["fail-on-missing"] === "true" && missingCredential) {
  process.exitCode = 1;
}

function selectedEnvName(): string | undefined {
  if (process.env.BOUNDED_AGENT_PROVIDER_TOKEN) return "BOUNDED_AGENT_PROVIDER_TOKEN";
  if (process.env.OPENAI_API_KEY) return "OPENAI_API_KEY";
  if (process.env.LLM_API_KEY) return "LLM_API_KEY";
  return undefined;
}

function toMarkdown(report: ProviderLiveTestReport): string {
  return [
    "# Provider Live-Test Report",
    "",
    `- Created at: ${report.createdAt}`,
    `- Status: ${report.status}`,
    `- Live mode: ${report.live ? "yes" : "no"}`,
    `- Provider mode: ${report.safeConfig.mode}`,
    `- Model: ${report.safeConfig.model}`,
    `- Credential serialized into request: ${report.requestPreview.serializedContainsCredential ? "yes" : "no"}`,
    "",
    "## Output",
    "",
    report.output
      ? `- Adapter: ${report.output.adapterName}\n- Confidence: ${report.output.confidence}\n- Claims: ${report.output.claimCount}\n- Rejected claims: ${report.output.rejectedClaimCount}\n- Summary: ${report.output.summary}`
      : "- No provider output was produced.",
    "",
    "## Manual Next Step",
    "",
    report.manualNextStep
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
  console.log(`Bounded Agent Provider Live Test

Usage:
  npm run product:provider-live-test
  npm run product:provider-live-test -- --live

Options:
  --live              Attempt a real OpenAI-compatible provider call.
  --base-url <url>    Provider base URL. Default: env or https://api.openai.com/v1
  --model <name>      Provider model. Default: env or gpt-4.1-mini
  --out-dir <path>    Output directory. Default: reports/product-runtime-provider
  --fail-on-missing   Exit non-zero when --live is requested without credentials.
  --help              Show this help.
`);
}
