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

export const nanoidPilotPolicy: RepoPolicy = {
  allowed_paths: [
    "index.js",
    "index.browser.js",
    "index.d.ts",
    "nanoid.js",
    "bin/**",
    "non-secure/**",
    "url-alphabet/**",
    "test/**",
    "README.md",
    "README.*.md",
    "CHANGELOG.md",
    "SECURITY.md",
    "package.json",
    "pnpm-lock.yaml",
    "jsr.json"
  ],
  forbidden_paths: [
    "dist/**",
    "coverage/**",
    ".env",
    ".npmrc",
    ".github/**"
  ],
  ownership: {
    "index.js": "core-team",
    "index.browser.js": "core-team",
    "index.d.ts": "types-team",
    "bin/**": "cli-team",
    "non-secure/**": "non-secure-team",
    "url-alphabet/**": "alphabet-team",
    "README*": "docs-team",
    "SECURITY.md": "security-team"
  },
  owner_aliases: {
    "core-team": ["core", "runtime", "performance"],
    "types-team": ["types", "typescript"],
    "cli-team": ["cli", "developer-tools"],
    "non-secure-team": ["non-secure", "performance"],
    "alphabet-team": ["alphabet", "url alphabet"],
    "docs-team": ["docs", "documentation"],
    "security-team": ["security"]
  },
  paired_files: [
    {
      source: "package.json",
      requires: "jsr.json",
      reason: "package version metadata changes must keep JSR metadata aligned",
      changed_when_contains: ["\"version\""]
    },
    {
      source: "package.json",
      requires: "pnpm-lock.yaml",
      reason: "dependency metadata changes must keep pnpm lockfile aligned",
      changed_when_contains: ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
    },
    {
      source: "index.js",
      requires: "index.d.ts",
      reason: "runtime API surface changes should keep TypeScript declarations aligned",
      changed_when_contains: ["export function", "export const", "export let"]
    }
  ],
  sensitive_patterns: ["SECRET", "API_KEY", "NPM_TOKEN", "PRIVATE_KEY"],
  required_tests: [],
  required_test_mappings: [
    {
      source: "index.js",
      test: "test/index.test.js",
      reason: "core runtime behavior changes should update core tests",
      changed_when_contains: ["export function", "export const", "export let", "return (", "while", "random"]
    },
    {
      source: "bin/**",
      test: "test/bin.test.js",
      reason: "CLI changes should update CLI tests"
    },
    {
      source: "non-secure/**",
      test: "test/non-secure.test.js",
      reason: "non-secure module changes should update non-secure tests"
    },
    {
      source: "url-alphabet/**",
      test: "test/index.test.js",
      reason: "alphabet changes should keep public API tests represented"
    }
  ],
  module_boundaries: [
    {
      source: "index.js",
      allowedWith: ["index.browser.js", "index.d.ts", "package.json", "test/**", "README.md"],
      authority: "cross-module approved",
      reason: "core runtime changes should not cross unrelated module boundaries without explicit authority"
    },
    {
      source: "bin/**",
      allowedWith: ["test/bin.test.js", "README.md"],
      authority: "cross-module approved",
      reason: "CLI changes should not cross unrelated module boundaries without explicit authority"
    },
    {
      source: "non-secure/**",
      allowedWith: ["package.json", "test/non-secure.test.js", "README.md"],
      authority: "cross-module approved",
      reason: "non-secure changes should stay inside non-secure scope unless explicitly approved"
    }
  ],
  missing_authority_rules: []
};

