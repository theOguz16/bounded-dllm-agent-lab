#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync
} = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");

const root = process.cwd();
const script = join(root, "scripts/runpod-controlled-pilot-bootstrap.sh");
const target = join(root, "apps/cli/src/model-worker-runpod-live-smoke.ts");
const v2Targets = [
  join(root, "packages/worker-contract/src/index.ts"),
  join(root, "tests/smoke/contracts.ts")
];
const temporary = mkdtempSync(join(tmpdir(), "runpod-bootstrap-smoke-"));
const fakeBin = join(temporary, "bin");
const model = join(temporary, "model.gguf");
const llama = join(temporary, "llama-server");
const llamaArgs = join(temporary, "llama-args.txt");
const llamaPid = join(temporary, "llama-pid.txt");
const curlUrls = join(temporary, "curl-urls.txt");
const npmMarker = join(temporary, "npm-invoked.txt");
const log = join(temporary, "llama.log");
const redactionSentinel = "supplied-secret-must-not-appear";
const unsafeSentinel = "unsafe-environment-sentinel-must-not-appear";
const sourceBefore = readFileSync(target);
const v2SourcesBefore = v2Targets.map((path) => readFileSync(path));
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();

function freePort() {
  return spawnSync(process.execPath, ["-e", `
    const server = require("node:net").createServer();
    server.listen(0, "127.0.0.1", () => {
      process.stdout.write(String(server.address().port));
      server.close();
    });
  `], { encoding: "utf8" }).stdout;
}

const smokePort = freePort();

function executable(path, content) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function run(overrides = {}, cwd = root) {
  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    LLAMA_SERVER_BIN: llama,
    LLAMA_MODEL_PATH: model,
    LLAMA_SERVER_LOG: log,
    LLAMA_API_KEY: redactionSentinel,
    LLAMA_PORT: smokePort,
    LLAMA_STOP_RETRIES: "3",
    LLAMA_STOP_INTERVAL_SECONDS: "0.02",
    LLAMA_CLEANUP_RETRIES: "60",
    LLAMA_CLEANUP_INTERVAL_SECONDS: "0.02",
    LOCAL_READY_RETRIES: "2",
    PROXY_READY_RETRIES: "2",
    READINESS_INTERVAL_SECONDS: "0.02",
    RUNPOD_POD_ID: "smoke-pod",
    RUNPOD_BASE_URL: "https://override.invalid/v1",
    CONTROLLED_PILOT_OUTPUT_DIR: join(temporary, "report"),
    FAKE_LLAMA_ARGS_FILE: llamaArgs,
    FAKE_LLAMA_PID_FILE: llamaPid,
    FAKE_CURL_URLS_FILE: curlUrls,
    FAKE_NPM_MARKER: npmMarker,
    REAL_NODE_BIN: process.execPath,
    UNSAFE_ENV_SENTINEL: unsafeSentinel,
    ...overrides
  };
  if (!Object.hasOwn(overrides, "LLAMA_EXPECTED_BUILD")) delete env.LLAMA_EXPECTED_BUILD;
  if (!Object.hasOwn(overrides, "LLAMA_EXPECTED_COMMIT_PREFIX")) {
    delete env.LLAMA_EXPECTED_COMMIT_PREFIX;
  }
  return spawnSync("bash", [script], { cwd, env, encoding: "utf8", timeout: 10_000 });
}

