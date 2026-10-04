/** Bounded per-observation evidence builder; never persists raw prompts or tool text. */
import assert from 'node:assert/strict';
import { sha, validateCandidate } from './identity-bounded-authority.mjs';
import { APPROVED_SOURCE_PATH, MCP_SERVER_NAME, MCP_TOOL_NAME } from './identity-integration-config.mjs';

const count = x => Number.isSafeInteger(x) && x >= 0 ? x : null;

export function summarizeObservation({plan,slot,events,original,elapsedMs,expectedHead,scopeStatus}) {
  assert.deepEqual(plan.orderedSlots[slot.position-1],slot);
  assert.ok(Array.isArray(events));
  assert.ok(['PASS','FAIL','UNAVAILABLE'].includes(scopeStatus));
  const mcp=[];const shell=[];let answer=null;let usage=null;let terminal=null;
  let firstMcpOrdinal=null;
  for (const [index,event] of events.entries()) {
    const ordinal=index+1,item=event.item;
    if (event.type==='item.completed' && item?.type==='mcp_tool_call') {
      if (firstMcpOrdinal===null) firstMcpOrdinal=ordinal;
      const blocks=item.result?.content;
      const resultText=Array.isArray(blocks) && blocks.every(x=>x.type==='text') ?
        blocks.map(x=>x.text).join('') : null;
      const t=item.result?._meta?.researchTelemetry ?? null;
      mcp.push({ordinal,server:item.server,tool:item.tool,
        arguments:item.arguments,status:item.status,
        errorCategory:item.error?.message==='MCP tool call requires approval, but approval policy is never' ?
          'approval_policy_never' : item.error ? 'other_mcp_failure' : null,
        errorHash:item.error?.message ? sha(item.error.message) : null,
        resultHash:resultText===null ? null : sha(resultText),
        resultBytes:resultText===null ? null : Buffer.byteLength(resultText),
        telemetry:t,contentBlockCount:blocks?.length ?? null});
    }
    if(event.type==='item.completed' && item?.type==='command_execution'){
      const cmd=item.command??'';
      const sameFile=cmd.includes(APPROVED_SOURCE_PATH)||cmd.includes('codex-event-parser.ts');
      const readSearch=/\b(cat|sed|head|tail|rg|grep|find|awk|python|node|perl|less|more|git|jq|file|wc|nl|cut|strings)\b/.test(cmd);
      shell.push({ordinal,sameFile,readSearch,nativeSameFileRead:sameFile&&readSearch,
        status:item.status});
    }
    if(event.type==='item.completed' && item?.type==='agent_message') answer=item.text;
    if(event.type==='turn.completed'){usage=event.usage;terminal='completed'}
    if(event.type==='turn.failed')terminal='failed';
  }
  const coderInput=count(usage?.input_tokens),coderCached=count(usage?.cached_input_tokens);
  const coderUncached=coderInput===null||coderCached===null||coderCached>coderInput ?
    null : coderInput-coderCached;
  const coderOutput=count(usage?.output_tokens);
  const expectedMcp=mcp.filter(x=>x.server===MCP_SERVER_NAME&&x.tool===MCP_TOOL_NAME&&
    x.arguments?.path===APPROVED_SOURCE_PATH);
  const successful=expectedMcp.filter(x=>x.status==='completed'&&
    x.telemetry?.sourceHash===sha(original)&&
    x.resultHash===x.telemetry?.resultHash&&
    x.telemetry?.mode===slot.mode&&
    (slot.mode==='bounded'||x.resultHash===sha(original)));
  const lastSuccess=successful.at(-1)?.ordinal??null;
  const activityAfterResult=lastSuccess!==null&&events.some((event,index)=>index+1>lastSuccess&&
    event.type==='item.completed'&&['agent_message','command_execution','reasoning'].includes(event.item?.type));
  const candidate=answer===null ? {candidateProduced:false,behaviorOracle:'NOT_RUN'} :
    validateCandidate(answer,original.toString('utf8'));
  const sameFileNativeReads=shell.filter(x=>x.nativeSameFileRead).length;
  const repeatedMcpSameFileReads=Math.max(0,expectedMcp.length-1);
  const infrastructureHealthy=terminal==='completed'&&mcp.every(x=>x.errorCategory===null);
  const classification=terminal!=='completed' ? 'provider_or_timeout_ambiguous' :
    expectedMcp.length===0 ? 'mcp_bypass' :
    successful.length===0 ? 'mcp_failed' :
    candidate.behaviorOracle==='PASS' ? 'candidate_pass' : 'candidate_failure';
  return {schemaVersion:'research-mcp-representation-observation/v1',
    slot:slot.slot,condition:slot.condition,replicate:slot.replicate,
    candidateProduced:candidate.candidateProduced,
    scope:scopeStatus,build:'NOT_APPLICABLE',typecheck:'NOT_APPLICABLE',
    tests:'NOT_APPLICABLE',moduleLoad:'NOT_APPLICABLE',behaviorOracle:candidate.behaviorOracle,
    aggregateInput:coderInput,cachedInput:coderCached,uncachedInput:coderUncached,
    output:coderOutput,plannerInput:0,coderInput,coderCachedInput:coderCached,
    coderUncachedInput:coderUncached,coderOutput,
    coderAmplification:null,
    coderAmplificationDenominator:'UNAVAILABLE_PROMPT_TOKEN_ESTIMATE',
    normalizedCoderToolCount:mcp.length+shell.length,elapsedMs:count(elapsedMs),
    plannerDurationMs:0,coderDurationMs:count(elapsedMs),
    trajectoryVersion:'research-mcp-sdk-events/v1',
    fullCoderPromptHash:plan.fullCoderPromptHash,
    mcpUseInstructionHash:plan.coderInstructionHash,mcpMode:slot.mode,
    mcpInvocationCount:expectedMcp.length,requestedRelativePath:APPROVED_SOURCE_PATH,
    originalBytes:successful.at(-1)?.telemetry?.originalBytes??null,
    coderFacingBytes:successful.at(-1)?.telemetry?.coderBytes??null,
    byteReduction:successful.at(-1)?.telemetry?.reductionBytes??null,
    coderFacingResultHash:successful.at(-1)?.resultHash??null,
    originalResultHash:successful.at(-1)?.telemetry?.sourceHash??null,
    transformationHash:successful.at(-1)?.telemetry?.transformationHash??null,
    nativeSameFileReads:sameFileNativeReads,repeatedMcpSameFileReads,
    otherBypassInspections:shell.filter(x=>x.readSearch&&!x.nativeSameFileRead).length,
    contextExpansionRequest:0,contextExpansionGrant:0,
    failureTimeoutClassification:classification,
    mcpResultBeforeSubsequentCoderActivity:activityAfterResult,
    infrastructureHealthy,expectedSourceHead:expectedHead,
    terminal,usageAvailable:usage!==null,
    eventOrder:events.map((x,index)=>({ordinal:index+1,type:x.type,itemType:x.item?.type??null})),
    mcp,shell,answerHash:answer===null?null:sha(answer),
    rawSourcePersisted:false,rawToolResultPersisted:false,rawPromptPersisted:false};
}
