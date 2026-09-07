#!/usr/bin/env node

import { runCanonicalCli } from "./bounded-task.js";

process.exitCode = await runCanonicalCli(process.argv.slice(2));
