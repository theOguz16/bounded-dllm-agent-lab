#!/usr/bin/env node

const assert = require("node:assert/strict");
const { generateKeyPairSync } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

(async () => {
  const canonical = await import("../../dist/packages/product-runtime/src/canonical-runtime.js");
  const legacy = await import("../../dist/packages/product-runtime/src/index.js");
  const roots = [];
  let checks = 0;
  const check = (name, callback) => { callback(); checks++; console.log(`[ok] ${name}`); };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "canonical-policy-")); roots.push(root);
  const write = (file, content = `${file}\n`) => {
    const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  for (const file of ["src/a.ts", "src/b.ts", "package.json", "package-lock.json",
    "config/owned.yml", ".env", "docs/readme.md"]) write(file);
  const issuerKeys = generateKeyPairSync("ed25519");
  const issuerPublicKey = issuerKeys.publicKey.export({ type: "spki", format: "pem" });
  const issuerPrivateKey = issuerKeys.privateKey.export({ type: "pkcs8", format: "pem" });
  const policyDocument = {
    schemaVersion: "1",
    allowed_paths: ["src/**", "package*.json", "config/**", "docs/**", ".env", "src/**"],
    forbidden_paths: ["src/b.ts"],
    paired_files: [{ source: "package.json", requires: "package-lock.json", reason: "lock" }],
    sensitive_patterns: ["SECRET", "API_KEY", "TOKEN", "PASSWORD"],
    sensitive_paths: [{ pattern: ".env", disposition: "deny" }],
    ownership_rules: [{ pattern: "config/**", authorities: ["platform"] }],
    authority_issuers: [{ issuerId: "ci.issuer", publicKey: issuerPublicKey }]
  };
  const compile = () => canonical.compileCanonicalPolicy({ repositoryPath: root, policyDocument });
  const first = compile(); const second = compile();
  check("deterministic immutable compilation and sorting", () => {
    assert.equal(first.compiledPolicyHash, second.compiledPolicyHash);
    assert.deepEqual(first.allowedPaths, [...first.allowedPaths].sort());
    assert.equal(Object.isFrozen(first), true); assert.equal(Object.isFrozen(first.allowedPaths), true);
  });
  check("allow glob resolves repository files", () => {
    assert.equal(canonical.evaluateCanonicalPolicy({ policy: first,
      changedFiles: ["src/a.ts"] }).decision, "allow");
  });
  check("forbidden overrides allowed", () => {
    const result = canonical.evaluateCanonicalPolicy({ policy: first, changedFiles: ["src/b.ts"] });
    assert.equal(result.decision, "deny");
    assert(result.reasonCodes.includes("canonical_policy_forbidden_path"));
  });
  check("paired file is mandatory and succeeds together", () => {
    assert(canonical.evaluateCanonicalPolicy({ policy: first, changedFiles: ["package.json"] })
      .reasonCodes.includes("canonical_policy_paired_file_missing"));
    assert.equal(canonical.evaluateCanonicalPolicy({ policy: first,
      changedFiles: ["package-lock.json", "package.json"] }).decision, "allow");
  });
  check("conditional pair applies only when configured content changes", () => {
    const conditional = canonical.compileCanonicalPolicy({ repositoryPath: root,
      policyDocument: { ...policyDocument, paired_files: [{ source: "package.json",
        requires: "package-lock.json", changed_when_contains: ["dependencies"] }] } });
    assert.equal(canonical.evaluateCanonicalPolicy({ policy: conditional, changedFiles: ["package.json"],
      mutation: { claims: [{ file: "package.json", newContent: '{"name":"fixture"}' }] } }).decision, "allow");
    assert(canonical.evaluateCanonicalPolicy({ policy: conditional, changedFiles: ["package.json"],
      mutation: { claims: [{ file: "package.json", newContent: '{"dependencies":{}}' }] } })
      .reasonCodes.includes("canonical_policy_paired_file_missing"));
    assert(canonical.evaluateCanonicalPolicy({ policy: conditional, changedFiles: ["package.json"] })
      .reasonCodes.includes("canonical_policy_conditional_evidence_missing"));
  });
  check("sensitive path is denied", () => {
    assert(canonical.evaluateCanonicalPolicy({ policy: first, changedFiles: [".env"] })
      .reasonCodes.includes("canonical_policy_sensitive_path"));
    assert.equal(first.sensitiveRules.some((rule) => rule.pattern === "SECRET"), false);
  });
  const repositoryIdentityHash = canonical.canonicalPolicyRepositoryIdentity(root);
  const authority = canonical.createCanonicalPolicyAuthority({ issuerId: "ci.issuer",
    actorId: "ci.actor", authorities: ["platform"], compiledPolicyHash: first.compiledPolicyHash,
    repositoryIdentityHash, taskId: "task.policy", privateKey: issuerPrivateKey });
  const authorityContext = { repositoryIdentityHash, taskId: "task.policy" };
  check("ownership match, mismatch, and missing authority", () => {
    assert.equal(canonical.evaluateCanonicalPolicy({ policy: first,
      changedFiles: ["config/owned.yml"], authority, ...authorityContext }).decision, "allow");
    assert(canonical.evaluateCanonicalPolicy({ policy: first, changedFiles: ["config/owned.yml"],
      authority: canonical.createCanonicalPolicyAuthority({ issuerId: "ci.issuer", actorId: "ci.actor",
        authorities: ["docs"], compiledPolicyHash: first.compiledPolicyHash,
        repositoryIdentityHash, taskId: "task.policy", privateKey: issuerPrivateKey }), ...authorityContext })
      .reasonCodes.includes("canonical_policy_ownership_mismatch"));
    assert(canonical.evaluateCanonicalPolicy({ policy: first, changedFiles: ["config/owned.yml"] })
      .reasonCodes.includes("canonical_policy_ownership_authority_missing"));
  });
  check("self-hashed or mutated authority cannot grant platform ownership", () => {
    const selfGranted = { actorId: "caller", authorities: ["platform"],
      authorityHash: canonical.hashCanonicalJson({ actorId: "caller", authorities: ["platform"] }) };
    assert.equal(canonical.evaluateCanonicalPolicy({ policy: first, changedFiles: ["config/owned.yml"],
      authority: selfGranted, ...authorityContext }).decision, "deny");
    const rogue = generateKeyPairSync("ed25519");
    const rogueAuthority = canonical.createCanonicalPolicyAuthority({ issuerId: "caller.issuer",
      actorId: "caller", authorities: ["platform"], compiledPolicyHash: first.compiledPolicyHash,
      repositoryIdentityHash, taskId: "task.policy",
      privateKey: rogue.privateKey.export({ type: "pkcs8", format: "pem" }) });
    assert.equal(canonical.evaluateCanonicalPolicy({ policy: first, changedFiles: ["config/owned.yml"],
      authority: rogueAuthority, ...authorityContext }).decision, "deny");
    assert.equal(canonical.evaluateCanonicalPolicy({ policy: first, changedFiles: ["config/owned.yml"],
      authority: { ...authority, authorities: ["admin"] }, ...authorityContext }).decision, "deny");
    assert.equal(canonical.evaluateCanonicalPolicy({ policy: first, changedFiles: ["config/owned.yml"],
      authority: { ...authority, signature: `${authority.signature.slice(0, -1)}${authority.signature.endsWith("A") ? "B" : "A"}` },
      ...authorityContext }).decision, "deny");
  });
  check("authority is bound to policy repository and task", () => {
    for (const changed of [
      { policy: { ...first, compiledPolicyHash: canonical.hashCanonicalJson({ changed: "policy" }) } },
      { repositoryIdentityHash: canonical.hashCanonicalJson({ changed: "repository" }) },
      { taskId: "task.other" }
    ]) assert.equal(canonical.evaluateCanonicalPolicy({ policy: changed.policy ?? first,
      changedFiles: ["config/owned.yml"], authority, ...authorityContext, ...changed }).decision, "deny");
  });
  const mutation = (newContent) => ({ claims: [{ file: "src/a.ts", newContent }] });
  check("literal credentials deny without leaking values", () => {
    const secret = "live-secret-value-938475";
    const result = canonical.evaluateCanonicalPolicy({ policy: first, changedFiles: ["src/a.ts"],
      mutation: mutation(`const API_KEY = "${secret}";`) });
    assert.equal(result.decision, "deny");
    assert(result.reasonCodes.includes("canonical_policy_sensitive_literal"));
    assert(!JSON.stringify(result).includes(secret));
  });
  check("environment references placeholders and redacted values are allowed", () => {
    for (const content of ["const API_KEY = process.env.API_KEY;", "TOKEN = '<redacted>'",
      "PASSWORD = 'placeholder'", "SECRET = '***'"]) {
      assert.equal(canonical.evaluateCanonicalPolicy({ policy: first, changedFiles: ["src/a.ts"],
        mutation: mutation(content) }).decision, "allow");
    }
  });
  for (const [name, document, code] of [
    ["missing version", (({ schemaVersion, ...rest }) => rest)(policyDocument), "canonical_policy_schema_version_unsupported"],
    ["unsupported version", { ...policyDocument, schemaVersion: "2" }, "canonical_policy_schema_version_unsupported"],
    ["unknown field", { ...policyDocument, secret_override: true }, "canonical_policy_unknown_field"],
    ["malformed paired rules", { ...policyDocument, paired_files: {} }, "canonical_policy_schema_invalid"],
    ["malformed sensitive rules", { ...policyDocument, sensitive_paths: "**/.env" }, "canonical_policy_schema_invalid"],
    ["malformed ownership rules", { ...policyDocument, ownership_rules: {} }, "canonical_policy_schema_invalid"],
    ["unsupported required tests", { ...policyDocument, required_tests: [] }, "unsupported_policy_field"],
    ["unsupported test mappings", { ...policyDocument, required_test_mappings: [] }, "unsupported_policy_field"],
    ["unsupported module boundaries", { ...policyDocument, module_boundaries: [] }, "unsupported_policy_field"],
    ["unsupported missing authority rules", { ...policyDocument, missing_authority_rules: [] }, "unsupported_policy_field"],
    ["unsupported owner aliases", { ...policyDocument, owner_aliases: {} }, "unsupported_policy_field"],
    ["traversal", { ...policyDocument, allowed_paths: ["../escape"] }, "canonical_policy_path_invalid"],
    ["absolute path", { ...policyDocument, allowed_paths: ["/tmp/escape"] }, "canonical_policy_path_invalid"]
  ]) check(name, () => assert.throws(() => canonical.compileCanonicalPolicy({ repositoryPath: root,
    policyDocument: document }), (error) => error.code === code));
  const malformed = path.join(root, "bad.yml"); fs.writeFileSync(malformed, "schemaVersion: [\n");
  check("malformed YAML", () => assert.throws(() => canonical.compileCanonicalPolicy({
    repositoryPath: root, policyFilePath: "bad.yml" }),
  (error) => error.code === "canonical_policy_yaml_invalid"));
  check("conflicting security rules", () => assert.throws(() =>
    canonical.compileCanonicalPolicy({ repositoryPath: root, policyDocument: {
      ...policyDocument, sensitive_paths: [
        { pattern: ".env", disposition: "deny" },
        { pattern: ".env", disposition: "human_review" }
      ]
    } }), (error) => error.code === "canonical_policy_rule_conflict"));
  check("Windows separators normalize deterministically", () => {
    const windows = canonical.compileCanonicalPolicy({ repositoryPath: root,
      policyDocument: { ...policyDocument, allowed_paths: ["src\\**"], forbidden_paths: [] } });
    assert.deepEqual(windows.allowedPaths, ["src/a.ts", "src/b.ts"]);
  });
  check("Unicode paths and patterns normalize to NFC", () => {
    assert.equal(canonical.matchCanonicalPolicyPattern("docs/caf\u00e9.md", "docs/cafe\u0301.md"), true);
  });
  const outside = path.join(os.tmpdir(), `policy-outside-${Date.now()}`); fs.writeFileSync(outside, "x");
  roots.push(outside); fs.symlinkSync(outside, path.join(root, "src/escape.ts"));
  check("symlink escape", () => assert.throws(compile,
    (error) => error.code === "canonical_policy_symlink_escape"));
  fs.unlinkSync(path.join(root, "src/escape.ts"));

  check("legacy and canonical scope matching agree", () => {
    for (const file of ["src/a.ts", "src/b.ts", "outside.ts"]) {
      const result = canonical.evaluateCanonicalPolicy({ policy: first, changedFiles: [file] });
      const reviewed = legacy.reviewPatch({ task: { id: "parity", title: "parity", description: "" },
        diff: { raw: `diff --git a/${file} b/${file}\n`, changedFiles: [file] },
        policy: { allowed_paths: policyDocument.allowed_paths,
          forbidden_paths: policyDocument.forbidden_paths } });
      assert.equal(result.decision === "allow", !reviewed.findings.some((entry) => entry.category === "scope"));
    }
  });
  check("legacy and canonical paired sensitive and ownership decisions agree", () => {
    const parity = ({ policy = first, files, raw, canonicalAuthority, authorityFacts = [],
      mutation: candidateMutation, legacyPolicy = {} }) => {
      const canonicalResult = canonical.evaluateCanonicalPolicy({ policy, changedFiles: files,
        mutation: candidateMutation, ...(canonicalAuthority ? { authority: canonicalAuthority,
          ...authorityContext } : {}) });
      const reviewed = legacy.reviewPatch({ task: { id: "parity", title: "parity", description: "",
        authorityFacts }, diff: { raw, changedFiles: files }, policy: {
        allowed_paths: policyDocument.allowed_paths, forbidden_paths: policyDocument.forbidden_paths,
        paired_files: policyDocument.paired_files, sensitive_patterns: policyDocument.sensitive_patterns,
        ownership: { "config/**": "platform" }, ...legacyPolicy } });
      assert.equal(canonicalResult.decision === "allow", reviewed.decision === "approve");
    };
    parity({ files: ["package.json"], raw: "diff --git a/package.json b/package.json\n",
      mutation: { claims: [{ file: "package.json", newContent: "{}" }] } });
    parity({ files: ["src/a.ts"], raw: "diff --git a/src/a.ts b/src/a.ts\n@@ -0,0 +1 @@\n+const API_KEY = 'literal-secret';\n",
      mutation: mutation("const API_KEY = 'literal-secret';") });
    parity({ files: ["config/owned.yml"], raw: "diff --git a/config/owned.yml b/config/owned.yml\n" });
    parity({ files: ["config/owned.yml"], raw: "diff --git a/config/owned.yml b/config/owned.yml\n",
      canonicalAuthority: authority, authorityFacts: ["Authority: platform"] });
    const conditional = canonical.compileCanonicalPolicy({ repositoryPath: root,
      policyDocument: { ...policyDocument, paired_files: [{ source: "package.json",
        requires: "package-lock.json", changed_when_contains: ["dependencies"] }] } });
    parity({ policy: conditional, files: ["package.json"],
      raw: "diff --git a/package.json b/package.json\n@@ -1 +1 @@\n-{}\n+{\"name\":\"fixture\"}\n",
      mutation: { claims: [{ file: "package.json", newContent: '{"name":"fixture"}' }] },
      legacyPolicy: { paired_files: [{ source: "package.json", requires: "package-lock.json",
        changed_when_contains: ["dependencies"] }] } });
  });

  let plannerCalls = 0; let applyCalls = 0;
  const invalidRuntime = await canonical.runBoundedTask({ repositoryPath: root, taskId: "policy.invalid",
    objectiveHash: canonical.hashCanonicalJson({ task: "policy" }), authorityHash: canonical.hashCanonicalJson({ authority: "x" }),
    policyHash: canonical.hashCanonicalJson({ legacy: true }), allowedChangeFiles: ["src/a.ts"], forbiddenFiles: [],
    plannerMinimalityProvider: async () => { plannerCalls++; return {}; }, coderProvider: async () => ({}),
    contextRequestProvider: async () => ({}), applyExecutor: async () => { applyCalls++; return null; },
    canonicalPolicy: { policyDocument: { ...policyDocument, schemaVersion: "999" } }
  });
  check("invalid policy stops before providers and apply", () => {
    assert.equal(invalidRuntime.failure.code, "canonical_policy_schema_version_unsupported");
    assert.equal(plannerCalls, 0); assert.equal(applyCalls, 0);
  });

  console.log(`canonical policy compiler smoke passed (${checks} checks)`);
  for (const item of roots.reverse()) fs.rmSync(item, { recursive: true, force: true });
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
