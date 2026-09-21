#!/usr/bin/env node
"use strict";

process.on("SIGTERM", () => {
  // Intentionally ignore graceful termination so the supervisor must escalate.
});

const autoExitMs = Number(process.env.P7_7_FAKE_AUTO_EXIT_MS || 0);
if (Number.isFinite(autoExitMs) && autoExitMs > 0) {
  setTimeout(() => process.exit(0), autoExitMs);
}

setInterval(() => {}, 1_000);
