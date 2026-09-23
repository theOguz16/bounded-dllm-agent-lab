"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
fs.rmSync(path.join(root, "dist", "cli-package"), { recursive: true, force: true });
