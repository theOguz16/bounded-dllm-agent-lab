#!/usr/bin/env node
"use strict";

const { execFile } = require("node:child_process");
const { join } = require("node:path");
const { promisify } = require("node:util");
const { resolveVerificationProfile } = require("./controlled-coding-pilot-registry.cjs");

const exec = promisify(execFile);

async function typecheck({ sourceRoot, checkout }) {
  const tsc = join(sourceRoot, "node_modules/.bin/tsc");
  await exec(tsc, ["-p", join(checkout, "tsconfig.json")], {
    cwd: checkout,
    env: { ...process.env, NODE_OPTIONS: "" },
    maxBuffer: 10_000_000
  });
}

async function build({ checkout }) {
  await exec("npm", ["run", "build"], {
    cwd: checkout,
    env: { ...process.env, NODE_OPTIONS: "" },
    maxBuffer: 10_000_000
  });
}

async function testSmoke({ checkout }) {
  await exec("npm", ["run", "test:smoke"], {
    cwd: checkout,
    env: { ...process.env, NODE_OPTIONS: "" },
    maxBuffer: 10_000_000
  });
}

async function helpAcceptance({ checkout }) {
  const { checkHelpAcceptance } = require("./controlled-coding-pilot-help-check.cjs");
  await checkHelpAcceptance(checkout);
}

async function normalMissingEnv({ checkout }) {
  const normal = await exec(process.execPath, [
    join(checkout, "dist/apps/cli/src/model-worker-runpod-live-smoke.js")
  ], {
    cwd: checkout,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_OPTIONS: ""
    }
  });
  if (!normal.stdout.includes("\"status\": \"skipped\"")) {
    throw new Error("Controlled pilot normal missing-environment behavior changed.");
  }
}

async function runpodProxySmoke({ checkout }) {
  await exec(process.execPath, [
    join(checkout, "dist/apps/cli/src/model-worker-runpod-proxy-smoke.js")
  ], { cwd: checkout, env: { ...process.env, NODE_OPTIONS: "" } });
}

async function requestIdAcceptance({ checkout }) {
  const { checkRequestIdAcceptance } = require(
    "./controlled-coding-pilot-request-id-check.cjs"
  );
  await checkRequestIdAcceptance(checkout);
}

async function localJsonSchemaAcceptance({ checkout }) {
  const { checkLocalJsonSchemaAcceptance } = require(
    "./controlled-coding-pilot-local-json-schema-check.cjs"
  );
  await checkLocalJsonSchemaAcceptance(checkout);
}

const STAGE_EXECUTORS = Object.freeze({
  typecheck,
  build,
  test_smoke: testSmoke,
  help_acceptance: helpAcceptance,
  normal_missing_env: normalMissingEnv,
  runpod_proxy_smoke: runpodProxySmoke,
  request_id_acceptance: requestIdAcceptance,
  local_json_schema_acceptance: localJsonSchemaAcceptance
});

async function runVerificationProfile(stageIds, context) {
  const stages = resolveVerificationProfile(stageIds);
  for (const stage of stages) {
    const executeStage = STAGE_EXECUTORS[stage];
    if (typeof executeStage !== "function") {
      throw Object.assign(new Error("PILOT_DEFINITION_INVALID"), {
        pilotCode: "PILOT_DEFINITION_INVALID",
        verifierStage: stage
      });
    }
    try {
      await executeStage(context);
    } catch (error) {
      if (error && typeof error === "object" && error.verifierStage === undefined) {
        error.verifierStage = stage;
      }
      throw error;
    }
  }
  return stages;
}

module.exports = {
  STAGE_EXECUTORS,
  runVerificationProfile
};
