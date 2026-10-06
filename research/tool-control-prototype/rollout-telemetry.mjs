/** Bounded prospective Codex rollout telemetry. Raw records are read in memory only. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const VERSION = 'research-mcp-response-trajectory/v2';
const sha = x => 'sha256:' + createHash('sha256').update(x).digest('hex');
const hash = x => sha(JSON.stringify(x));
const bytes = x => Buffer.byteLength(x, 'utf8');
const count = x => Number.isSafeInteger(x) && x >= 0 ? x : null;
const blocks = x => Array.isArray(x.content) ? x.content.filter(
  b => b?.type === 'input_text' && typeof b.text === 'string') : [];
const usage = x => {
  const input = count(x?.input_tokens), cached = count(x?.cached_input_tokens);
  return { inputTokens: input, cachedInputTokens: cached,
    uncachedInputTokens: input !== null && cached !== null && cached <= input ?
      input - cached : null, cacheWriteInputTokens: count(x?.cache_write_input_tokens),
    outputTokens: count(x?.output_tokens),
    reasoningOutputTokens: count(x?.reasoning_output_tokens) };
};

export function toolConfigIdentity(config, serverName, toolName) {
  const server = config.mcp_servers[serverName];
  const identity = { server: serverName, tool: toolName, command: server.command,
    script: server.args[0], requestedPath: server.args[3],
    approvalMode: server.tools?.[toolName]?.approval_mode ?? null };
  return { hash: hash(identity), ...identity };
}

/**
 * Canonical extraction from one identified MCP call and its returned tool output.
 * Only validated hashes, sizes, identity, status, and order leave this function.
 */
export function extractMcpResult({ call, item = null, output, observation,
  serverName = 'research_read_file', toolName = 'read_file',
  sequence, deliveryOrder }) {
  const base = { sequence, server: serverName, tool: toolName,
    mode: observation?.mcpMode ?? null, callId: typeof call?.call_id === 'string' ? call.call_id : null,
    itemId: typeof item?.id === 'string' ? item.id : null,
    status: 'unknown_tool_result_shape', failureCategory: 'unknown_tool_result_shape',
    representation: null, originalBytes: null, coderFacingBytes: null,
    originalHash: null, coderFacingHash: null, deliveryOrder,
    deliveredBeforeResponse: null };
  const signature = 'tools.mcp__' + serverName + '__' + toolName + '(';
  if (call?.type !== 'custom_tool_call' || call.name !== 'exec' ||
      call.status !== 'completed' || !base.callId ||
      typeof call.input !== 'string' || !call.input.includes(signature) ||
      output?.type !== 'custom_tool_call_output' ||
      output.call_id !== base.callId ||
      item && (item.type !== 'McpToolCall' || item.server !== serverName ||
        item.tool !== toolName)) return base;
  if (item?.status === 'failed')
    return { ...base, status: 'failed', failureCategory: 'mcp_item_failed' };
  if (item && item.status !== 'completed') return base;
  const outputBlocks = Array.isArray(output.output) ? output.output : [];
  let resultText = null, representation = null, wrapperFailure = false;
  for (const block of outputBlocks) {
    if (block?.type !== 'input_text' || typeof block.text !== 'string') continue;
    if (observation?.coderFacingResultHash &&
        sha(block.text) === observation.coderFacingResultHash) {
      if (resultText !== null) return base;
      resultText = block.text;
      representation = 'direct';
      continue;
    }
    let parsed;
    try { parsed = JSON.parse(block.text); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        !Object.hasOwn(parsed,'content')) continue;
    if (parsed.isError === true) { wrapperFailure = true; continue; }
    if (Object.keys(parsed).some(key => key !== 'content' && key !== 'isError') ||
        !Array.isArray(parsed.content) || parsed.content.length !== 1 ||
        parsed.content[0]?.type !== 'text' ||
        typeof parsed.content[0].text !== 'string') return base;
    if (resultText !== null) return base;
    resultText = parsed.content[0].text;
    representation = 'wrapped_json_text';
  }
  if (wrapperFailure) return { ...base, status:'failed',
    failureCategory:'wrapped_is_error' };
  if (resultText === null || !observation?.coderFacingResultHash ||
      sha(resultText) !== observation.coderFacingResultHash ||
      bytes(resultText) !== observation.coderFacingBytes) return base;
  if (item) {
    const content=item.result?.content;
    if (!Array.isArray(content) || content.length !== 1 ||
        content[0]?.type !== 'text' || typeof content[0].text !== 'string' ||
        sha(content[0].text) !== observation.coderFacingResultHash ||
        bytes(content[0].text) !== observation.coderFacingBytes) return base;
  }
  return { ...base, status:'completed', failureCategory:null, representation,
    originalBytes:observation.originalBytes,
    coderFacingBytes:bytes(resultText),
    originalHash:observation.originalResultHash,
    coderFacingHash:sha(resultText) };
}

