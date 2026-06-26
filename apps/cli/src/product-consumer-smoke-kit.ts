import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = parseArgs(process.argv.slice(2));
if (args.help === "true" || args.h === "true") {
  printHelp();
  process.exit(0);
}

const outDir = args["out-dir"] ?? "reports/consumer-smoke-kit";
await mkdir(join(outDir, ".github", "workflows"), { recursive: true });
await mkdir(join(outDir, "docs"), { recursive: true });

const files = [
  {
    path: "README.md",
    content: [
      "# Bounded Agent Consumer Smoke",
      "",
      "This tiny repository is a consumer smoke target for Bounded Agent Runtime.",
      "",
      "The first PR should modify `docs/pilot-note.md` and run the bounded review workflow in artifact-only mode."
    ].join("\n")
  },
  {
    path: "docs/pilot-note.md",
    content: [
      "# Pilot Note",
      "",
      "Initial consumer smoke note.",
      "",
      "The pilot reviewer should inspect the generated review artifacts before enabling PR comment posting."
    ].join("\n")
  },
  {
    path: "bounded-agent.policy.yml",
    content: [
      "allowed_paths:",
      "  - README.md",
      "  - docs/**",
      "forbidden_paths:",
      "  - .env",
      "  - secrets/**",
      "ownership:",
      "  docs/**: docs-team",
      "owner_aliases:",
      "  docs-team:",
      "    - docs",
      "paired_files:",
      "sensitive_patterns:",
      "  - CREDENTIAL_VALUE",
      "missing_authority_rules:"
    ].join("\n")
  },
  {
    path: ".github/workflows/bounded-agent-review.yml",
    content: [
      "name: Bounded Agent Review",
      "",
      "on:",
      "  pull_request:",
      "",
      "permissions:",
      "  contents: read",
      "  pull-requests: write",
      "",
      "jobs:",
      "  review:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "        with:",
      "          fetch-depth: 0",
      "      - name: Create bounded review task",
      "        run: |",
      "          cat > bounded-agent-task.md <<'EOF'",
      "          # Consumer smoke bounded review",
      "",
      "          Authority: docs-team approved this documentation pilot update.",
      "",
      "          Review this pull request diff against bounded-agent.policy.yml.",
      "          EOF",
      "      - name: Create pull request diff",
      "        run: git diff \"origin/${{ github.base_ref }}...HEAD\" > bounded-agent-pr.diff",
      "      - name: Bounded review",
      "        id: bounded-review",
      "        uses: theOguz16/bounded-dllm-agent-lab@main",
      "        with:",
      "          task: bounded-agent-task.md",
      "          diff: bounded-agent-pr.diff",
      "          policy: bounded-agent.policy.yml",
      "          output-dir: reports/product-runtime",
      "          fail-on: never",
      "      - name: Show bounded review outputs",
      "        run: |",
      "          echo \"Decision: ${{ steps.bounded-review.outputs.decision }}\"",
      "          echo \"Risk: ${{ steps.bounded-review.outputs.risk-level }}\"",
      "          echo \"Viewer: ${{ steps.bounded-review.outputs.viewer-path }}\"",
      "      - name: Upsert bounded review PR comment",
      "        uses: actions/github-script@v7",
      "        with:",
      "          script: |",
      "            const fs = require('node:fs');",
      "            const marker = '<!-- bounded-agent-review -->';",
      "            const body = fs.readFileSync('${{ steps.bounded-review.outputs.comment-path }}', 'utf8');",
      "            const {owner, repo} = context.repo;",
      "            const issue_number = context.payload.pull_request.number;",
      "            const comments = await github.rest.issues.listComments({owner, repo, issue_number, per_page: 100});",
      "            const previous = comments.data.find(comment => comment.body && comment.body.includes(marker));",
      "            if (previous) {",
      "              await github.rest.issues.updateComment({owner, repo, comment_id: previous.id, body});",
      "            } else {",
      "              await github.rest.issues.createComment({owner, repo, issue_number, body});",
      "            }",
      "      - uses: actions/upload-artifact@v4",
      "        with:",
      "          name: bounded-agent-review",
      "          path: reports/product-runtime"
    ].join("\n")
  }
];

for (const file of files) {
  await writeFile(join(outDir, file.path), `${file.content}\n`);
}

const manifest = {
  schemaVersion: "consumer-smoke-kit/v1",
  createdAt: new Date().toISOString(),
  outDir,
  files: files.map((file) => file.path),
  nextCommands: [
    `cd ${outDir}`,
    "git init",
    "git add .",
    "git commit -m 'Initial consumer smoke kit'",
    "gh repo create theOguz16/bounded-agent-consumer-smoke --private --source . --push",
    "git checkout -b docs/pilot-note-update",
    "printf '\\nPilot smoke update.\\n' >> docs/pilot-note.md",
    "git add docs/pilot-note.md",
    "git commit -m 'Update pilot note'",
    "git push origin docs/pilot-note-update",
    "gh pr create --base main --head docs/pilot-note-update --title 'Consumer smoke pilot note' --body 'Runs bounded agent review in a consumer repo.'"
  ]
};
const manifestPath = join(outDir, "consumer-smoke-kit.json");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(JSON.stringify({
  ok: true,
  outDir,
  fileCount: files.length,
  manifestPath
}, null, 2));

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
  console.log(`Bounded Agent Consumer Smoke Kit

Usage:
  npm run product:consumer-smoke-kit

Options:
  --out-dir <path>  Output directory. Default: reports/consumer-smoke-kit
  --help            Show this help.
`);
}
