#!/usr/bin/env node

const fs = require("node:fs");
const { Worker } = require("node:worker_threads");

async function startCheckpointMonitor(specification) {
  if (specification === null || specification === undefined) {
    return null;
  }

  const monitorSource = `
    const fs = require("node:fs");
    const { execFileSync } = require("node:child_process");
    const {
      parentPort,
      workerData
    } = require("node:worker_threads");

    const sleeper =
      new Int32Array(
        new SharedArrayBuffer(4)
      );

    function matches() {
      const filesMatch = workerData.present.every(
        (file) => fs.existsSync(file)
      ) && workerData.absent.every(
        (file) => !fs.existsSync(file)
      );
      if (!filesMatch || workerData.container === null || workerData.container === undefined) {
        return filesMatch;
      }
      try {
        const intent = JSON.parse(fs.readFileSync(workerData.container.intentPath, "utf8"));
        const name = intent.validationContainer.containerName;
        const state = execFileSync("docker", ["container", "inspect", "--format",
          "{{.State.Status}}", name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        if (state !== "running") return false;
        if (!workerData.container.commandRunning) return true;
        const processes = execFileSync("docker", ["top", name, "-eo", "pid,args"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        return processes.includes("validation-command-started");
      } catch { return false; }
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

      // This monitor runs in its own worker and must observe the narrow durable
      // reservation/intent windows. Sleeping for even one millisecond can skip
      // both atomic writes on fast filesystems.
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
    const checkpointPhases = {
      after_reservation: "reservation_verified",
      after_transaction_intent: "transaction_intent_verified",
      after_write_started: "write_started",
      after_first_file_write: "operation_persisted"
    };
    const expectedPhase = payload.checkpoint === null || payload.checkpoint === undefined
      ? null
      : checkpointPhases[payload.checkpoint.name];

    const result = await runtime.executeControlledRepositoryApply(
      payload.applyInput,
      expectedPhase === null || expectedPhase === undefined
        ? undefined
        : async (event) => {
            if (event.phase !== expectedPhase ||
                (event.phase === "operation_persisted" && event.operationIndex !== 0)) return;
            fs.writeFileSync(payload.observedMarker, JSON.stringify({
              checkpoint: payload.checkpoint.name,
              observedAt: new Date().toISOString()
            }), { mode: 0o600 });
            process.kill(process.pid, "SIGSTOP");
          }
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
