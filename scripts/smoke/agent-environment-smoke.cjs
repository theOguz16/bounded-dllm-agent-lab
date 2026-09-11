#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");

const repoRoot = resolve(__dirname, "../..");

async function main() {
  const moduleUrl = pathToFileURL(
    resolve(repoRoot, "dist/packages/integrations/src/agent-environment.js")
  ).href;
  const {
    AGENT_ENVIRONMENT_VERSION,
    AGENT_ENVIRONMENT_ALLOWED_NAMES,
    AGENT_ENVIRONMENT_ALLOWED_PREFIXES,
    createAgentEnvironment,
    isAllowedAgentEnvironmentVariable
  } = await import(moduleUrl);

  assert.equal(AGENT_ENVIRONMENT_VERSION, "agent-environment/v1");
  assert.equal(AGENT_ENVIRONMENT_ALLOWED_NAMES.includes("PATH"), true);
  assert.equal(AGENT_ENVIRONMENT_ALLOWED_NAMES.includes("OPENAI_API_KEY"), true);
  assert.equal(AGENT_ENVIRONMENT_ALLOWED_NAMES.includes("CODEX_API_KEY"), true);
  assert.equal(AGENT_ENVIRONMENT_ALLOWED_NAMES.includes("CODEX_ACCESS_TOKEN"), true);
  assert.deepEqual(AGENT_ENVIRONMENT_ALLOWED_PREFIXES, ["LC_"]);

  const fixture = {
    PATH: process.env.PATH ?? "",
    HOME: "/tmp/p6-home",
    USER: "bounded-user",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    LC_TEST: "allowed-locale",
    TMPDIR: "/tmp/p6-agent",
    TERM: "xterm-256color",
    CODEX_HOME: "/tmp/p6-codex-home",
    OPENAI_API_KEY: "openai-fixture-key",
    CODEX_API_KEY: "codex-fixture-key",
    CODEX_ACCESS_TOKEN: "codex-fixture-token",
    SUPER_SECRET_VALUE: "abc123",
    AWS_SECRET_ACCESS_KEY: "aws-fixture-secret",
    GITHUB_TOKEN: "github-fixture-secret",
    DATABASE_URL: "postgres://fixture-secret",
    UNDEFINED_ALLOWED: undefined
  };

  const environment = createAgentEnvironment(fixture);

  assert.equal(environment.PATH, fixture.PATH);
  assert.equal(environment.HOME, fixture.HOME);
  assert.equal(environment.USER, fixture.USER);
  assert.equal(environment.LANG, fixture.LANG);
  assert.equal(environment.LC_ALL, fixture.LC_ALL);
  assert.equal(environment.LC_TEST, fixture.LC_TEST);
  assert.equal(environment.TMPDIR, fixture.TMPDIR);
  assert.equal(environment.TERM, fixture.TERM);
  assert.equal(environment.CODEX_HOME, fixture.CODEX_HOME);
  assert.equal(environment.OPENAI_API_KEY, fixture.OPENAI_API_KEY);
  assert.equal(environment.CODEX_API_KEY, fixture.CODEX_API_KEY);
  assert.equal(environment.CODEX_ACCESS_TOKEN, fixture.CODEX_ACCESS_TOKEN);

  for (const forbidden of [
    "SUPER_SECRET_VALUE",
    "AWS_SECRET_ACCESS_KEY",
    "GITHUB_TOKEN",
    "DATABASE_URL"
  ]) {
    assert.equal(forbidden in environment, false, `${forbidden} leaked into agent environment`);
    assert.equal(isAllowedAgentEnvironmentVariable(forbidden), false);
  }

  assert.equal(isAllowedAgentEnvironmentVariable("LC_MESSAGES"), true);
  assert.equal(isAllowedAgentEnvironmentVariable("PATH"), true);
  assert.equal(isAllowedAgentEnvironmentVariable("Path"), true);

  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `process.stdout.write(JSON.stringify({
        secret: process.env.SUPER_SECRET_VALUE ?? null,
        aws: process.env.AWS_SECRET_ACCESS_KEY ?? null,
        github: process.env.GITHUB_TOKEN ?? null,
        database: process.env.DATABASE_URL ?? null,
        path: process.env.PATH ?? process.env.Path ?? null,
        locale: process.env.LC_TEST ?? null,
        codexHome: process.env.CODEX_HOME ?? null,
        openaiAuth: process.env.OPENAI_API_KEY ?? null,
        codexAuth: process.env.CODEX_API_KEY ?? null,
        codexAccess: process.env.CODEX_ACCESS_TOKEN ?? null
      }));`
    ],
    {
      env: { ...environment },
      encoding: "utf8"
    }
  );

  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  assert.deepEqual(observed, {
    secret: null,
    aws: null,
    github: null,
    database: null,
    path: fixture.PATH,
    locale: fixture.LC_TEST,
    codexHome: fixture.CODEX_HOME,
    openaiAuth: fixture.OPENAI_API_KEY,
    codexAuth: fixture.CODEX_API_KEY,
    codexAccess: fixture.CODEX_ACCESS_TOKEN
  });

  const adapterSource = readFileSync(
    resolve(repoRoot, "packages/integrations/src/codex-agent-adapter.ts"),
    "utf8"
  );
  assert.equal(adapterSource.includes("new Codex()"), false);
  assert.equal(adapterSource.includes("...process.env"), false);
  assert.equal(adapterSource.includes("const environmentSource = options.environment ?? process.env;"), true);
  assert.equal(adapterSource.includes("createAgentEnvironment(environmentSource)"), true);
  assert.equal(adapterSource.includes("new Codex({ env: { ...environment } })"), true);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    version: AGENT_ENVIRONMENT_VERSION,
    childProcessSecretVisible: observed.secret !== null,
    generalEnvironmentInherited: false,
    allowedExactNames: AGENT_ENVIRONMENT_ALLOWED_NAMES,
    allowedPrefixes: AGENT_ENVIRONMENT_ALLOWED_PREFIXES
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
