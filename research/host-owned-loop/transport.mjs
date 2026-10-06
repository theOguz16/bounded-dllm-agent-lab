/** One OpenAI Chat Completions transport. No tool execution, conversation storage, SDK loop or retries. */
import { canonicalizeJson, hashCanonicalJson } from '../../dist/packages/product-runtime/src/agent-event-ledger.js';
import { createDurableInvocationJournal } from '../../dist/packages/integrations/src/durable-invocation-journal.js';
import { assertInvocationJournalLocationOutsideSourceRepository } from '../../dist/packages/integrations/src/invocation-journal-location.js';

export const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const transports = new WeakSet();
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const freeze = v => { if(v && typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v; };
const clone = v => JSON.parse(canonicalizeJson(v));
const fail = code => {throw Object.assign(new Error(code),{code});};
const numeric = n => Number.isSafeInteger(n)&&n>=0;
export const isChatTransport = provider => transports.has(provider);

export function validateObservedUsage(usage) {
  const fields=['input','cachedInput','uncachedInput','output','reasoningOutput','cacheWriteInput'];
  if(!usage || Object.keys(usage).length!==fields.length || fields.some(k=>!Object.hasOwn(usage,k)) ||
     fields.some(k=>usage[k]!==null&&!numeric(usage[k]))) fail('TRANSPORT_RESPONSE_INVALID');
  if(usage.input!==null && usage.cachedInput!==null &&
     (usage.cachedInput>usage.input || usage.uncachedInput!==usage.input-usage.cachedInput)) fail('TRANSPORT_RESPONSE_INVALID');
  if((usage.input===null||usage.cachedInput===null) && usage.uncachedInput!==null) fail('TRANSPORT_RESPONSE_INVALID');
  if(usage.output!==null&&usage.reasoningOutput!==null&&usage.reasoningOutput>usage.output) fail('TRANSPORT_RESPONSE_INVALID');
  return freeze(clone(usage));
}
export function extractUsage(raw) {
  const pick = v => v===undefined||v===null?null:numeric(v)?v:fail('TRANSPORT_RESPONSE_INVALID');
  const input=pick(raw?.prompt_tokens), cachedInput=pick(raw?.prompt_tokens_details?.cached_tokens);
  return validateObservedUsage({input,cachedInput,uncachedInput:input!==null&&cachedInput!==null?input-cachedInput:null,
    output:pick(raw?.completion_tokens),reasoningOutput:pick(raw?.completion_tokens_details?.reasoning_tokens),
    cacheWriteInput:pick(raw?.prompt_tokens_details?.cache_write_tokens)});
}

/** Deterministic wire encoding only. Preserve host message order/content and exact tool schemas. */
export function buildChatPayload(request) {
  if(!Object.isFrozen(request)||!numeric(request.sequence)||request.sequence<1||!MODEL.test(request.model)||
     !['none','low','medium','high'].includes(request.reasoning)||!HASH.test(request.retainedStateHash)||
     !Array.isArray(request.messages)||!Array.isArray(request.tools)||request.tools.length!==2 ||
     request.tools.map(t=>t.name).join(',')!=='read_file,update_file') fail('TRANSPORT_REQUEST_INVALID');
  const messages=request.messages.map(message=>{
    if(['system','user'].includes(message.role)) {
      if(typeof message.content!=='string') fail('TRANSPORT_REQUEST_INVALID');
      return {role:message.role,content:message.content};
    }
    if(message.role==='assistant') {
      if(typeof message.content!=='string') fail('TRANSPORT_REQUEST_INVALID');
      return {role:'assistant',content:message.content,
        ...(message.toolCall===null?{}:{tool_calls:[{id:message.toolCall.id,type:'function',function:{
          name:message.toolCall.name,arguments:canonicalizeJson(message.toolCall.arguments)}}]})};
    }
    if(message.role==='tool')return {role:'tool',tool_call_id:message.toolCallId,content:message.content};
    fail('TRANSPORT_REQUEST_INVALID');
  });
  return freeze({model:request.model,reasoning_effort:request.reasoning,messages,
    tools:request.tools.map(t=>({type:'function',function:{name:t.name,description:t.description,
      parameters:clone(t.parameters),strict:true}})),parallel_tool_calls:false,tool_choice:'auto',
    n:1,stream:false,store:false,max_completion_tokens:4096,
    metadata:{application_request_hash:hashCanonicalJson(request),retained_state_hash:request.retainedStateHash,
      request_sequence:String(request.sequence)}});
}
function parseAssistant(raw) {
  if(!Array.isArray(raw.choices)||raw.choices.length!==1||raw.choices[0].index!==0) fail('TRANSPORT_RESPONSE_INVALID');
  const choice=raw.choices[0], message=choice.message;
  if(!message||message.role!=='assistant'||message.refusal) fail('TRANSPORT_RESPONSE_INVALID');
  if(!['stop','tool_calls'].includes(choice.finish_reason)) fail('TRANSPORT_INCOMPLETE');
  if(message.content!==null&&message.content!==undefined&&typeof message.content!=='string') fail('TRANSPORT_RESPONSE_INVALID');
  const calls=message.tool_calls??[];
  if(!Array.isArray(calls)||calls.length>1) fail('TRANSPORT_RESPONSE_INVALID');
  let toolCall=null;
  if(calls.length===1){
    const call=calls[0];
    if(call.type!=='function'||typeof call.id!=='string'||!MODEL.test(call.id)||
       !['read_file','update_file'].includes(call.function?.name)||typeof call.function.arguments!=='string') fail('TRANSPORT_RESPONSE_INVALID');
    let args;try{args=JSON.parse(call.function.arguments);}catch{fail('TRANSPORT_RESPONSE_INVALID');}
    if(!args||typeof args!=='object'||Array.isArray(args))fail('TRANSPORT_RESPONSE_INVALID');
    toolCall={id:call.id,name:call.function.name,arguments:args};
  }
  if((toolCall===null)!==(choice.finish_reason==='stop')) fail('TRANSPORT_RESPONSE_INVALID');
  return {assistant:{text:message.content??'',toolCall},status:'completed',finishReason:choice.finish_reason};
}
async function boundedJson(response,signal){
  if(!response.body) fail('TRANSPORT_RESPONSE_INVALID');
  const chunks=[];let bytes=0;
  for await(const chunk of response.body){
    if(signal.aborted) fail('TRANSPORT_TIMEOUT');
    bytes+=chunk.length;
    if(bytes>262144){await response.body.cancel().catch(()=>{});fail('TRANSPORT_RESPONSE_INVALID');}
    chunks.push(Buffer.from(chunk));
  }
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('TRANSPORT_RESPONSE_INVALID');}
}

