#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = resolve(__dirname, "../..");
const SCRIPT = join(ROOT, "scripts/runpod/gate6-preflight.sh");
const MODEL_SHA = "2841aa314d916434860cfb8990347528dcdfe5c350dbcb9d1461dbee88ff2533";
const SOURCE_SHA = "5af37f14b251e542e1639608c1bbe313d14751ff";

function executable(path, body) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function fixture(overrides = {}) {
  const holder = mkdtempSync(join(tmpdir(), "gate6-preflight-test-"));
  const repo = join(holder, "repo");
  const bin = join(holder, "bin");
  const llamaDir = join(holder, "llama-bin");
  const model = join(holder, "model.gguf");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(llamaDir, { recursive: true });
  writeFileSync(join(repo, "scripts/gate6-verify.cjs"), "process.exit(0);\n");
  writeFileSync(model, "fixture-model\n");

  const realNode = process.execPath;
  executable(join(bin, "node"), `#!/usr/bin/env bash\nif [[ \"$1\" == \"--version\" ]]; then echo \"${overrides.nodeVersion ?? "v22.20.0"}\"; exit 0; fi\nif [[ \"$1\" == \"scripts/gate6-verify.cjs\" ]]; then exit \"${overrides.verifyExit ?? 0}\"; fi\nexec \"${realNode}\" \"$@\"\n`);
  executable(join(bin, "npm"), "#!/usr/bin/env bash\nexit 0\n");
  executable(join(bin, "git"), `#!/usr/bin/env bash\nargs=\"$*\"\nif [[ \"$args\" == *\"status --porcelain=v1\"* ]]; then printf '%s' '${overrides.dirty ? " M file\n" : ""}'; exit 0; fi\nif [[ \"$args\" == *\"fetch --quiet origin main\"* ]]; then exit ${overrides.fetchExit ?? 0}; fi\nif [[ \"$args\" == *\"rev-parse HEAD\"* ]]; then echo '${overrides.headSha ?? SOURCE_SHA}'; exit 0; fi\nif [[ \"$args\" == *\"rev-parse origin/main\"* ]]; then echo '${overrides.originSha ?? SOURCE_SHA}'; exit 0; fi\nif [[ \"$args\" == *\"ls-remote --exit-code\"* ]]; then [[ \"$args\" == *\"http.version=HTTP/1.1\"* ]] || exit 9; exit ${overrides.lsRemoteExit ?? 0}; fi\nexit 0\n`);
  executable(join(bin, "sha256sum"), `#!/usr/bin/env bash\necho '${overrides.modelSha ?? MODEL_SHA}  $1'\n`);
  executable(join(bin, "curl"), `#!/usr/bin/env bash\nout=''; url=''; while (($#)); do case \"$1\" in -o) out=\"$2\"; shift 2;; -w) shift 2;; -sS|--max-time) if [[ \"$1\" == \"--max-time\" ]]; then shift 2; else shift; fi;; *) url=\"$1\"; shift;; esac; done\nif [[ \"$url\" == */v1/models ]]; then status='${overrides.modelsStatus ?? "200"}'; printf '%s' '${JSON.stringify(overrides.modelsBody ?? { data: [{ id: "qwen3-coder-30b-a3b-q4-kxl-ctx16k-q8kv" }] })}' > \"$out\"; printf '%s' \"$status\"; exit 0; fi\nif [[ \"$url\" == */props ]]; then printf '%s' '${JSON.stringify(overrides.propsBody ?? { default_generation_settings: { n_ctx: 16384 } })}' > \"$out\"; printf '200'; exit 0; fi\nprintf '000'\n`);
  executable(join(llamaDir, "llama-server"), "#!/usr/bin/env bash\n[[ \"$1\" == \"--version\" ]] && { echo 'version fixture'; exit 0; }\nexit 0\n");

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GATE6_REPO_ROOT: repo,
    GATE6_LLAMA_SERVER_BIN: join(llamaDir, "llama-server"),
    GATE6_MODEL_PATH: model,
    GATE6_PREFLIGHT_READY_RETRIES: String(overrides.retries ?? 1),
    GATE6_PREFLIGHT_READY_INTERVAL_SECONDS: "0",
    LD_LIBRARY_PATH: overrides.ldLibraryPath ?? llamaDir,
    GATE6_EXPECTED_SOURCE_SHA: overrides.expectedSourceSha ?? SOURCE_SHA,
    GATE6_API_KEY: "SECRET_SENTINEL_SHOULD_NOT_PRINT"
  };
  return { holder, env };
}

