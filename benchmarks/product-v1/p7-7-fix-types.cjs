#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
function replace(file, from, to) {
 const text = fs.readFileSync(file, "utf8");
 if (text.split(from).length !== 2) throw new Error(`bad patch: ${file}`);
 fs.writeFileSync(file, text.replace(from, to));
}
replace("packages/integrations/src/codex-sdk-worker.ts",
  'const envelope = message as Partial<StartMessage> & { type?: string };',
  'const envelope = message as { type?: string; payload?: StartMessage["payload"] };');
replace("packages/integrations/src/isolated-agent-worker.ts",
  'env: input.environment, execArgv: [], windowsHide: true',
  'env: input.environment, execArgv: []');
console.log("P7.7 TypeScript IPC fixes applied");
