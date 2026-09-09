import { runBoundedTask } from "../../../../packages/product-runtime/src/canonical-runtime.js";
import {
  buildRunInput,
  buildResultOutput,
  exitForResult,
  type CliCommandResult,
  type TaskFile
} from "../bounded-task.js";

export async function runCommand(task: TaskFile): Promise<CliCommandResult> {
  const input = await buildRunInput(task);
  const result = await runBoundedTask(input);
  return {
    output: buildResultOutput("run", task, result),
    exitCode: exitForResult(result)
  };
}