function run(overrides = {}) {
  const fx = fixture(overrides);
  try {
    const result = spawnSync("bash", [SCRIPT], { cwd: ROOT, env: fx.env, encoding: "utf8" });
    return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
  } finally {
    rmSync(fx.holder, { recursive: true, force: true });
  }
}

function test(name, fn) {
  fn();
  process.stdout.write(`PASS ${name}\n`);
}

test("missing node fails before benchmark", () => {
  const fx = fixture();
  try {
    const nodePath = join(fx.env.PATH.split(":")[0], "node");
    rmSync(nodePath, { force: true });
    const result = spawnSync("bash", [SCRIPT], { env: fx.env, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /RUNPOD_PREFLIGHT_NODE_MISSING/);
    assert.match(result.stderr, /setup_22\.x/);
  } finally { rmSync(fx.holder, { recursive: true, force: true }); }
});

test("wrong Node major fails", () => {
  const r = run({ nodeVersion: "v20.19.0" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /RUNPOD_PREFLIGHT_NODE_VERSION_UNSUPPORTED/);
});

test("dirty git tree fails", () => {
  const r = run({ dirty: true });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /RUNPOD_PREFLIGHT_WORKTREE_DIRTY/);
});

test("wrong source SHA fails", () => {
  const r = run({ headSha: "1".repeat(40), originSha: "2".repeat(40), expectedSourceSha: "1".repeat(40) });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /RUNPOD_PREFLIGHT_SOURCE_SHA_MISMATCH/);
});

test("HTTP/1.1 public ls-remote works in fake environment", () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
});

test("wrong model SHA fails", () => {
  const r = run({ modelSha: "0".repeat(64) });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /RUNPOD_PREFLIGHT_MODEL_SHA_MISMATCH/);
});

test("llama 503 classified as not-ready", () => {
  const r = run({ modelsStatus: "503" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /MODEL_LOADING/);
  assert.match(r.stderr, /RUNPOD_PREFLIGHT_LLAMA_NOT_READY/);
});

test("wrong model alias fails", () => {
  const r = run({ modelsBody: { data: [{ id: "wrong-model" }] } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /RUNPOD_PREFLIGHT_MODEL_ALIAS_MISMATCH/);
});

test("wrong n_ctx fails", () => {
  const r = run({ propsBody: { default_generation_settings: { n_ctx: 8192 } } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /RUNPOD_PREFLIGHT_N_CTX_MISMATCH/);
});

test("gate6 verifier failure aborts", () => {
  const r = run({ verifyExit: 1 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /RUNPOD_PREFLIGHT_GATE6_VERIFY_FAILED/);
});

test("API key never printed", () => {
  const r = run();
  assert.equal(`${r.stdout}${r.stderr}`.includes("SECRET_SENTINEL_SHOULD_NOT_PRINT"), false);
});

test("clean fixture reaches PREFLIGHT=PASS", () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RUNPOD_GATE6_PREFLIGHT=PASS/);
  assert.match(r.stdout, new RegExp(`MODEL_SHA256=${MODEL_SHA}`));
  assert.match(r.stdout, /MODEL_ALIAS=qwen3-coder-30b-a3b-q4-kxl-ctx16k-q8kv/);
  assert.match(r.stdout, /MODEL_N_CTX=16384/);
  assert.match(r.stdout, /GATE6_VERIFY=PASS/);
});