function v2FixtureRepository(name) {
  const repository = join(temporary, name);
  const paths = [
    "scripts/controlled-coding-pilot.cjs",
    "pilots/controlled-real-coding-v2/worker-request-id-correlation/task.json",
    "packages/worker-contract/src/index.ts",
    "tests/smoke/contracts.ts"
  ];
  for (const path of paths) {
    mkdirSync(dirname(join(repository, path)), { recursive: true });
    cpSync(join(root, path), join(repository, path));
  }
  let result = spawnSync("git", ["init", "--quiet"], { cwd: repository, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  result = spawnSync("git", ["add", "."], { cwd: repository, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  result = spawnSync("git", ["-c", "user.name=Offline Fixture",
    "-c", "user.email=offline-fixture@example.invalid", "commit", "--quiet", "-m", "fixture"],
  { cwd: repository, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const commit = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repository, encoding: "utf8"
  }).stdout.trim();
  return { repository, commit };
}

try {
  mkdirSync(fakeBin);
  writeFileSync(model, "fake-model\n");
  executable(llama, `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  if [[ "\${FAKE_LLAMA_VERSION_INCLUDE_SECRET:-0}" == "1" ]]; then
    printf 'credential-like-noise=%s\\n' "$LLAMA_API_KEY" >&2
  fi
  printf '%b\\n' "\${FAKE_LLAMA_VERSION_OUTPUT:-version: 9754 (52b3df002)\\nbuilt with fake compiler for smoke}" >&2
  exit "\${FAKE_LLAMA_VERSION_EXIT:-0}"
fi
printf '%s\\n' "$@" > "$FAKE_LLAMA_ARGS_FILE"
printf '%s\\n' "$$" > "$FAKE_LLAMA_PID_FILE"
printf 'startup token=%s\\n' "$LLAMA_API_KEY"
trap 'exit 0' TERM INT
while :; do sleep 0.05; done
`);
  executable(join(fakeBin, "curl"), `#!/usr/bin/env bash
set -euo pipefail
output=""
url=""
while (($#)); do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    -w|--max-time|-H) shift 2 ;;
    -sS) shift ;;
    *) url="$1"; shift ;;
  esac
done
if [[ "\${FAKE_CURL_FAILURE:-0}" == "1" ]]; then
  exit 7
fi
printf '%s\\n' "$url" >> "$FAKE_CURL_URLS_FILE"
printf '%s\\n' '{"data":[{"id":"qwen2.5-coder-7b"}]}' > "$output"
printf '200'
`);
  executable(join(fakeBin, "npm"), `#!/usr/bin/env node
const fs = require("node:fs");
const cp = require("node:child_process");
const path = require("node:path");
fs.writeFileSync(process.env.FAKE_NPM_MARKER, process.argv.slice(2).join(" "));
const index = process.argv.indexOf("--output");
if (index < 0) process.exit(2);
const output = process.argv[index + 1];
const definitionIndex = process.argv.indexOf("--definition");
if (definitionIndex < 0) process.exit(2);
const definition = JSON.parse(fs.readFileSync(process.argv[definitionIndex + 1], "utf8"));
fs.mkdirSync(output, { recursive: true });
const commit = cp.execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
fs.writeFileSync(path.join(output, "pilot-report.json"), JSON.stringify({
  pilotId: definition.pilotId, status: "completed", sourceCommit: commit,
  providerCallCount: 1, retryCount: 0,
  authorityPassed: true, verifierPassed: true, artifactProduced: true,
  artifactValid: true, sourceWorktreeMutated: false, githubMutationObserved: false,
  budgetExceeded: false, cleanupCompleted: true, failureCode: null,
  modelId: process.env.LLM_MODEL_ID, patchLineCount: 27
}));
`);
  executable(join(fakeBin, "node"), `#!/usr/bin/env bash
if [[ "\${FAKE_PORT_OCCUPIED:-0}" == "1" && "\${1:-}" == "-e" && "\${2:-}" == *server.listen* ]]; then
  exit 1
fi
exec "$REAL_NODE_BIN" "$@"
`);

  const missingBinary = run({ LLAMA_SERVER_BIN: join(temporary, "missing-server") });
  assert.notEqual(missingBinary.status, 0);
  assert.match(missingBinary.stderr, /llama_server_missing_or_not_executable/);

  const missingModel = run({ LLAMA_MODEL_PATH: join(temporary, "missing-model") });
  assert.notEqual(missingModel.status, 0);
  assert.match(missingModel.stderr, /llama_model_missing/);

  rmSync(npmMarker, { force: true });
  const mismatch = run({ EXPECTED_SOURCE_COMMIT: "0".repeat(40) });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /expected_source_commit_mismatch/);
  assert.equal(existsSync(npmMarker), false, "provider command must not run on commit mismatch");

  for (const path of [llamaArgs, llamaPid, curlUrls, npmMarker]) rmSync(path, { force: true });
  const wrongBuild = run({
    FAKE_LLAMA_VERSION_OUTPUT: "untrusted noise\\nversion: 9755 (52b3df002)",
    FAKE_LLAMA_VERSION_INCLUDE_SECRET: "1"
  });
  assert.notEqual(wrongBuild.status, 0);
  assert.match(wrongBuild.stderr, /error=llama_provenance_verification_failed/);
  assert.match(wrongBuild.stderr, /expectedBuild=9754/);
  assert.match(wrongBuild.stderr, /actualBuild=9755/);
  assert.doesNotMatch(`${wrongBuild.stdout}\n${wrongBuild.stderr}`, new RegExp(redactionSentinel));
  for (const path of [llamaArgs, llamaPid, curlUrls, npmMarker]) {
    assert.equal(existsSync(path), false, `provenance mismatch reached ${path}`);
  }

  const wrongCommit = run({ FAKE_LLAMA_VERSION_OUTPUT: "version: 9754 (deadbeef)" });
  assert.notEqual(wrongCommit.status, 0);
  assert.match(wrongCommit.stderr, /expectedCommitPrefix=52b3df002/);
  assert.match(wrongCommit.stderr, /actualCommit=deadbeef/);
  assert.equal(existsSync(llamaArgs), false, "commit mismatch started llama-server");
  assert.equal(existsSync(npmMarker), false, "commit mismatch reached provider execution");

  const malformed = run({ FAKE_LLAMA_VERSION_OUTPUT: "version: banana (not-a-commit)" });
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /actualBuild=unavailable/);
  assert.match(malformed.stderr, /actualCommit=unavailable/);

  const missingVersion = run({ FAKE_LLAMA_VERSION_OUTPUT: "built with fake compiler only" });
  assert.notEqual(missingVersion.status, 0);
  assert.match(missingVersion.stderr, /llama_provenance_verification_failed/);

  const overrideBuild = run({
    LLAMA_EXPECTED_BUILD: "9755",
    LLAMA_EXPECTED_COMMIT_PREFIX: "52b3",
    FAKE_LLAMA_VERSION_OUTPUT: "version: 9755 (52b3df002)"
  });
  assert.equal(overrideBuild.status, 0, `${overrideBuild.stdout}\n${overrideBuild.stderr}`);
  assert.match(overrideBuild.stdout, /llama_build=9755/);
  assert.match(overrideBuild.stdout, /llama_commit=52b3df002/);

  const disabledCommitCheck = run({
    LLAMA_EXPECTED_COMMIT_PREFIX: "",
    FAKE_LLAMA_VERSION_OUTPUT: "version: 9754 (deadbeef)"
  });
  assert.equal(disabledCommitCheck.status, 0,
    `${disabledCommitCheck.stdout}\n${disabledCommitCheck.stderr}`);
  assert.match(disabledCommitCheck.stdout, /llama_build=9754/);
  assert.match(disabledCommitCheck.stdout, /llama_commit=deadbeef/);

  const disabledCommitWrongBuild = run({
    LLAMA_EXPECTED_COMMIT_PREFIX: "",
    FAKE_LLAMA_VERSION_OUTPUT: "version: 9755 (deadbeef)"
  });
  assert.notEqual(disabledCommitWrongBuild.status, 0);
  assert.match(disabledCommitWrongBuild.stderr, /expectedBuild=9754/);
  assert.match(disabledCommitWrongBuild.stderr, /actualBuild=9755/);

  rmSync(curlUrls, { force: true });
  const success = run({
    EXPECTED_SOURCE_COMMIT: head,
    FAKE_LLAMA_VERSION_INCLUDE_SECRET: "1"
  });
  assert.equal(success.status, 0, `${success.stdout}\n${success.stderr}`);
  const combined = `${success.stdout}\n${success.stderr}`;
  assert.doesNotMatch(combined, new RegExp(redactionSentinel));
  assert.doesNotMatch(combined, new RegExp(unsafeSentinel));
  assert.match(success.stdout, /FINAL_GATE=PASS/);
  assert.match(success.stdout, /local_model=ready/);
  assert.match(success.stdout, /runpod_proxy=ready/);
  assert.match(success.stdout, /llama_build=9754/);
  assert.match(success.stdout, /llama_commit=52b3df002/);
  assert.match(success.stdout, /llama_provenance=verified/);
  assert.match(success.stdout, /llamaBuild=9754/);
  assert.match(success.stdout, /llamaCommit=52b3df002/);
  assert.deepEqual(readFileSync(target), sourceBefore, "source target changed");
  const args = readFileSync(llamaArgs, "utf8");
  assert.match(args, /--ctx-size\n16384\n/);
  assert.match(args, /--parallel\n1\n/);
  assert.match(args, /--n-gpu-layers\n999\n/);
  const urls = readFileSync(curlUrls, "utf8");
  assert.match(urls, new RegExp(`http://127\\.0\\.0\\.1:${smokePort}/v1/models`));
  assert.match(urls, /https:\/\/override\.invalid\/v1\/models/);
  assert.match(readFileSync(npmMarker, "utf8"), /run:controlled-coding-pilot-live/);
  assert.match(readFileSync(npmMarker, "utf8"),
    /--definition pilots\/controlled-real-coding-v1\/runpod-live-help\/task\.json/);
  const cleanedPid = Number(readFileSync(llamaPid, "utf8").trim());
  assert.throws(() => process.kill(cleanedPid, 0), /ESRCH/,
    "server started by the bootstrap was not cleaned up");

  const v2Success = run({
    EXPECTED_SOURCE_COMMIT: head,
    CONTROLLED_PILOT_DEFINITION:
      "pilots/controlled-real-coding-v2/worker-request-id-correlation/task.json"
  });
  assert.equal(v2Success.status, 0, `${v2Success.stdout}\n${v2Success.stderr}`);
  assert.match(v2Success.stdout,
    /pilotDefinition=pilots\/controlled-real-coding-v2\/worker-request-id-correlation\/task\.json/);
  assert.match(readFileSync(npmMarker, "utf8"),
    /--definition pilots\/controlled-real-coding-v2\/worker-request-id-correlation\/task\.json/);
  v2Targets.forEach((path, index) => {
    assert.deepEqual(readFileSync(path), v2SourcesBefore[index], `${path} changed`);
  });

  const dirtyTargetFixture = v2FixtureRepository("dirty-v2-target-repository");
  const dirtyTargetPath = join(dirtyTargetFixture.repository,
    "packages/worker-contract/src/index.ts");
  writeFileSync(dirtyTargetPath, `${readFileSync(dirtyTargetPath, "utf8")}\n// dirty fixture\n`);
  rmSync(npmMarker, { force: true });
  rmSync(llamaArgs, { force: true });
  const dirtyTarget = run({
    EXPECTED_SOURCE_COMMIT: dirtyTargetFixture.commit,
    CONTROLLED_PILOT_DEFINITION:
      "pilots/controlled-real-coding-v2/worker-request-id-correlation/task.json"
  }, dirtyTargetFixture.repository);
  assert.notEqual(dirtyTarget.status, 0);
  assert.match(dirtyTarget.stderr, /source_target_source_mismatch/);
  assert.equal(existsSync(npmMarker), false, "dirty target reached provider execution");
  assert.equal(existsSync(llamaArgs), false, "dirty target started llama-server");

  const dirtyDefinitionFixture = v2FixtureRepository("dirty-v2-definition-repository");
  const dirtyDefinitionPath = join(dirtyDefinitionFixture.repository,
    "pilots/controlled-real-coding-v2/worker-request-id-correlation/task.json");
  writeFileSync(dirtyDefinitionPath, `${readFileSync(dirtyDefinitionPath, "utf8")}\n`);
  rmSync(npmMarker, { force: true });
  const dirtyDefinition = run({
    EXPECTED_SOURCE_COMMIT: dirtyDefinitionFixture.commit,
    CONTROLLED_PILOT_DEFINITION:
      "pilots/controlled-real-coding-v2/worker-request-id-correlation/task.json"
  }, dirtyDefinitionFixture.repository);
  assert.notEqual(dirtyDefinition.status, 0);
  assert.match(dirtyDefinition.stderr, /pilot_definition_source_mismatch/);
  assert.equal(existsSync(npmMarker), false, "dirty definition reached provider execution");
  assert.equal(existsSync(llamaArgs), false, "dirty definition started llama-server");

  rmSync(npmMarker, { force: true });
  const substitutedDefinition = run({ CONTROLLED_PILOT_DEFINITION: "tests/smoke/contracts.ts" });
  assert.notEqual(substitutedDefinition.status, 0);
  assert.match(substitutedDefinition.stderr, /unsupported_pilot_definition/);
  assert.equal(existsSync(npmMarker), false, "substituted definition reached provider execution");

  const readinessFailure = run({ FAKE_CURL_FAILURE: "1" });
  assert.notEqual(readinessFailure.status, 0);
  assert.doesNotMatch(`${readinessFailure.stdout}\n${readinessFailure.stderr}`,
    new RegExp(redactionSentinel));
  assert.match(readinessFailure.stderr, /startup token=\[REDACTED\]/);


  const startedAt = Date.now();
  const bounded = run({ FAKE_PORT_OCCUPIED: "1" });
  const elapsed = Date.now() - startedAt;
  assert.notEqual(bounded.status, 0);
  assert.match(bounded.stderr, /llama_port_remained_occupied/);
  assert.ok(elapsed < 3_000, `occupied-port cleanup took ${elapsed}ms`);

  const bootstrapSource = readFileSync(script, "utf8");
  assert.match(bootstrapSource, /LLAMA_EXPECTED_BUILD:-9754/);
  assert.match(bootstrapSource, /LLAMA_EXPECTED_COMMIT_PREFIX-52b3df002/);

  process.stdout.write("runpod controlled pilot bootstrap smoke: PASS\n");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
