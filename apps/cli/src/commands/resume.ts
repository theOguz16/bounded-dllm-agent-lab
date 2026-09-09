import { resumeBoundedTask } from "../../../../packages/product-runtime/src/canonical-runtime.js";
import {
  buildRunInput,
  buildResultOutput,
  exitForResult,
  type CliCommandResult,
  type TaskFile
} from "../bounded-task.js";

export async function resumeCommand(task: TaskFile): Promise<CliCommandResult> {
  const input = await buildRunInput(task);
  const result = await resumeBoundedTask(input);
  return {
    output: buildResultOutput("resume", task, result),
    exitCode: exitForResult(result)
  };
}