/** A usage record belongs to the response that generated the preceding assistant items. */
export function reconstructRolloutTelemetry(jsonl, { suppliedPrompt,
  mcpUseInstructionHash, toolConfigHash, expectedMode, mcpObservation,
  serverName = 'research_read_file', toolName = 'read_file' }) {
  assert.equal(typeof suppliedPrompt, 'string');
  assert.ok(mcpObservation?.coderFacingResultHash);
  const ambient = [], runtime = [], responses = [], mcpResults = [];
  let promptObserved = false, delivered = 0, completedTools = 0;
  let responseStart = null, pendingCalls = [], preMcpAssistantActivity = false;
  const openCalls = new Map();
  let mcpCallSeen = false, truncated = false;
  const callName = 'mcp__' + serverName + '__' + toolName;
  for (const [i, line] of jsonl.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { truncated = true; break; }
    const p = row?.payload;
    if (!p || typeof p !== 'object') continue;
    if (row.type === 'response_item' && p.type === 'message' &&
        ['system','developer'].includes(p.role) && !responses.length) {
      for (const b of blocks(p)) {
        if (ambient.length >= 32) { truncated = true; break; }
        ambient.push({ sequence: ambient.length + 1, role: p.role, type: b.type,
          byteCount: bytes(b.text), hash: sha(b.text) });
      }
      continue;
    }
    if (row.type === 'response_item' && p.type === 'message' && p.role === 'user') {
      if (blocks(p).some(b => b.text === suppliedPrompt)) promptObserved = true;
      else if (!promptObserved) for (const b of blocks(p)) {
        if (runtime.length >= 16) { truncated = true; break; }
        runtime.push({ sequence: runtime.length + 1, role: 'user',
          type: b.type, byteCount: bytes(b.text), hash: sha(b.text) });
      }
      continue;
    }
    const assistantItem = row.type === 'response_item' &&
      (p.type === 'reasoning' || p.type === 'custom_tool_call' ||
       p.type === 'message' && p.role === 'assistant');
    if (assistantItem && responseStart === null)
      responseStart = { resultCount: delivered, toolCount: completedTools, order: i + 1 };
    if (row.type === 'response_item' && p.type === 'message' &&
        p.role === 'assistant' && !mcpCallSeen) preMcpAssistantActivity = true;
    if (row.type === 'response_item' && p.type === 'custom_tool_call') {
      const input = typeof p.input === 'string' ? p.input : '';
      const call = { mcp: input.includes(callName),
        discovery: input.includes('ALL_TOOLS'), payload: p, item: null };
      pendingCalls.push(call);
      if (typeof p.call_id === 'string') openCalls.set(p.call_id,call);
      if (call.mcp) mcpCallSeen = true;
      continue;
    }
    if (row.type === 'event_msg' && p.type === 'item_completed' &&
        p.item?.type === 'McpToolCall') {
      const candidates=[...openCalls.values()].filter(call=>call.mcp && call.item===null);
      if (candidates.length===1) candidates[0].item=p.item;
      continue;
    }
    if (row.type === 'response_item' && p.type === 'custom_tool_call_output') {
      completedTools++;
      const call=openCalls.get(p.call_id);
      if (call?.mcp) {
        if (mcpResults.length >= 16) { truncated = true; break; }
        const result=extractMcpResult({call:call.payload,item:call.item,output:p,
          observation:mcpObservation,serverName,toolName,
          sequence:mcpResults.length+1,deliveryOrder:i+1});
        mcpResults.push(result);
        if(result.status==='completed') delivered++;
      }
      if (typeof p.call_id === 'string') openCalls.delete(p.call_id);
      continue;
    }
    if (row.type !== 'token_usage_record') continue;
    if (responses.length >= 32) { truncated = true; break; }
    const start = responseStart ?? { resultCount: null, toolCount: null, order: null };
    const postCount = responses.filter(r => r.mcpResultDeliveredBeforeResponse).length;
    const phase = pendingCalls.some(c => c.mcp) ? 'tool_call_generation' :
      start.resultCount > 0 ? postCount === 0 ? 'post_tool_result' :
        'additional_post_tool_result' :
      pendingCalls.some(c => c.discovery) ? 'pre_tool_discovery' :
      start.resultCount === 0 ? 'unknown_pre_tool' : 'unknown_post_tool';
    responses.push({ sequence: responses.length + 1, phase, order: i + 1,
      responseStartOrder: start.order,
      mcpResultDeliveredBeforeResponse: start.resultCount > 0,
      mcpResultsDeliveredBeforeResponse: start.resultCount,
      cumulativeToolCountBeforeResponse: start.toolCount,
      ...usage(p.usage) });
    responseStart = null;
    pendingCalls = [];
  }
  if (responseStart !== null) {
    const start=responseStart;
    const postCount=responses.filter(r=>r.mcpResultDeliveredBeforeResponse).length;
    const phase=pendingCalls.some(c=>c.mcp) ? 'tool_call_generation' :
      start.resultCount > 0 ? postCount === 0 ? 'post_tool_result' :
        'additional_post_tool_result' :
      pendingCalls.some(c=>c.discovery) ? 'pre_tool_discovery' :
      start.resultCount === 0 ? 'unknown_pre_tool' : 'unknown_post_tool';
    responses.push({ sequence:responses.length+1,phase,order:null,
      responseStartOrder:start.order,
      mcpResultDeliveredBeforeResponse:start.resultCount>0,
      mcpResultsDeliveredBeforeResponse:start.resultCount,
      cumulativeToolCountBeforeResponse:start.toolCount,...usage(null) });
    truncated=true;
  }
  for (const result of mcpResults)
    result.deliveredBeforeResponse = result.status==='completed' ?
      responses.find(r => r.responseStartOrder !== null &&
        r.responseStartOrder > result.deliveryOrder)?.sequence ?? null : null;
  const ambientInstruction = { blocks: ambient,
    totalBytes: ambient.reduce((sum,b) => sum + b.byteCount, 0),
    combinedCanonicalHash: hash(ambient) };
  const runtimeContext = { blocks: runtime,
    totalBytes: runtime.reduce((sum,b) => sum + b.byteCount, 0),
    combinedCanonicalHash: hash(runtime) };
  const suppliedPromptIdentity = { byteCount: bytes(suppliedPrompt),
    hash: sha(suppliedPrompt), observedInRollout: promptObserved };
  const toolIdentity = { configHash: toolConfigHash,
    mcpUseInstructionHash, expectedMode };
  const canonical = { ambientInstruction, runtimeContext,
    suppliedPromptIdentity, toolIdentity,
    mcpResults, modelResponses: responses, preMcpAssistantActivity };
  return { schemaVersion: VERSION,
    status: truncated || !promptObserved || !ambient.length ||
      !responses.length || !mcpResults.some(r=>r.status==='completed') ||
      mcpResults.some(r=>r.status!=='completed') ||
      !responses.some(r=>r.mcpResultDeliveredBeforeResponse) ?
      'partial' : 'observed',
    ambientInstruction, runtimeContext, suppliedPromptIdentity, toolIdentity, mcpResults,
    modelResponses: responses, preMcpAssistantActivity,
    canonicalTrajectoryFingerprint: hash(canonical),
    bounded: true, truncated,
    unavailable: ['providerHttpRequestBody','providerCacheKey','cacheSegmentation',
      'cachedPrefixBoundary','componentLevelTokenAttribution'] };
}

