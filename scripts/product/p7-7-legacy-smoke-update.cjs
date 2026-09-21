#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const cp = require('node:child_process');
const file='benchmarks/product-v1/p7-6-compare-provider-smoke.cjs';
let text=fs.readFileSync(file,'utf8');
const existing=text.split('\n').filter(line=>line.includes('assert.match(source,')&&line.includes('stoppedCode'));
if(existing.length!==1||!existing[0].includes('break;'))throw Error('Old smoke assertion missing/ambiguous');
text=text.replace(existing[0], 'assert.equal(source.includes("if (providerGate?.stoppedCode() || terminalFailureCode !== null) break;"), true);');
const stale='assert.match(source, /providerFailureCode !== null/);';
if (!text.includes(stale) || text.indexOf(stale) !== text.lastIndexOf(stale)) throw Error('Old provider failure assertion missing/ambiguous');
text=text.replace(stale, 'assert.equal(source.includes("terminalFailureCode !== null"), true);');
fs.writeFileSync(file,text);
cp.execFileSync('git',['add','--',file]);
console.log('P7.6 smoke checks provider gate and durable terminal-stop conditions');
