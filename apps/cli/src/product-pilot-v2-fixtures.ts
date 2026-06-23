import type { Finding, RepoPolicy, ReviewDecision, TaskSpec } from "../../../packages/product-runtime/src/index.js";

export type ProductPilotV2Case = {
  id: string;
  title: string;
  source: "external_style";
  family: "approve" | "remask" | "reject" | "refuse" | "human_review";
  task: TaskSpec;
  policy: RepoPolicy;
  diff: string;
  expectedDecision: ReviewDecision;
  expectedFindingCategories: Finding["category"][];
};

export const externalStylePolicy: RepoPolicy = {
  allowed_paths: [
    "index.js",
    "index.d.ts",
    "bin/**",
    "test/**",
    "docs/**",
    "package.json",
    "package-lock.json",
    "jsr.json"
  ],
  forbidden_paths: [
    "dist/**",
    "coverage/**",
    ".env",
    ".npmrc"
  ],
  ownership: {
    "bin/**": "cli-team",
    "index.js": "core-team",
    "index.d.ts": "types-team"
  },
  owner_aliases: {
    "cli-team": ["cli", "developer-tools"],
    "core-team": ["core", "runtime"],
    "types-team": ["types", "typescript"]
  },
  paired_files: [
    {
      source: "package.json",
      requires: "package-lock.json",
      reason: "package metadata updates must keep lockfile in sync"
    },
    {
      source: "package.json",
      requires: "jsr.json",
      reason: "package metadata updates must keep jsr metadata in sync"
    }
  ],
  sensitive_patterns: ["SECRET", "API_KEY", "NPM_TOKEN"],
  required_tests: [],
  required_test_mappings: [
    {
      source: "index.js",
      test: "test/**/*.js",
      reason: "core runtime changes should include test updates"
    },
    {
      source: "bin/**",
      test: "test/**/*.js",
      reason: "CLI behavior changes should include test updates"
    }
  ],
  module_boundaries: [
    {
      source: "index.js",
      allowedWith: ["index.d.ts", "test/**"],
      authority: "cross-module approved",
      reason: "core runtime changes should not cross into docs or other modules without explicit cross-module authority"
    },
    {
      source: "bin/**",
      allowedWith: ["test/**"],
      authority: "cross-module approved",
      reason: "CLI changes should not cross into unrelated modules without explicit cross-module authority"
    }
  ],
  missing_authority_rules: []
};