export function comparePairedTelemetry(treatment, control) {
  const flags = [];
  const add = (code, classification) => flags.push({ code, classification });
  if (treatment.ambientInstruction.combinedCanonicalHash !==
      control.ambientInstruction.combinedCanonicalHash)
    add('AMBIENT_INSTRUCTION_DRIFT', 'experiment-confounding drift');
  if (treatment.ambientInstruction.totalBytes !== control.ambientInstruction.totalBytes)
    add('AMBIENT_INSTRUCTION_BYTE_DRIFT', 'experiment-confounding drift');
  if (treatment.runtimeContext.combinedCanonicalHash !==
      control.runtimeContext.combinedCanonicalHash)
    add('RUNTIME_CONTEXT_DRIFT', 'benign runtime difference');
  if (treatment.suppliedPromptIdentity.hash !== control.suppliedPromptIdentity.hash)
    add('SUPPLIED_PROMPT_DRIFT', 'experiment-confounding drift');
  if (treatment.toolIdentity.configHash !== control.toolIdentity.configHash)
    add('TOOL_CONFIGURATION_DRIFT', 'experiment-confounding drift');
  if (treatment.toolIdentity.mcpUseInstructionHash !==
      control.toolIdentity.mcpUseInstructionHash)
    add('MCP_USE_INSTRUCTION_DRIFT', 'experiment-confounding drift');
  if (treatment.mcpResults.some(r => r.mode !== treatment.toolIdentity.expectedMode) ||
      control.mcpResults.some(r => r.mode !== control.toolIdentity.expectedMode))
    add('RESULT_MODE_MISMATCH', 'experiment-confounding drift');
  if (treatment.mcpResults[0]?.coderFacingHash !==
      control.mcpResults[0]?.coderFacingHash)
    add('RESULT_REPRESENTATION_DIFFERENCE', 'expected condition difference');
  if (treatment.modelResponses.length !== 3 || control.modelResponses.length !== 3)
    add('UNEXPECTED_MODEL_RESPONSE_COUNT', 'unknown');
  return { flags, cleanAmbientIdentity: !flags.some(f =>
    f.code === 'AMBIENT_INSTRUCTION_DRIFT' ||
    f.code === 'AMBIENT_INSTRUCTION_BYTE_DRIFT') };
}