function createTransport({apiKey,journalPath,sourceRepositoryPath,sessionId,model,reasoning,
  timeoutMs=60000,deadlineAt=Date.now()+180000},mockResponses) {
  const mock=mockResponses!==undefined;
  if(!MODEL.test(sessionId)||!MODEL.test(model)||!['none','low','medium','high'].includes(reasoning)||
     !Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000||!Number.isSafeInteger(deadlineAt))fail('TRANSPORT_REQUEST_INVALID');
  if(!mock&&(typeof apiKey!=='string'||!apiKey.trim()||/[\r\n]/.test(apiKey))) fail('API_CREDENTIAL_UNAVAILABLE');
  assertInvocationJournalLocationOutsideSourceRepository({journalPath,sourceRepositoryRoot:sourceRepositoryPath});
  const journal=createDurableInvocationJournal(journalPath);
  const script=mock?clone(mockResponses):null;
  let dispatched=0, expectedSequence=1, stopped=false;
  const receipts=[];
  const provider=Object.freeze({kind:mock?'mock-chat-transport':'openai-chat-transport',
    get realProviderCalls(){return mock?0:dispatched;},get httpDispatches(){return dispatched;},
    get receipts(){return freeze(clone(receipts));},
    async complete(request){
      if(stopped||request.sequence!==expectedSequence||request.sequence>3||request.model!==model||request.reasoning!==reasoning)
        fail('TRANSPORT_REQUEST_INVALID');
      const payload=buildChatPayload(request),body=canonicalizeJson(payload);
      const remaining=deadlineAt-Date.now();if(remaining<=0)fail('TRANSPORT_TIMEOUT');
      const receipt={sequence:request.sequence,applicationRequestHash:hashCanonicalJson(request),
        wireRequestHash:hashCanonicalJson(payload),wireRequestBytes:Buffer.byteLength(body),
        retainedStateHash:request.retainedStateHash,transportMode:mock?'fixture_http':'live_http',
        requestedModel:model,observedModel:null,responseHash:null,responseStatus:null,
        finishReason:null,usage:null,usageProvenance:mock?'fixture':'provider_observed',
        journalKeyHash:null,journalState:null,httpStatus:null,classification:'TRANSPORT_REQUEST_INVALID'};
      // Existing journal hashes this complete request material and stores no source/prompt/body text.
      const reservation=journal.reserve({runId:`${sessionId}.response.${request.sequence}`,stage:'coder',
        task:canonicalizeJson({request,payload}),model,reasoningEffort:reasoning,sourceRepositoryPath,
        deadlineAt:Math.min(deadlineAt,Date.now()+timeoutMs)});
      receipt.journalKeyHash=reservation.invocationKey;
      journal.start(reservation.invocationKey);receipt.journalState='started';
      receipts.push(receipt); // Reservation is durable before the first HTTP dispatch.
      let responseReceived=false,controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),Math.min(timeoutMs,remaining));
      try{
        dispatched++;
        const response=mock?new Response(JSON.stringify(script[dispatched-1]?.body??{}),
          {status:script[dispatched-1]?.status??200}):await fetch(ENDPOINT,{method:'POST',redirect:'error',
          headers:{'Content-Type':'application/json',Authorization:`Bearer ${apiKey}`},body,signal:controller.signal});
        receipt.httpStatus=response.status;responseReceived=true;
        if(!response.ok){await response.body?.cancel().catch(()=>{});fail('TRANSPORT_HTTP_FAILED');}
        const raw=await boundedJson(response,controller.signal);
        receipt.usage=extractUsage(raw.usage); // Keep exact available usage even if status/assistant parsing later fails.
        if(typeof raw.model==='string'&&MODEL.test(raw.model))receipt.observedModel=raw.model;
        receipt.responseHash=hashCanonicalJson(raw); // Hash only; raw response is never persisted.
        const finish=raw.choices?.[0]?.finish_reason;
        receipt.finishReason=['stop','tool_calls','length','content_filter'].includes(finish)?finish:'unknown';
        receipt.responseStatus=['length','content_filter'].includes(finish)?'incomplete':'failed';
        const parsed=parseAssistant(raw);
        receipt.responseStatus=parsed.status;receipt.finishReason=parsed.finishReason;
        receipt.classification='TRANSPORT_COMPLETED';
        journal.finish(reservation.invocationKey,'completed',{sessionEvidence:'present',terminalTurnObserved:true,
          providerFailureClass:'unknown',providerHttpStatus:receipt.httpStatus});
        receipt.journalState='completed';expectedSequence++;
        return freeze({...parsed,usage:receipt.usage});
      }catch(error){
        stopped=true;
        const code=controller.signal.aborted?'TRANSPORT_TIMEOUT':
          ['TRANSPORT_RESPONSE_INVALID','TRANSPORT_INCOMPLETE','TRANSPORT_HTTP_FAILED'].includes(error?.code)?error.code:'TRANSPORT_NETWORK_FAILED';
        receipt.classification=code;
        const terminal=responseReceived&&code==='TRANSPORT_HTTP_FAILED'?'failed':'outcome_unknown';
        journal.finish(reservation.invocationKey,terminal,{sessionEvidence:responseReceived?'present':'unknown',
          failureCode:terminal==='failed'?(receipt.httpStatus===401?'authentication_failed':receipt.httpStatus===429?'usage_limit_exceeded':'provider_stream_error_unknown'):'provider_outcome_ambiguous',
          providerHttpStatus:receipt.httpStatus,terminalTurnObserved:false});
        receipt.journalState=terminal;
        fail(code); // Never return raw error text/body/headers or retry an ambiguous call.
      }finally{clearTimeout(timer);}
    }
  });
  transports.add(provider);return provider;
}
export function createOpenAIChatTransport(options){return createTransport(options);}
/** Test-only scripted HTTP bodies, not an injectable arbitrary networking callback. */
export function createMockChatTransport(options,responses){return createTransport(options,responses);}

