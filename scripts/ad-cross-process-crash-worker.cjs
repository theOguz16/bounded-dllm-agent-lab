#!/usr/bin/env node

const fs = require("node:fs");
const { Worker } = require("node:worker_threads");

async function startCheckpointMonitor(specification) {
  if (specification === null || specification === undefined) {
    return null;
  }

  const monitorSource = `
    const fs = require("node:fs");
    const {
      parentPort,
      workerData
    } = require("node:worker_threads");

    const sleeper =
      new Int32Array(
        new SharedArrayBuffer(4)
      );

    function matches() {
      return workerData.present.every(
        (file) => fs.existsSync(file)
      ) && workerData.absent.every(
        (file) => !fs.existsSync(file)
      );
    }

    parentPort.postMessage({
      type: "ready"
    });

    const deadline =
      Date.now() + workerData.timeoutMs;

    while (Date.now() <= deadline) {
      if (matches()) {
        fs.writeFileSync(
          workerData.observedMarker,
          JSON.stringify({
            checkpoint: workerData.name,
            observedAt:
              new Date().toISOString()
          }),
          { mode: 0o600 }
        );

        process.kill(
          process.pid,
          "SIGSTOP"
        );

        process.exit(0);
      }

      Atomics.wait(
        sleeper,
        0,
        0,
        1
      );
    }

    fs.writeFileSync(
      workerData.failureMarker,
      JSON.stringify({
        checkpoint: workerData.name,
        reason: "checkpoint_timeout"
      }),
      { mode: 0o600 }
    );
  `;

  const monitor = new Worker(
    monitorSource,
    {
      eval: true,
      workerData: specification
    }
  );

  await new Promise(
    (resolve, reject) => {
      const timer = setTimeout(
        () => {
          cleanup();
          reject(
            new Error(
              "Checkpoint monitor readiness timeout"
            )
          );
        },
        5000
      );

      function cleanup() {
        clearTimeout(timer);
        monitor.off(
          "message",
          onMessage
        );
        monitor.off(
          "error",
          onError
        );
        monitor.off(
          "exit",
          onExit
        );
      }

      function onMessage(message) {
        if (
          message === null ||
          typeof message !== "object" ||
          message.type !== "ready"
        ) {
          return;
        }

        cleanup();
        resolve();
      }

      function onError(error) {
        cleanup();
        reject(error);
      }

      function onExit(code) {
        cleanup();
        reject(
          new Error(
            `Checkpoint monitor exited before ready: ${code}`
          )
        );
      }

      monitor.on(
        "message",
        onMessage
      );
      monitor.on(
        "error",
        onError
      );
      monitor.on(
        "exit",
        onExit
      );
    }
  );

  return monitor;
}

function writeResult(file, value) {
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}

(async () => {
  const payloadPath = process.argv[2];

  if (!payloadPath) {
    throw new Error("Missing worker payload path.");
  }

  const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
  const runtime = await import(
    "../dist/packages/product-runtime/src/index.js"
  );

  if (payload.mode === "apply") {
    await startCheckpointMonitor(
      payload.checkpoint ?? null
    );

    const result = await runtime.executeControlledRepositoryApply(
      payload.applyInput
    );

    writeResult(payload.resultPath, result);

    if (payload.holdAfterApply === true) {
      fs.writeFileSync(
        payload.observedMarker,
        JSON.stringify({
          checkpoint: "after_apply_complete",
          observedAt: new Date().toISOString()
        }),
        { mode: 0o600 }
      );
      process.kill(process.pid, "SIGSTOP");
    }

    process.exitCode =
      result.decision === "controlled_repository_apply_succeeded"
        ? 0
        : 2;
    return;
  }

  if (payload.mode === "validation") {
    await startCheckpointMonitor(
      payload.checkpoint ?? null
    );

    const result =
      await runtime.executeControlledPostApplyValidation(
        payload.validationInput
      );

    writeResult(payload.resultPath, result);
    process.exitCode =
      result.decision ===
        "controlled_post_apply_validation_finalized"
        ? 0
        : 3;
    return;
  }

  throw new Error(`Unsupported worker mode: ${payload.mode}`);
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