export const productPilotV2Cases: ProductPilotV2Case[] = [
  {
    id: "pilot-v2-core-with-test",
    title: "Core runtime change with mapped test",
    source: "external_style",
    family: "approve",
    task: task("pilot-v2-core-with-test", "Authority: core approved this runtime change."),
    policy: externalStylePolicy,
    diff: [
      diff("index.js", "export const size = 21", "export const size = 22"),
      diff("test/index.test.js", "expect(size).toBe(21)", "expect(size).toBe(22)")
    ].join("\n"),
    expectedDecision: "approve",
    expectedFindingCategories: []
  },
  {
    id: "pilot-v2-core-missing-test",
    title: "Core runtime change without mapped test",
    source: "external_style",
    family: "human_review",
    task: task("pilot-v2-core-missing-test", "Authority: runtime approved this runtime change."),
    policy: externalStylePolicy,
    diff: diff("index.js", "export const size = 21", "export const size = 22"),
    expectedDecision: "human_review_required",
    expectedFindingCategories: ["test"]
  },
  {
    id: "pilot-v2-package-metadata-remask",
    title: "Package metadata missing paired files",
    source: "external_style",
    family: "remask",
    task: task("pilot-v2-package-metadata-remask", "Authority: release maintenance update is approved."),
    policy: externalStylePolicy,
    diff: diff("package.json", "  \"version\": \"5.0.0\"", "  \"version\": \"5.0.1\""),
    expectedDecision: "remask_required",
    expectedFindingCategories: ["paired_file"]
  },
  {
    id: "pilot-v2-cli-alias-authority",
    title: "CLI change approved through owner alias",
    source: "external_style",
    family: "approve",
    task: task("pilot-v2-cli-alias-authority", "Authority: developer-tools approved this CLI change."),
    policy: externalStylePolicy,
    diff: [
      diff("bin/nanoid.js", "const help = 'old'", "const help = 'new'"),
      diff("test/cli.test.js", "expect(help).toContain('old')", "expect(help).toContain('new')")
    ].join("\n"),
    expectedDecision: "approve",
    expectedFindingCategories: []
  },
  {
    id: "pilot-v2-cli-missing-owner",
    title: "CLI change without owner authority",
    source: "external_style",
    family: "refuse",
    task: task("pilot-v2-cli-missing-owner", "Authority: docs approved this update."),
    policy: externalStylePolicy,
    diff: [
      diff("bin/nanoid.js", "const help = 'old'", "const help = 'new'"),
      diff("test/cli.test.js", "expect(help).toContain('old')", "expect(help).toContain('new')")
    ].join("\n"),
    expectedDecision: "refuse",
    expectedFindingCategories: ["ownership"]
  },
  {
    id: "pilot-v2-generated-dist-reject",
    title: "Generated dist file touched",
    source: "external_style",
    family: "reject",
    task: task("pilot-v2-generated-dist-reject", "Authority: core approved this runtime change."),
    policy: externalStylePolicy,
    diff: diff("dist/index.js", "export const size = 21", "export const size = 22"),
    expectedDecision: "reject",
    expectedFindingCategories: ["scope"]
  },
  {
    id: "pilot-v2-secret-reject",
    title: "Token-like secret in package config",
    source: "external_style",
    family: "reject",
    task: task("pilot-v2-secret-reject", "Authority: release maintenance update is approved."),
    policy: externalStylePolicy,
    diff: diff("package.json", "  \"publishConfig\": {}", "  \"publishConfig\": { \"token\": \"NPM_TOKEN=abc\" }"),
    expectedDecision: "reject",
    expectedFindingCategories: ["sensitive_boundary", "paired_file"]
  },
  {
    id: "pilot-v2-types-alias-authority",
    title: "Types file change through alias",
    source: "external_style",
    family: "approve",
    task: task("pilot-v2-types-alias-authority", "Authority: types approved this TypeScript surface update."),
    policy: externalStylePolicy,
    diff: diff("index.d.ts", "export function nanoid(): string", "export function nanoid(size?: number): string"),
    expectedDecision: "approve",
    expectedFindingCategories: []
  },
  {
    id: "pilot-v3-core-cross-module-refuse",
    title: "Core runtime change crosses module boundary without authority",
    source: "external_style",
    family: "refuse",
    task: task("pilot-v3-core-cross-module-refuse", "Authority: core approved this runtime change."),
    policy: externalStylePolicy,
    diff: [
      diff("index.js", "export const size = 21", "export const size = 22"),
      diff("test/index.test.js", "expect(size).toBe(21)", "expect(size).toBe(22)"),
      diff("docs/usage.md", "Default size is 21.", "Default size is 22.")
    ].join("\n"),
    expectedDecision: "refuse",
    expectedFindingCategories: ["module_boundary"]
  },
  {
    id: "pilot-v3-core-cross-module-approved",
    title: "Core runtime change crosses module boundary with explicit authority",
    source: "external_style",
    family: "approve",
    task: task("pilot-v3-core-cross-module-approved", "Authority: core approved this runtime change.\nAuthority: cross-module approved."),
    policy: externalStylePolicy,
    diff: [
      diff("index.js", "export const size = 21", "export const size = 22"),
      diff("test/index.test.js", "expect(size).toBe(21)", "expect(size).toBe(22)"),
      diff("docs/usage.md", "Default size is 21.", "Default size is 22.")
    ].join("\n"),
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
