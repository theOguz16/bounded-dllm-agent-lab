import {
  buildStateOutput,
  type CliCommandResult,
  type TaskFile
} from "../bounded-task.js";

export async function inspectCommand(task: TaskFile): Promise<CliCommandResult> {
  return { output: buildStateOutput("inspect", task), exitCode: 0 };
}
