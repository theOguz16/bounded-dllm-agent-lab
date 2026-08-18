#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const root = process.cwd();
const script = join(root, "scripts/runpod-controlled-pilot-bootstrap.sh");
const target = join(root, "apps/cli/src/model-worker-runpod-live-smoke.ts");
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

function run(overrides = {}) {
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
  return spawnSync("bash", [script], { cwd: root, env, encoding: "utf8", timeout: 10_000 });
}

try {
  mkdirSync(fakeBin);
  writeFileSync(model, "fake-model\n");
  executable(llama, `#!/usr/bin/env bash
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
fs.mkdirSync(output, { recursive: true });
const commit = cp.execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
fs.writeFileSync(path.join(output, "pilot-report.json"), JSON.stringify({
  status: "completed", sourceCommit: commit, providerCallCount: 1, retryCount: 0,
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

  rmSync(curlUrls, { force: true });
  const success = run({ EXPECTED_SOURCE_COMMIT: head });
  assert.equal(success.status, 0, `${success.stdout}\n${success.stderr}`);
  const combined = `${success.stdout}\n${success.stderr}`;
  assert.doesNotMatch(combined, new RegExp(redactionSentinel));
  assert.doesNotMatch(combined, new RegExp(unsafeSentinel));
  assert.match(success.stdout, /FINAL_GATE=PASS/);
  assert.match(success.stdout, /local_model=ready/);
  assert.match(success.stdout, /runpod_proxy=ready/);
  assert.deepEqual(readFileSync(target), sourceBefore, "source target changed");
  const args = readFileSync(llamaArgs, "utf8");
  assert.match(args, /--ctx-size\n16384\n/);
  assert.match(args, /--parallel\n1\n/);
  assert.match(args, /--n-gpu-layers\n999\n/);
  const urls = readFileSync(curlUrls, "utf8");
  assert.match(urls, new RegExp(`http://127\\.0\\.0\\.1:${smokePort}/v1/models`));
  assert.match(urls, /https:\/\/override\.invalid\/v1\/models/);
  assert.match(readFileSync(npmMarker, "utf8"), /run:controlled-coding-pilot-live/);
  const cleanedPid = Number(readFileSync(llamaPid, "utf8").trim());
  assert.throws(() => process.kill(cleanedPid, 0), /ESRCH/,
    "server started by the bootstrap was not cleaned up");

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

  process.stdout.write("runpod controlled pilot bootstrap smoke: PASS\n");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
