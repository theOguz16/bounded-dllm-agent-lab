#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const cp = require('node:child_process');
const file='benchmarks/product-v1/p7-6-compare-provider-smoke.cjs';
let text=fs.readFileSync(file,'utf8');
const existing=text.split('\n').filter(line=>line.includes('assert.match(source,')&&line.includes('stoppedCode'));
if(existing.length!==1||!existing[0].includes('break;'))throw Error('Old smoke assertion missing/ambiguous');
const next='assert.equal(source.includes("if (providerGate?.stoppedCode() || terminalFailureCode !== null) break;"), true);';
text=text.replace(existing[0],next);
fs.writeFileSync(file,text);
cp.execFileSync('git',['add','--',file]);
console.log('P7.6 smoke now checks stop on provider gate OR durable terminal failure');
