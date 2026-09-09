import {
  buildStateOutput,
  type CliCommandResult,
  type TaskFile
} from "../bounded-task.js";

export async function statusCommand(task: TaskFile): Promise<CliCommandResult> {
  return { output: buildStateOutput("status", task), exitCode: 0 };
}
