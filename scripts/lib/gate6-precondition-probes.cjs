"use strict";

const PROBE_VERSION = "gate6-precondition-probes/v1";

const probes = Object.freeze({
  "external.nanoid.secure-pool-fractional-size": `import assert from 'node:assert/strict'; import {nanoid} from './index.js'; const fractional=nanoid(1.5); assert.equal(fractional.length,1); assert.equal(nanoid().length,21);`,
  "external.nanoid.node-browser-zero-size-parity": `import assert from 'node:assert/strict'; import * as nodeImpl from './index.js'; import * as browserImpl from './index.browser.js'; assert.equal(nodeImpl.nanoid(0),''); assert.equal(browserImpl.nanoid(0),''); assert.equal(nodeImpl.customAlphabet('abc',0)(),''); assert.equal(browserImpl.customAlphabet('abc',0)(),'');`,
  "external.nanoid.url-alphabet-dependency": `import assert from 'node:assert/strict'; import {nanoid,urlAlphabet} from './index.js'; for(let i=0;i<64;i++){for(const char of nanoid()){assert.ok(urlAlphabet.includes(char));}}`,

  "external.clsx.push-key-object-regression": `import assert from 'node:assert/strict'; import {clsx} from './src/index.js'; assert.equal(clsx({push:true,pop:true}),'push pop');`,
  "external.clsx.recursive-array-type-sync": `import assert from 'node:assert/strict'; import {clsx} from './src/index.js'; assert.equal(clsx(['a',['b',['c']]]),'a b c');`,
  "external.clsx.nested-array-boundary": `import assert from 'node:assert/strict'; import {clsx} from './src/index.js'; assert.equal(clsx(['a',[null,['b',false,['c']]],0]),'a b c');`,

  "external.yocto-queue.clear-reset-regression": `import assert from 'node:assert/strict'; import Queue from './index.js'; const q=new Queue(); q.enqueue(1); q.enqueue(2); q.clear(); assert.equal(q.size,0); q.enqueue(3); assert.equal(q.dequeue(),3); assert.equal(q.size,0);`,
  "external.yocto-queue.empty-dequeue-no-change": `import assert from 'node:assert/strict'; import Queue from './index.js'; const q=new Queue(); assert.equal(q.dequeue(),undefined); assert.equal(q.dequeue(),undefined); assert.equal(q.size,0);`,
  "external.yocto-queue-drain-boundary": `import assert from 'node:assert/strict'; import Queue from './index.js'; const q=new Queue(); q.enqueue('a'); q.enqueue(undefined); q.enqueue('b'); assert.deepEqual([...q.drain()],['a',undefined,'b']); assert.equal(q.size,0); assert.deepEqual([...q],[]);`,

  "external.p-map-multiple-skip-regression": `import assert from 'node:assert/strict'; import pMap,{pMapSkip} from './index.js'; const result=await pMap([1,2,3,4], async value => value%2===0?pMapSkip:value*10); assert.deepEqual(result,[10,30]);`,
  "external.p-map.empty-iterable-no-change": `import assert from 'node:assert/strict'; import pMap from './index.js'; let called=0; const result=await pMap([], async value=>{called++; return value;}); assert.deepEqual(result,[]); assert.equal(called,0);`,
  "external.p-map-stop-on-error-boundary": `import assert from 'node:assert/strict'; import pMap from './index.js'; let error; try{await pMap([1,2,3], async value=>{if(value!==2)throw new Error(String(value)); return value;},{stopOnError:false});}catch(value){error=value;} assert.ok(error instanceof AggregateError); assert.equal(error.errors.length,2);`,

  "external.p-limit.map-api-contract": `import assert from 'node:assert/strict'; import pLimit from './index.js'; const limit=pLimit(1); let running=0,maxRunning=0; const result=await limit.map([1,2,3],async value=>{running++; maxRunning=Math.max(maxRunning,running); await new Promise(r=>setTimeout(r,5)); running--; return value*2;}); assert.deepEqual(result,[2,4,6]); assert.equal(maxRunning,1);`,
  "external.p-limit.detached-map-decoy-selection": `import assert from 'node:assert/strict'; import pLimit from './index.js'; const {map}=pLimit(1); assert.deepEqual(await map([2,3],async value=>value*2),[4,6]);`,
  "external.p-limit.detached-map-no-change": `import assert from 'node:assert/strict'; import pLimit from './index.js'; const limit=pLimit(1); const {map}=limit; assert.deepEqual(await map([1,2,3],async (value,index)=>value+index),[1,3,5]);`,

  "external.p-queue-priority-ordering-cross-file": `import assert from 'node:assert/strict'; import PQueue from './.gate6-runtime/source/index.js'; const queue=new PQueue({concurrency:1,autoStart:false}); const order=[]; queue.add(()=>order.push('low'),{priority:0}); queue.add(()=>order.push('high-a'),{priority:2}); queue.add(()=>order.push('high-b'),{priority:2}); queue.start(); await queue.onIdle(); assert.deepEqual(order,['high-a','high-b','low']);`,
  "external.p-queue-options-dependency": `import assert from 'node:assert/strict'; import PQueue from './.gate6-runtime/source/index.js'; assert.throws(()=>new PQueue({concurrency:0}),TypeError); assert.throws(()=>new PQueue({interval:-1}),TypeError);`,
  "external.p-queue-queueclass-api-contract": `import assert from 'node:assert/strict'; import PQueue from './.gate6-runtime/source/index.js'; class CustomQueue{items=[]; enqueue(run){this.items.push(run);} dequeue(){return this.items.shift();} get size(){return this.items.length;} filter(){return this.items;}} const queue=new PQueue({queueClass:CustomQueue,concurrency:1,autoStart:false}); const promise=queue.add(()=>42); queue.start(); assert.equal(await promise,42); await queue.onIdle();`,

  "external.chalk-style-utilities-dependency": `import assert from 'node:assert/strict'; import {Chalk} from './source/index.js'; const chalk=new Chalk({level:1}); const value=chalk.red.bold('x'); assert.ok(value.includes('x')); assert.notEqual(value,'x'); assert.ok(value.includes('\\u001B['));`,
  "external.chalk-instance-level-api-contract": `import assert from 'node:assert/strict'; import {Chalk} from './source/index.js'; assert.equal(new Chalk({level:0}).red('x'),'x'); assert.notEqual(new Chalk({level:1}).red('x'),'x'); assert.throws(()=>new Chalk({level:4}));`,
  "external.chalk-visible-decoy-selection": `import assert from 'node:assert/strict'; import {Chalk} from './source/index.js'; assert.equal(new Chalk({level:0}).visible('x'),''); assert.equal(new Chalk({level:1}).visible('x'),'x');`,

  "external.commander-argument-choices-cross-file": `import assert from 'node:assert/strict'; import {Argument} from './lib/argument.js'; const arg=new Argument('<color>').choices(['red','blue']); assert.equal(arg.parseArg('red'),'red'); assert.throws(()=>arg.parseArg('green'));`,
  "external.commander-suggestion-dependency": `import assert from 'node:assert/strict'; import {suggestSimilar} from './lib/suggestSimilar.js'; assert.match(suggestSimilar('stat',['start']),/Did you mean start/); assert.equal(suggestSimilar('xyz',['start']),'');`,
  "external.commander-option-conflict-decoy": `import assert from 'node:assert/strict'; import {Command} from './lib/command.js'; import {Option} from './lib/option.js'; const program=new Command(); program.exitOverride(); program.addOption(new Option('--foo').conflicts('bar')); program.addOption(new Option('--bar')); assert.throws(()=>program.parse(['node','probe','--foo','--bar']));`,

  "external.dotenv-duplicate-key-line-ending-regression": `import assert from 'node:assert/strict'; import dotenv from './lib/main.js'; assert.equal(dotenv.parse(Buffer.from('DUP=one\\nDUP=two')).DUP,'two'); const expected={A:'1',B:'2'}; assert.deepEqual(dotenv.parse(Buffer.from('A=1\\rB=2\\r')),expected); assert.deepEqual(dotenv.parse(Buffer.from('A=1\\nB=2\\n')),expected); assert.deepEqual(dotenv.parse(Buffer.from('A=1\\r\\nB=2\\r\\n')),expected);`,
  "external.dotenv-parse-config-api-contract": `import assert from 'node:assert/strict'; import fs from 'node:fs'; import dotenv from './lib/main.js'; assert.deepEqual(dotenv.parse(Buffer.from('A=1')), {A:'1'}); fs.writeFileSync('.gate6.env','B=2\\n'); const processEnv={}; const result=dotenv.config({path:'.gate6.env',processEnv,quiet:true}); assert.equal(result.parsed.B,'2'); assert.equal(processEnv.B,'2'); fs.unlinkSync('.gate6.env');`,
  "external.dotenv-export-keyword-no-change": `import assert from 'node:assert/strict'; import dotenv from './lib/main.js'; const parsed=dotenv.parse(Buffer.from('export FOO = bar\\nexport BAZ=qux')); assert.equal(parsed.FOO,'bar'); assert.equal(parsed.BAZ,'qux');`,

  "external.query-string-parse-stringify-cross-file": `import assert from 'node:assert/strict'; import queryString from './index.js'; const encoded=queryString.stringify({tag:['a','b']},{arrayFormat:'bracket'}); assert.deepEqual(queryString.parse(encoded,{arrayFormat:'bracket'}),Object.assign(Object.create(null),{tag:['a','b']}));`,
  "external.query-string-entrypoint-base-dependency": `import assert from 'node:assert/strict'; import queryString from './index.js'; for(const name of ['parse','stringify','parseUrl','stringifyUrl']) assert.equal(typeof queryString[name],'function');`,
  "external.query-string-url-api-contract": `import assert from 'node:assert/strict'; import queryString from './index.js'; const parsed=queryString.parseUrl('https://example.com/path?a=1#frag',{parseFragmentIdentifier:true}); assert.equal(parsed.url,'https://example.com/path'); assert.equal(parsed.query.a,'1'); assert.equal(parsed.fragmentIdentifier,'frag'); const value=queryString.stringifyUrl({url:'https://example.com/path',query:{a:'1'},fragmentIdentifier:'frag'}); assert.match(value,/a=1/); assert.match(value,/#frag$/);`,

  "external.escape-string-regexp-special-char-decoy": `import assert from 'node:assert/strict'; import escapeStringRegexp from './index.js'; const input='a.b*c?d[e](f){g}|h^i$j+k\\\\l'; const escaped=escapeStringRegexp(input); assert.equal(new RegExp('^'+escaped+'$','u').test(input),true);`,
  "external.escape-string-regexp-typeerror-no-change": `import assert from 'node:assert/strict'; import escapeStringRegexp from './index.js'; assert.throws(()=>escapeStringRegexp(123),TypeError);`,
  "external.escape-string-regexp-hyphen-boundary": `import assert from 'node:assert/strict'; import escapeStringRegexp from './index.js'; assert.equal(escapeStringRegexp('-'),'\\x2d'); assert.doesNotThrow(()=>new RegExp(escapeStringRegexp('-'),'u'));`,

  "external.is-runtime-predicate-decoy-selection": `import assert from 'node:assert/strict'; import is from './.gate6-runtime/source/index.js'; assert.equal(is.string('x'),true); assert.equal(is.string(1),false); assert.equal(is.number(1),true); assert.equal(is.number('1'),false);`,
  "external.is-type-narrowing-no-change": `import assert from 'node:assert/strict'; import fs from 'node:fs'; const source=fs.readFileSync('source/index.ts','utf8'); assert.match(source,/export function isEmptyString\\(value: unknown\\): value is ''/);`,
  "external.is-boxed-primitive-boundary": `import assert from 'node:assert/strict'; import is from './.gate6-runtime/source/index.js'; assert.equal(is('x'),'string'); assert.throws(()=>is(new String('x')),TypeError);`,

  "external.ky-hook-retry-regression": `import assert from 'node:assert/strict'; import ky from './.gate6-runtime/source/index.js'; let fetchCount=0,beforeRetry=0; const response=await ky('https://example.test',{retry:{limit:1},fetch:async()=>{fetchCount++; return new Response(fetchCount===1?'retry':'ok',{status:fetchCount===1?503:200,headers:{'Retry-After':'0'}});},hooks:{beforeRetry:[()=>{beforeRetry++;}]}}); assert.equal(response.status,200); assert.equal(fetchCount,2); assert.equal(beforeRetry,1);`,
  "external.ky-retry-timing-cross-file": `import assert from 'node:assert/strict'; import ky from './.gate6-runtime/source/index.js'; let count=0; const response=await ky.get('https://example.test',{retry:{limit:1},fetch:async()=>{count++; return new Response('',{status:count===1?503:200,headers:{'Retry-After':'0'}});}}); assert.equal(response.status,200); assert.equal(count,2);`,
  "external.ky-retry-constants-dependency": `import assert from 'node:assert/strict'; import ky from './.gate6-runtime/source/index.js'; let getCount=0; const getResponse=await ky.get('https://example.test',{retry:{limit:1},fetch:async()=>{getCount++; return new Response('',{status:getCount===1?500:200});}}); assert.equal(getResponse.status,200); assert.equal(getCount,2); let postCount=0; await assert.rejects(()=>ky.post('https://example.test',{retry:{limit:1},fetch:async()=>{postCount++; return new Response('',{status:500});}})); assert.equal(postCount,1);`,

  "external.slugify-options-api-contract": `import assert from 'node:assert/strict'; import slugify from './index.js'; assert.equal(slugify('Hello World',{separator:'_',lowercase:true}),'hello_world'); assert.equal(slugify('foo@bar',{customReplacements:[['@',' at ']]}),'foo-at-bar');`,
  "external.slugify-transliteration-decoy-selection": `import assert from 'node:assert/strict'; import slugify from './index.js'; assert.equal(slugify('Déjà Vu & ♥'),'deja-vu-and-love');`,
  "external.slugify-custom-replacement-boundary": `import assert from 'node:assert/strict'; import slugify from './index.js'; const value=slugify('A@B / C',{customReplacements:[['@',' at ']],separator:'-'}); assert.equal(value,'a-at-b-c'); assert.equal(/[\\s/@]/.test(value),false);`
});

function getProbe(taskId) {
  const source = probes[taskId];
  if (typeof source !== "string") {
    const error = new Error(`GATE6_PRECONDITION_PROBE_UNKNOWN: ${taskId}`);
    error.code = "GATE6_PRECONDITION_PROBE_UNKNOWN";
    throw error;
  }
  return source;
}

module.exports = { PROBE_VERSION, getProbe, probes };