export function validateTransportReceipts(receipts){
  if(!Array.isArray(receipts)||receipts.length>3)fail('TRANSPORT_RESPONSE_INVALID');
  const fields=['sequence','applicationRequestHash','wireRequestHash','wireRequestBytes','retainedStateHash',
    'transportMode','requestedModel','observedModel','responseHash','responseStatus','finishReason','usage',
    'usageProvenance','journalKeyHash','journalState','httpStatus','classification'];
  for(const r of receipts){
    if(!r||Object.keys(r).length!==fields.length||fields.some(k=>!Object.hasOwn(r,k))||
       !numeric(r.sequence)||r.sequence<1||r.sequence>3||!numeric(r.wireRequestBytes)||
       ['applicationRequestHash','wireRequestHash','retainedStateHash','journalKeyHash'].some(k=>!HASH.test(r[k]))||
       (r.responseHash!==null&&!HASH.test(r.responseHash))||!MODEL.test(r.requestedModel)||
       (r.observedModel!==null&&!MODEL.test(r.observedModel))||
       !['fixture_http','live_http'].includes(r.transportMode)||!['fixture','provider_observed'].includes(r.usageProvenance)||
       ![null,'completed','incomplete','failed'].includes(r.responseStatus)||![null,'stop','tool_calls','length','content_filter','unknown'].includes(r.finishReason)||
       !['started','completed','failed','outcome_unknown'].includes(r.journalState)||
       (r.httpStatus!==null&&(!numeric(r.httpStatus)||r.httpStatus<100||r.httpStatus>599))||
       !['TRANSPORT_COMPLETED','TRANSPORT_RESPONSE_INVALID','TRANSPORT_INCOMPLETE','TRANSPORT_HTTP_FAILED',
         'TRANSPORT_TIMEOUT','TRANSPORT_NETWORK_FAILED','TRANSPORT_REQUEST_INVALID'].includes(r.classification))fail('TRANSPORT_RESPONSE_INVALID');
    if(r.usage!==null)validateObservedUsage(r.usage);
  }
  return freeze(clone(receipts));
}
