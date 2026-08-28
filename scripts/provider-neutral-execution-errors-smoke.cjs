#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');

const EXPECTED_CODES = [
  'AUTH_FAILURE',
  'RATE_LIMITED',
  'REQUEST_REJECTED',
  'STRUCTURED_OUTPUT_UNSUPPORTED',
  'TIMEOUT',
  'TRANSPORT_FAILURE',
  'MODEL_RESPONSE_INVALID'
];

async function main() {
  const common = await import('../dist/packages/integrations/src/provider-execution-error.js');
  const localModule = await import('../dist/packages/integrations/src/local-openai-compatible-model-client.js');
  const runpodModule = await import('../dist/packages/integrations/src/runpod-openai-compatible-model-client.js');

  assert.deepEqual([...common.PRODUCTION_MODEL_FAILURE_CODES], EXPECTED_CODES);
  for (const code of EXPECTED_CODES) {
    assert.equal(common.isProductionModelFailureCode(code), true, code);
    const thirdProviderError = Object.assign(new Error(`third-provider:${code}`), {code});
    assert.equal(
      common.isProductionModelFailureCode(thirdProviderError.code),
      true,
      `third provider must only need the common code ${code}`
    );
  }
  assert.equal(common.isProductionModelFailureCode('THIRD_PROVIDER_RATE_LIMITED'), false);

  const coreSource = fs.readFileSync(
    'packages/integrations/src/coding-executor.ts',
    'utf8'
  );
  const providerFailureSource = coreSource.slice(
    coreSource.indexOf('function providerFailure('),
    coreSource.indexOf('export class ProductionCodingExecutorAdapter')
  );

  assert.equal(
    /\b(?:RUNPOD|LOCAL)_/.test(coreSource),
    false,
    'execution core must not contain provider-specific error prefixes'
  );
  assert.equal(
    /\.status\b|HTTP\s+\d/.test(providerFailureSource),
    false,
    'execution core must not classify raw provider HTTP status codes'
  );
  for (const code of EXPECTED_CODES) {
    assert.equal(
      providerFailureSource.includes(`"${code}"`),
      true,
      `executor must understand normalized code ${code}`
    );
  }

  const local = new localModule.LocalOpenAICompatibleModelClient({
    schemaVersion: localModule.LOCAL_OPENAI_MODEL_CLIENT_VERSION,
    modelId: 'fixture-model',
    endpoint: {type: 'custom_openai_compatible', baseUrl: 'http://127.0.0.1:8000/v1'},
    structuredOutputMode: 'json_schema',
    requestTimeoutMs: 1000,
    maxOutputTokens: 64
  }, {getCredential: async () => ''});
  await assert.rejects(
    local.execute({}, {}),
    (error) => error instanceof common.ProductionModelError && error.code === 'AUTH_FAILURE'
  );

  const runpod = new runpodModule.RunpodOpenAICompatibleModelClient({
    schemaVersion: runpodModule.RUNPOD_MODEL_CLIENT_VERSION,
    modelId: 'fixture-model',
    endpoint: {type: 'serverless', endpointId: 'fixture-endpoint'},
    structuredOutputMode: 'json_schema',
    requestTimeoutMs: 1000,
    maxOutputTokens: 64
  }, {getCredential: async () => ''});
  await assert.rejects(
    runpod.execute({}, {}),
    (error) => error instanceof common.ProductionModelError && error.code === 'AUTH_FAILURE'
  );

  const abortController = new AbortController();
  abortController.abort();
  await assert.rejects(
    local.execute({}, {abortSignal: abortController.signal}),
    (error) => error instanceof Error && error.name === 'AbortError'
  );

  console.log(JSON.stringify({
    ok: true,
    taxonomy: EXPECTED_CODES,
    executorProviderPrefixes: false,
    executorRawHttpClassification: false,
    localBoundaryNormalized: true,
    runpodBoundaryNormalized: true,
    thirdProviderRequiresExecutorPrefixChange: false
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
