#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const file = path.resolve(__dirname, "p7-6-identity-integration-patch.cjs");
const original = fs.readFileSync(file, "utf8");
const from = 'test === "benchmarks/product-v1/p7-6-compare-provider-smoke.cjs" ? 8 : 1';
const to = 'test === "benchmarks/product-v1/p7-6-compare-provider-smoke.cjs" ? 6 : 1';
if (original.split(from).length !== 2) throw new Error("P7.6 smoke count patch does not have one exact anchor.");
fs.writeFileSync(file, original.replace(from, to));
require(file);
