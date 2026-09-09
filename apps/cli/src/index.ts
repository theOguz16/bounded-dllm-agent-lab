#!/usr/bin/env node

import { runCanonicalCli } from "./cli-router.js";

process.exitCode = await runCanonicalCli(process.argv.slice(2));
