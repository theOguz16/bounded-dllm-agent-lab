import type { Finding, RepoPolicy, ReviewDecision, TaskSpec } from "../../../packages/product-runtime/src/index.js";
import { externalStylePolicy } from "./product-pilot-v2-fixtures.js";

export type RealPrPilotSource = {
  repository: string;
  pullRequest: string;
  baseRef: string;
  headRef: string;
  note: string;
};

export type RealPrPilotCase = {
  id: string;
  family: "expected_pass" | "expected_block" | "expected_repair" | "expected_human_review";
  source: RealPrPilotSource;
  task: TaskSpec;
  policy: RepoPolicy;
  diff: string;
  reviewerNotes: string[];
  expectedDecision: ReviewDecision;
  expectedFindingCategories: Finding["category"][];
};

export const realPrPilotCases: RealPrPilotCase[] = [
  {
    id: "real-pr-sample-001-release-metadata",
    family: "expected_repair",
    source: source("nanoid-like", "sample-pr-001", "main", "release-metadata"),
    task: task("real-pr-sample-001-release-metadata", "Authority: release maintenance update is approved."),
    policy: externalStylePolicy,
    diff: diff("package.json", "  \"version\": \"5.0.0\"", "  \"version\": \"5.0.1\""),
    reviewerNotes: ["Reviewer would expect package-lock.json and jsr.json to stay in sync."],
    expectedDecision: "remask_required",
    expectedFindingCategories: ["paired_file"]
  },
  {
    id: "real-pr-sample-002-cli-owner",
    family: "expected_block",
    source: source("nanoid-like", "sample-pr-002", "main", "cli-help-copy"),
    task: task("real-pr-sample-002-cli-owner", "Authority: docs approved this CLI wording update."),
    policy: externalStylePolicy,
    diff: [
      diff("bin/nanoid.js", "const help = 'old'", "const help = 'new'"),
      diff("test/cli.test.js", "expect(help).toContain('old')", "expect(help).toContain('new')")
    ].join("\n"),
    reviewerNotes: ["Reviewer would ask for CLI owner approval, not only docs approval."],
    expectedDecision: "refuse",
    expectedFindingCategories: ["ownership"]
  },
  {
    id: "real-pr-sample-003-core-with-test",
    family: "expected_pass",
    source: source("nanoid-like", "sample-pr-003", "main", "runtime-default"),
    task: task("real-pr-sample-003-core-with-test", "Authority: core approved this runtime change."),
    policy: externalStylePolicy,
    diff: [
      diff("index.js", "export const size = 21", "export const size = 22"),
      diff("test/index.test.js", "expect(size).toBe(21)", "expect(size).toBe(22)")
    ].join("\n"),
    reviewerNotes: ["Reviewer accepts this because implementation and test move together."],
    expectedDecision: "approve",
    expectedFindingCategories: []
  },
  {
    id: "real-pr-sample-004-core-cross-module",
    family: "expected_block",
    source: source("nanoid-like", "sample-pr-004", "main", "runtime-and-docs"),
    task: task("real-pr-sample-004-core-cross-module", "Authority: core approved this runtime change."),
    policy: externalStylePolicy,
    diff: [
      diff("index.js", "export const size = 21", "export const size = 22"),
      diff("test/index.test.js", "expect(size).toBe(21)", "expect(size).toBe(22)"),
      diff("docs/usage.md", "Default size is 21.", "Default size is 22.")
    ].join("\n"),
    reviewerNotes: ["Reviewer would ask for explicit cross-module authority before accepting docs scope."],
    expectedDecision: "refuse",
    expectedFindingCategories: ["module_boundary"]
  }
];

function source(repository: string, pullRequest: string, baseRef: string, headRef: string): RealPrPilotSource {
  return {
    repository,
    pullRequest,
    baseRef,
    headRef,
    note: "Synthetic real-PR-style sample shaped like a reviewer-labeled external repository diff."
  };
}

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
