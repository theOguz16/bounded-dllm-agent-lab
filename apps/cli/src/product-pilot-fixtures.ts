import type { Finding, RepoPolicy, ReviewDecision, TaskSpec } from "../../../packages/product-runtime/src/index.js";

export type ProductPilotCase = {
  id: string;
  title: string;
  family: "approve" | "remask" | "reject" | "refuse" | "human_review";
  task: TaskSpec;
  policy: RepoPolicy;
  diff: string;
  expectedDecision: ReviewDecision;
  expectedFindingCategories: Finding["category"][];
};

const enterprisePolicy: RepoPolicy = {
  allowed_paths: [
    "packages/billing/**",
    "packages/auth/**",
    "packages/checkout/**",
    "docs/**",
    "package.json",
    "package-lock.json"
  ],
  forbidden_paths: [
    "infra/production/**",
    "secrets/**"
  ],
  ownership: {
    "packages/billing/**": "billing-team",
    "packages/auth/**": "auth-team",
    "packages/checkout/**": "checkout-team"
  },
  paired_files: [
    {
      source: "package.json",
      requires: "package-lock.json",
      reason: "package metadata changes must keep lockfile in sync"
    }
  ],
  sensitive_patterns: ["SECRET", "API_KEY", "PRIVATE_KEY"],
  required_tests: [],
  missing_authority_rules: []
};

export const productPilotCases: ProductPilotCase[] = [
  {
    id: "pilot-approve-billing-owned",
    title: "Billing-owned safe module change",
    family: "approve",
    task: task("pilot-approve-billing-owned", "Authority: billing-team approved the billing copy update."),
    policy: enterprisePolicy,
    diff: diff("packages/billing/copy.ts", "export const label = 'Old billing copy'", "export const label = 'New billing copy'"),
    expectedDecision: "approve",
    expectedFindingCategories: []
  },
  {
    id: "pilot-remask-package-lock",
    title: "Package metadata missing lockfile repair",
    family: "remask",
    task: task("pilot-remask-package-lock", "Authority: platform maintenance update is approved."),
    policy: enterprisePolicy,
    diff: diff("package.json", "  \"version\": \"0.1.0\"", "  \"version\": \"0.1.1\""),
    expectedDecision: "remask_required",
    expectedFindingCategories: ["paired_file"]
  },
  {
    id: "pilot-reject-production-infra",
    title: "Production infra boundary violation",
    family: "reject",
    task: task("pilot-reject-production-infra", "Authority: docs maintenance update is approved."),
    policy: enterprisePolicy,
    diff: diff("infra/production/terraform.tfvars", "replicas = 2", "replicas = 4"),
    expectedDecision: "reject",
    expectedFindingCategories: ["scope"]
  },
  {
    id: "pilot-reject-sensitive-secret",
    title: "Secret-like patch content",
    family: "reject",
    task: task("pilot-reject-sensitive-secret", "Authority: billing-team approved the billing config update."),
    policy: enterprisePolicy,
    diff: diff("packages/billing/config.ts", "export const key = ''", "export const key = 'API_KEY=abc123'"),
    expectedDecision: "reject",
    expectedFindingCategories: ["sensitive_boundary"]
  },
  {
    id: "pilot-refuse-missing-owner",
    title: "Billing module without owner authority",
    family: "refuse",
    task: task("pilot-refuse-missing-owner", "Authority: product maintenance update is approved."),
    policy: enterprisePolicy,
    diff: diff("packages/billing/retry.ts", "export const retry = 2", "export const retry = 3"),
    expectedDecision: "refuse",
    expectedFindingCategories: ["ownership"]
  },
  {
    id: "pilot-refuse-missing-product-default",
    title: "Runtime default without product authority",
    family: "refuse",
    task: task("pilot-refuse-missing-product-default", "Update checkout default timeout."),
    policy: {
      ...enterprisePolicy,
      missing_authority_rules: ["approved product default"]
    },
    diff: diff("packages/checkout/defaults.ts", "export const timeout = 30", "export const timeout = 45"),
    expectedDecision: "refuse",
    expectedFindingCategories: ["authority", "ownership"]
  },
  {
    id: "pilot-human-empty-diff",
    title: "No changed files require human review",
    family: "human_review",
    task: task("pilot-human-empty-diff", "Authority: docs maintenance update is approved."),
    policy: enterprisePolicy,
    diff: "",
    expectedDecision: "human_review_required",
    expectedFindingCategories: []
  },
  {
    id: "pilot-approve-docs-unowned",
    title: "Docs-only unowned change",
    family: "approve",
    task: task("pilot-approve-docs-unowned", "Authority: docs maintenance update is approved."),
    policy: enterprisePolicy,
    diff: diff("docs/runbook.md", "Old runbook", "New runbook"),
    expectedDecision: "approve",
    expectedFindingCategories: []
  }
];

function task(id: string, description: string): TaskSpec {
  return {
    id,
    title: id,
    description,
    authorityFacts: description
      .split("\n")
      .filter((line) => line.toLowerCase().includes("authority:"))
      .map((line) => line.trim())
  };
}

function diff(file: string, before: string, after: string): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@",
    `-${before}`,
    `+${after}`,
    ""
  ].join("\n");
}
