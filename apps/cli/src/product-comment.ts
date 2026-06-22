import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ReviewOutput } from "../../../packages/product-runtime/src/index.js";

const args = parseArgs(process.argv.slice(2));
if (args.help === "true" || args.h === "true") {
  printHelp();
  process.exit(0);
}

const reviewPath = requireArg(args, "review");
const outPath = args.out ?? join(dirname(reviewPath), "pr-comment.md");
const marker = args.marker ?? "<!-- bounded-agent-review -->";
const review = JSON.parse(await readFile(reviewPath, "utf8")) as ReviewOutput;
const comment = createPrComment(review, reviewPath, marker);

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${comment}\n`);

console.log(JSON.stringify({
  ok: true,
  decision: review.decision,
  riskLevel: review.riskLevel,
  findingCount: review.findings.length,
  repairProposalCount: review.repairProposals.length,
  commentPath: outPath,
  marker
}, null, 2));

function createPrComment(review: ReviewOutput, reviewPath: string, marker: string): string {
  const findingSummary = review.findings.length
    ? review.findings.map((finding) => `- **${finding.category}**: ${finding.message}`).join("\n")
    : "- No configured verifier findings.";
  const repairSummary = review.repairProposals.length
    ? review.repairProposals.map((proposal) => [
        `- **${proposal.kind}** on \`${proposal.files.join("`, `")}\``,
        `  - ${proposal.summary}`,
        ...proposal.patchOutline.map((item) => `  - ${item}`)
      ].join("\n")).join("\n")
    : "- No repair proposal.";

  const body = [
    "## Bounded Agent Review",
    "",
    `**Decision:** \`${review.decision}\``,
    `**Risk:** \`${review.riskLevel}\``,
    `**Changed files:** ${review.metrics.changedFileCount}`,
    `**Findings:** ${review.metrics.findingCount}`,
    "",
    "### Suggested Next Action",
    "",
    suggestNextAction(review.decision),
    "",
    "### Findings",
    "",
    findingSummary,
    "",
    "### Repair Proposal",
    "",
    repairSummary,
    "",
    "### Metrics",
    "",
    [
      `- Scope safety: ${flag(review.metrics.scopeSafety)}`,
      `- Authority safety: ${flag(review.metrics.authoritySafety)}`,
      `- Sensitive boundary safety: ${flag(review.metrics.sensitiveBoundarySafety)}`,
      `- Paired-file completeness: ${flag(review.metrics.pairedFileCompleteness)}`,
      `- Trace completeness: ${flag(review.metrics.traceCompleteness)}`
    ].join("\n"),
    "",
    `<sub>Full JSON artifact: ${reviewPath}</sub>`
  ].join("\n");

  // GitHub comment upsert akışı aynı yorumu bulabilmek için sabit bir HTML
  // marker'a ihtiyaç duyar. Marker kullanıcıya görünmez ama duplicate yorumları
  // engelleyen deterministik kimlik gibi çalışır.
  return marker ? [marker, "", body].join("\n") : body;
}

function suggestNextAction(decision: ReviewOutput["decision"]): string {
  if (decision === "approve") return "Proceed to normal human review.";
  if (decision === "refuse") return "Stop and request the missing authority before editing.";
  if (decision === "reject") return "Reject this patch before merge; it crossed a configured boundary.";
  if (decision === "remask_required") return "Run targeted repair only on the verifier-marked files.";
  return "Ask a human reviewer to provide the missing signal.";
}

function flag(value: 0 | 1): string {
  return value ? "pass" : "fail";
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
  if (!value) throw new Error(`Missing required argument --${key}`);
  return value;
}

function printHelp(): void {
  console.log(`Bounded Agent PR Comment

Usage:
  npm run product:comment -- --review reports/product-runtime/review.json

Options:
  --review <path>  Product review JSON artifact.
  --out <path>     Output Markdown comment path.
  --marker <text>  Hidden marker used for idempotent PR comment updates.
  --help           Show this help.
`);
}
