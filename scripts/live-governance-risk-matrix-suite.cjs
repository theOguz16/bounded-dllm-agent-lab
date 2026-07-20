#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const BASE = process.env.LIVE_GOVERNANCE_MATRIX_OUT_DIR ??
  "/tmp/phase-z-live/governance-risk-matrix";
const MODEL = process.env.LIVE_VALIDATION_MODEL ?? "qwen2.5-coder-7b";
const LLAMA_HEALTH = process.env.LIVE_LLAMA_HEALTH_URL ??
  "http://127.0.0.1:8000/health";
const CAPTURE_HEALTH = process.env.LIVE_PROXY_HEALTH_URL ??
  "