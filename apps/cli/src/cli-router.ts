import { loadTaskFile, type CliCommand, type CliCommandResult } from "./bounded-task.js";
import { CliError } from "./cli-errors.js";
import { collectCliSecrets, emitCliError, emitCliOutput } from "./cli-output.js";
import { doctorCommand } from "./commands/doctor.js";
import { initCommand } from "./commands/init.js";
import { inspectCommand } from "./commands/inspect.js";
import { recoverCommand } from "./commands/recover.js";
import { resumeCommand } from "./commands/resume.js";
import { runCommand } from "./commands/run.js";
import { statusCommand } from "./commands/status.js";

export const CLI_USAGE =
  "Usage: bounded <init|doctor> [--json] | bounded <run|status|inspect|resume|recover> --task <task.json> [--json]";

type LocalCommand = "init" | "doctor";
type RoutedCommand = CliCommand | LocalCommand;

type ParsedArgs = Readonly<{
  command: RoutedCommand;
  task?: string;
  json: boolean;
}>;

const TASK_COMMANDS: readonly CliCommand[] = ["run", "status", "inspect", "resume", "recover"];
const LOCAL_COMMANDS: readonly LocalCommand[] = ["init", "doctor"];

function parseArgs(argv: readonly string[]): ParsedArgs {
  const command = argv[0] as RoutedCommand;
  if (![...TASK_COMMANDS, ...LOCAL_COMMANDS].includes(command)) {
    throw new CliError("cli_command_invalid", CLI_USAGE);
  }

  if (LOCAL_COMMANDS.includes(command as LocalCommand)) {
    const recognized = argv.filter((item, offset) => offset === 0 || item === "--json");
    if (recognized.length !== argv.length) {
      throw new CliError("cli_argument_invalid", CLI_USAGE);
    }
    return { command, json: argv.includes("--json") };
  }

  const index = argv.indexOf("--task");
  if (index < 0 || !argv[index + 1]) {
    throw new CliError("cli_task_file_missing", CLI_USAGE);
  }
  const recognized = argv.filter(
    (item, offset) =>
      offset === 0 || offset === index || offset === index + 1 || item === "--json"
  );
  if (recognized.length !== argv.length) {
    throw new CliError("cli_argument_invalid", CLI_USAGE);
  }
  return { command, task: argv[index + 1]!, json: argv.includes("--json") };
}

async function dispatch(parsed: ParsedArgs): Promise<CliCommandResult> {
  if (parsed.command === "init") return initCommand();
  if (parsed.command === "doctor") return doctorCommand();

  const task = await loadTaskFile(parsed.task!);
  switch (parsed.command) {
    case "run":
      return runCommand(task);
    case "status":
      return statusCommand(task);
    case "inspect":
      return inspectCommand(task);
    case "resume":
      return resumeCommand(task);
    case "recover":
      return recoverCommand(task);
  }
}

export async function runCanonicalCli(argv: readonly string[]): Promise<number> {
  const json = argv.includes("--json");
  const secrets = collectCliSecrets();
  try {
    const parsed = parseArgs(argv);
    const result = await dispatch(parsed);
    emitCliOutput(result.output, parsed.json, secrets);
    return result.exitCode;
  } catch (error) {
    const output = {
      ok: false,
      code: error instanceof CliError ? error.code : "cli_unexpected_failure",
      message: error instanceof Error ? error.message : "Canonical CLI failed."
    };
    emitCliError(output, json, secrets);
    return error instanceof CliError ? error.exitCode : 2;
  }
}