export async function findRollout(sessionId, sessionsRoot =
  path.join(os.homedir(), '.codex', 'sessions')) {
  assert.match(sessionId, /^[0-9a-f-]{36}$/);
  const matches = [];
  for (const year of (await fs.readdir(sessionsRoot,
    { withFileTypes: true })).filter(x => x.isDirectory()))
    for (const month of (await fs.readdir(path.join(sessionsRoot,year.name),
      { withFileTypes: true })).filter(x => x.isDirectory()))
      for (const day of (await fs.readdir(path.join(sessionsRoot,year.name,month.name),
        { withFileTypes: true })).filter(x => x.isDirectory())) {
        const dir = path.join(sessionsRoot,year.name,month.name,day.name);
        for (const file of await fs.readdir(dir))
          if (file.endsWith('-' + sessionId + '.jsonl'))
            matches.push(path.join(dir,file));
      }
  assert.equal(matches.length, 1, 'exactly one Codex rollout required');
  return matches[0];
}
export async function captureRolloutTelemetry({ sessionId, sessionsRoot, ...options }) {
  const file = await findRollout(sessionId, sessionsRoot);
  return reconstructRolloutTelemetry(await fs.readFile(file,'utf8'), options);
}

/** Validate the allowlisted durable shape before any telemetry file is written. */
export function validateBoundedTelemetry(value) {
  const keys = (object, expected) => {
    assert.ok(object && typeof object === 'object' && !Array.isArray(object));
    assert.deepEqual(Object.keys(object).sort(), expected.slice().sort());
  };
  const digest = x => assert.match(x, /^sha256:[0-9a-f]{64}$/);
  keys(value, ['schemaVersion','status','ambientInstruction','runtimeContext',
    'suppliedPromptIdentity','toolIdentity','mcpResults','modelResponses',
    'preMcpAssistantActivity','canonicalTrajectoryFingerprint','bounded',
    'truncated','unavailable']);
  assert.equal(value.schemaVersion,VERSION);
  assert.ok(['observed','partial'].includes(value.status));
  assert.equal(value.bounded,true);
  for(const group of [value.ambientInstruction,value.runtimeContext]) {
    keys(group,['blocks','totalBytes','combinedCanonicalHash']);
    assert.ok(Array.isArray(group.blocks) && group.blocks.length <= 32);
    assert.equal(count(group.totalBytes),group.totalBytes);
    digest(group.combinedCanonicalHash);
    for(const block of group.blocks) {
      keys(block,['sequence','role','type','byteCount','hash']);
      assert.equal(count(block.sequence),block.sequence);
      assert.equal(count(block.byteCount),block.byteCount);
      assert.ok(['system','developer','user'].includes(block.role));
      assert.equal(block.type,'input_text');
      digest(block.hash);
    }
  }
  keys(value.suppliedPromptIdentity,['byteCount','hash','observedInRollout']);
  assert.equal(count(value.suppliedPromptIdentity.byteCount),
    value.suppliedPromptIdentity.byteCount);
  digest(value.suppliedPromptIdentity.hash);
  keys(value.toolIdentity,['configHash','mcpUseInstructionHash','expectedMode']);
  digest(value.toolIdentity.configHash);
  digest(value.toolIdentity.mcpUseInstructionHash);
  assert.ok(['identity','bounded'].includes(value.toolIdentity.expectedMode));
  assert.ok(Array.isArray(value.mcpResults) && value.mcpResults.length <= 16);
  for(const result of value.mcpResults) {
    keys(result,['sequence','server','tool','mode','callId','itemId','status',
      'failureCategory','representation','originalBytes','coderFacingBytes',
      'originalHash','coderFacingHash','deliveryOrder','deliveredBeforeResponse']);
    assert.equal(result.server,'research_read_file');
    assert.equal(result.tool,'read_file');
    assert.equal(count(result.sequence),result.sequence);
    assert.ok(['identity','bounded'].includes(result.mode));
    assert.ok(result.callId === null ||
      typeof result.callId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(result.callId));
    assert.ok(result.itemId === null ||
      typeof result.itemId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(result.itemId));
    assert.ok(['completed','failed','unknown_tool_result_shape'].includes(result.status));
    assert.ok(result.failureCategory === null ||
      ['mcp_item_failed','wrapped_is_error','unknown_tool_result_shape'].includes(
        result.failureCategory));
    assert.ok(result.representation === null ||
      ['direct','wrapped_json_text'].includes(result.representation));
    assert.equal(count(result.deliveryOrder),result.deliveryOrder);
    if(result.status==='completed') {
      assert.equal(result.failureCategory,null);
      assert.equal(count(result.originalBytes),result.originalBytes);
      assert.equal(count(result.coderFacingBytes),result.coderFacingBytes);
      digest(result.originalHash);digest(result.coderFacingHash);
      assert.ok(result.deliveredBeforeResponse === null ||
        count(result.deliveredBeforeResponse)===result.deliveredBeforeResponse);
    } else {
      for(const field of ['originalBytes','coderFacingBytes','originalHash',
        'coderFacingHash','deliveredBeforeResponse']) assert.equal(result[field],null);
    }
  }
  assert.ok(Array.isArray(value.modelResponses) && value.modelResponses.length <= 33);
  const phases=new Set(['pre_tool_discovery','tool_call_generation','post_tool_result',
    'additional_post_tool_result','unknown_pre_tool','unknown_post_tool']);
  for(const response of value.modelResponses) {
    keys(response,['sequence','phase','order','responseStartOrder',
      'mcpResultDeliveredBeforeResponse','mcpResultsDeliveredBeforeResponse',
      'cumulativeToolCountBeforeResponse','inputTokens','cachedInputTokens',
      'uncachedInputTokens','cacheWriteInputTokens','outputTokens',
      'reasoningOutputTokens']);
    assert.ok(phases.has(response.phase));
    for(const field of ['inputTokens','cachedInputTokens','uncachedInputTokens',
      'cacheWriteInputTokens','outputTokens','reasoningOutputTokens'])
      assert.ok(response[field] === null || count(response[field]) === response[field]);
  }
  digest(value.canonicalTrajectoryFingerprint);
  assert.deepEqual(value.unavailable,
    ['providerHttpRequestBody','providerCacheKey','cacheSegmentation',
      'cachedPrefixBoundary','componentLevelTokenAttribution']);
  return value;
}
