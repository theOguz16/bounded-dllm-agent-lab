import { Codex, type ThreadOptions, type TurnOptions } from "@openai/codex-sdk";

export const CODEX_AGENT_WORKER_PROTOCOL_VERSION = "codex-agent-worker/v1" as const;

type CodexAgentWorkerRequest = Readonly<{
  protocolVersion: typeof CODEX_AGENT_WORKER_PROTOCOL_VERSION;
  task: string;
  threadOptions: ThreadOptions;
  outputSchema?: Readonly<Record<string, unknown>>;
}>;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function safeError(error: unknown): Readonly<Record<string, unknown>> {
  if (!error || typeof error !== "object") {
    return { name: "Error", message: typeof error === "string" ? error : "Codex worker failed." };
  }
  const record = error as Record<string, unknown>;
  return {
    name: typeof record.name === "string" ? record.name : "Error",
    code: typeof record.code === "string" || typeof record.code === "number" ? record.code : undefined,
    status: typeof record.status === "number" ? record.status : undefined,
    message: typeof record.message === "string" ? record.message : "Codex worker failed."
  };
}

async function main(): Promise<void> {
  const request = JSON.parse(await readStdin()) as CodexAgentWorkerRequest;
  if (request.protocolVersion !== CODEX_AGENT_WORKER_PROTOCOL_VERSION) {
    throw new Error("Codex worker protocol version mismatch.");
  }

  const client = new Codex();
  const thread = client.startThread(request.threadOptions);
  const turnOptions: TurnOptions = { outputSchema: request.outputSchema };
  const streamed = await thread.runStreamed(request.task, turnOptions);
  for await (const event of streamed.events) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify(safeError(error))}\n`);
  process.exitCode = 2;
});