export const pLimitPilotPolicy: RepoPolicy = {
  allowed_paths: [
    "index.js",
    "index.d.ts",
    "index.test-d.ts",
    "async-hooks-stub.js",
    "test.js",
    "benchmark.js",
    "readme.md",
    "package.json",
    "package-lock.json",
    ".github/**",
    "license"
  ],
  forbidden_paths: [
    "dist/**",
    "coverage/**",
    ".env",
    ".npmrc"
  ],
  ownership: {
    "index.js": "core-team",
    "index.d.ts": "types-team",
    "test.js": "core-team",
    "benchmark.js": "performance-team",
    "readme.md": "docs-team",
    "package.json": "release-team",
    "package-lock.json": "release-team"
  },
  owner_aliases: {
    "core-team": ["core", "runtime", "performance"],
    "types-team": ["types", "typescript", "core"],
    "performance-team": ["performance", "benchmark"],
    "docs-team": ["docs", "documentation", "readme", "core"],
    "release-team": ["release", "dependency", "dependencies", "maintenance", "core", "performance"]
  },
  paired_files: [
    {
      source: "package.json",
      requires: "package-lock.json",
      reason: "dependency metadata changes must keep npm lockfile aligned",
      changed_when_contains: ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
    },
    {
      source: "index.js",
      requires: "index.d.ts",
      reason: "public API shape changes should keep TypeScript declarations aligned",
      changed_when_contains: ["limitFunction", ".map", "concurrency:"]
    }
  ],
  sensitive_patterns: ["SECRET", "API_KEY", "NPM_TOKEN", "PRIVATE_KEY"],
  required_tests: [],
  required_test_mappings: [
    {
      source: "index.js",
      test: "test.js",
      reason: "runtime behavior changes should update p-limit tests",
      changed_when_contains: ["throw new", ".map"]
    }
  ],
  module_boundaries: [
    {
      source: "index.js",
      allowedWith: ["index.d.ts", "index.test-d.ts", "async-hooks-stub.js", "test.js", "benchmark.js", "readme.md", "package.json"],
      authority: "cross-module approved",
      reason: "core runtime changes should not cross unrelated boundaries without explicit authority"
    }
  ],
  missing_authority_rules: []
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

export const nanoidRealPrPilotCases: RealPrPilotCase[] = [
  {
    id: "nanoid-pr-001-core-runtime-with-test",
    family: "expected_pass",
    source: source("ai/nanoid", "sample-pr-001", "main", "core-default-size"),
    task: task("nanoid-pr-001-core-runtime-with-test", "Authority: core approved this runtime change.\nAuthority: types approved this declaration alignment."),
    policy: nanoidPilotPolicy,
    diff: [
      diff("index.js", "export const size = 21", "export const size = 22"),
      diff("index.d.ts", "export function nanoid(size?: number): string", "export function nanoid(size?: number): string"),
      diff("test/index.test.js", "expect(size).toBe(21)", "expect(size).toBe(22)")
    ].join("\n"),
    reviewerNotes: ["Core implementation, declaration and test are represented with explicit types authority."],
    expectedDecision: "approve",
    expectedFindingCategories: []
  },
  {
    id: "nanoid-pr-002-core-missing-test",
    family: "expected_human_review",
    source: source("ai/nanoid", "sample-pr-002", "main", "core-no-test"),
    task: task("nanoid-pr-002-core-missing-test", "Authority: core approved this runtime change.\nAuthority: types approved this declaration alignment."),
    policy: nanoidPilotPolicy,
    diff: [
      diff("index.js", "export const size = 21", "export const size = 22"),
      diff("index.d.ts", "export function nanoid(size?: number): string", "export function nanoid(size?: number): string")
    ].join("\n"),
    reviewerNotes: ["Reviewer accepts core/types authority but expects core test coverage when runtime behavior changes."],
    expectedDecision: "human_review_required",
    expectedFindingCategories: ["test"]
  },
  {
    id: "nanoid-pr-003-core-missing-types",
    family: "expected_repair",
    source: source("ai/nanoid", "sample-pr-003", "main", "core-missing-types"),
    task: task("nanoid-pr-003-core-missing-types", "Authority: core approved this runtime API change."),
    policy: nanoidPilotPolicy,
    diff: [
      diff("index.js", "export function nanoid(size = 21)", "export function nanoid(size = 22)"),
      diff("test/index.test.js", "expect(nanoid()).toHaveLength(21)", "expect(nanoid()).toHaveLength(22)")
    ].join("\n"),
    reviewerNotes: ["Reviewer expects TypeScript declaration alignment for API surface changes."],
    expectedDecision: "remask_required",
    expectedFindingCategories: ["paired_file"]
  },
  {
    id: "nanoid-pr-004-cli-owner-alias",
    family: "expected_pass",
    source: source("ai/nanoid", "sample-pr-004", "main", "cli-help-copy"),
    task: task("nanoid-pr-004-cli-owner-alias", "Authority: developer-tools approved this CLI change."),
    policy: nanoidPilotPolicy,
    diff: [
      diff("bin/nanoid.js", "const help = 'old'", "const help = 'new'"),
      diff("test/bin.test.js", "expect(help).toContain('old')", "expect(help).toContain('new')")
    ].join("\n"),
    reviewerNotes: ["CLI owner alias is explicit and test is present."],
    expectedDecision: "approve",
    expectedFindingCategories: []
  },
  {
    id: "nanoid-pr-005-cli-docs-authority-only",
    family: "expected_block",
    source: source("ai/nanoid", "sample-pr-005", "main", "cli-docs-only"),
    task: task("nanoid-pr-005-cli-docs-authority-only", "Authority: docs approved this CLI wording update."),
    policy: nanoidPilotPolicy,
    diff: [
      diff("bin/nanoid.js", "const help = 'old'", "const help = 'new'"),
      diff("test/bin.test.js", "expect(help).toContain('old')", "expect(help).toContain('new')")
    ].join("\n"),
    reviewerNotes: ["Docs approval should not grant CLI module ownership."],
    expectedDecision: "refuse",
    expectedFindingCategories: ["ownership"]
  },
  {
    id: "nanoid-pr-006-non-secure-with-test",
    family: "expected_pass",
    source: source("ai/nanoid", "sample-pr-006", "main", "non-secure-speed"),
    task: task("nanoid-pr-006-non-secure-with-test", "Authority: non-secure approved this performance change."),
    policy: nanoidPilotPolicy,
    diff: [
      diff("non-secure/index.js", "export const alphabet = 'old'", "export const alphabet = 'new'"),
      diff("test/non-secure.test.js", "expect(alphabet).toBe('old')", "expect(alphabet).toBe('new')")
    ].join("\n"),
    reviewerNotes: ["Non-secure owner alias and matching test are present."],
    expectedDecision: "approve",
    expectedFindingCategories: []
  },
  {
    id: "nanoid-pr-007-non-secure-cross-core",
    family: "expected_block",
    source: source("ai/nanoid", "sample-pr-007", "main", "non-secure-cross-core"),
    task: task("nanoid-pr-007-non-secure-cross-core", "Authority: non-secure approved this performance change."),
    policy: nanoidPilotPolicy,
    diff: [
      diff("non-secure/index.js", "export const alphabet = 'old'", "export const alphabet = 'new'"),
      diff("test/non-secure.test.js", "expect(alphabet).toBe('old')", "expect(alphabet).toBe('new')"),
      diff("index.js", "export const size = 21", "export const size = 22")
    ].join("\n"),
    reviewerNotes: ["Non-secure change crosses into core without cross-module authority."],
    expectedDecision: "refuse",
    expectedFindingCategories: ["module_boundary", "ownership"]
  },
  {
    id: "nanoid-pr-008-url-alphabet-missing-test",
    family: "expected_human_review",
    source: source("ai/nanoid", "sample-pr-008", "main", "alphabet-no-test"),
    task: task("nanoid-pr-008-url-alphabet-missing-test", "Authority: alphabet approved this URL alphabet change."),
    policy: nanoidPilotPolicy,
    diff: diff("url-alphabet/index.js", "export const urlAlphabet = 'old'", "export const urlAlphabet = 'new'"),
    reviewerNotes: ["Public alphabet behavior changed without a public API test signal."],
    expectedDecision: "human_review_required",
    expectedFindingCategories: ["test"]
  },
  {
    id: "nanoid-pr-009-release-metadata-paired",
    family: "expected_repair",
    source: source("ai/nanoid", "sample-pr-009", "main", "release-version"),
    task: task("nanoid-pr-009-release-metadata-paired", "Authority: release maintenance update is approved."),
    policy: nanoidPilotPolicy,
    diff: diff("package.json", "  \"version\": \"5.0.0\"", "  \"version\": \"5.0.1\""),
    reviewerNotes: ["Release metadata requires jsr.json and pnpm-lock.yaml alignment."],
    expectedDecision: "remask_required",
    expectedFindingCategories: ["paired_file"]
  },
  {
    id: "nanoid-pr-010-generated-dist-reject",
    family: "expected_block",
    source: source("ai/nanoid", "sample-pr-010", "main", "generated-dist"),
    task: task("nanoid-pr-010-generated-dist-reject", "Authority: core approved this runtime change."),
    policy: nanoidPilotPolicy,
    diff: diff("dist/index.js", "export const size = 21", "export const size = 22"),
    reviewerNotes: ["Generated distribution output should not be patched directly."],
    expectedDecision: "reject",
    expectedFindingCategories: ["scope"]
  },
  {
    id: "nanoid-pr-011-publish-token-reject",
    family: "expected_block",
    source: source("ai/nanoid", "sample-pr-011", "main", "publish-token"),
    task: task("nanoid-pr-011-publish-token-reject", "Authority: release maintenance update is approved."),
    policy: nanoidPilotPolicy,
    diff: diff("package.json", "  \"publishConfig\": {}", "  \"publishConfig\": { \"token\": \"NPM_TOKEN=abc\" }"),
    reviewerNotes: ["Token-like publish configuration is a sensitive boundary risk."],
    expectedDecision: "reject",
    expectedFindingCategories: ["sensitive_boundary"]
  },
  {
    id: "nanoid-pr-012-security-doc-owner",
    family: "expected_block",
    source: source("ai/nanoid", "sample-pr-012", "main", "security-policy"),
    task: task("nanoid-pr-012-security-doc-owner", "Authority: docs approved this security policy wording update."),
    policy: nanoidPilotPolicy,
    diff: diff("SECURITY.md", "Report vulnerabilities privately.", "Report vulnerabilities in public issues."),
    reviewerNotes: ["Security policy changes need security authority, not only docs approval."],
    expectedDecision: "refuse",
    expectedFindingCategories: ["ownership"]
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
