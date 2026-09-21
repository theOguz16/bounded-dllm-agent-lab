import { Codex, type ThreadOptions } from "@openai/codex-sdk";
import { createAgentEnvironment } from "./agent-environment.js";
import { normalizeCodexProviderFailure } from "./codex-provider-access.js";

// This file is ONLY an entrypoint forked into its own POSIX session by the
// parent supervisor. It never writes provider streams or credentials to disk.
type StartMessage = Readonly<{
  type: "start";
  payload: Readonly<{
    task: string;
    threadOptions: ThreadOptions;
    outputSchema?: Readonly<Record<string, unknown>>;
  }>;
}>;
const controller = new AbortController();
let started = false;

function send(value: Readonly<Record<string, unknown>>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send || !process.connected) { reject(new Error("worker parent disconnected")); return; }
    process.send(value, (error) => error ? reject(error) : resolve());
  });
}

process.on("disconnect", () => controller.abort());
process.on("message", (message: unknown) => {
  if (!message || typeof message !== "object") return;
  const envelope = message as { type?: string; payload?: StartMessage["payload"] };
  if (envelope.type === "abort") { controller.abort(); return; }
  if (envelope.type !== "start" || started || !envelope.payload) return;
  started = true;
  void (async () => {
    try {
      const client = new Codex({ env: { ...createAgentEnvironment(process.env) } });
      const thread = client.startThread(envelope.payload!.threadOptions);
      const stream = await thread.runStreamed(envelope.payload!.task, {
        outputSchema: envelope.payload!.outputSchema,
        signal: controller.signal
      });
      for await (const event of stream.events) await send({ type: "event", value: event });
      await send({ type: "done" });
      process.exit(0);
    } catch (error) {
      // Do not leak SDK errors: they can contain session IDs and credential data.
      try { await send({ type: "error", code: normalizeCodexProviderFailure(error) }); }
      catch { /* The parent classifies an unacknowledged exit as ambiguous. */ }
      process.exit(1);
    }
  })();
});
