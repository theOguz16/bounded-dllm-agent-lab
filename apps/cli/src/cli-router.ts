import { loadTaskFile, type CliCommand, type CliCommandResult } from "./bounded-task.js";
import { CliError } from "./cli-errors.js";
import { collectCliSecrets, emitCliError, emitCliOutput } from "./cli-output.js";
import { applyCommand } from "./commands/apply.js";
import { codexAutoScopeCommand } from "./commands/codex-auto-scope.js";
import { compareCodexCommand } from "./commands/compare.js";
import { doctorCommand } from "./commands/doctor.js";
import { historyCommand } from "./commands/history.js";
import { initCommand } from "./commands/init.js";
import { inspectCommand } from "./commands/inspect.js";
import { recoverCommand } from "./commands/recover.js";
import { reportCommand } from "./commands/report.js";
import { resumeCommand } from "./commands/resume.js";
import { runCommand } from "./commands/run.js";
import { statusCommand } from "./commands/status.js";

export const CLI_USAGE =
  "Usage: bounded <init|doctor|apply|history> [--json] | bounded report <run-id> [--json] | bounded codex <description> [--json] | bounded codex --task <description> --allow <file> [--allow <file> ...] [--json] | bounded compare codex --task <description> [--json] | bounded <run|status|inspect|resume|recover> --task <task.json> [--json]";

type LocalCommand = "init" | "doctor" | "apply" | "history";
type RoutedCommand = CliCommand | LocalCommand | "codex" | "compare" | "report";

type ParsedArgs = Readonly<{
  command: RoutedCommand;
  task?: string;
  allowFiles?: readonly string[];
  runId?: string;
  json: boolean;
}>;

const TASK_COMMANDS: readonly CliCommand[] = ["run", "status", "inspect", "resume", "recover"];
const LOCAL_COMMANDS: readonly LocalCommand[] = ["init", "doctor", "apply", "history"];

function parseCodexArgs(argv: readonly string[]): ParsedArgs {
  let task: string | undefined;
  let taskFromFlag = false;
  const allowFiles: string[] = [];
  let json = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      if (json) throw new CliError("cli_argument_invalid", CLI_USAGE);
      json = true;
      continue;
    }
    if (argument === "--task") {
      if (task !== undefined || !argv[index + 1] || argv[index + 1]!.startsWith("--")) {
        throw new CliError("cli_codex_task_missing", CLI_USAGE);
      }
      task = argv[index + 1]!;
      taskFromFlag = true;
      index += 1;
      continue;
    }
    if (argument === "--allow") {
      if (!argv[index + 1] || argv[index + 1]!.startsWith("--")) {
        throw new CliError("cli_codex_scope_missing", CLI_USAGE);
      }
      allowFiles.push(argv[index + 1]!);
      index += 1;
      continue;
    }
    if (!argument?.startsWith("--") && task === undefined) {
      task = argument;
      continue;
    }
    throw new CliError("cli_argument_invalid", CLI_USAGE);
  }
  if (task === undefined) throw new CliError("cli_codex_task_missing", CLI_USAGE);
  if (taskFromFlag && allowFiles.length === 0) {
    throw new CliError("cli_codex_scope_missing", CLI_USAGE);
  }
  return { command: "codex", task, allowFiles, json };
}

function parseCompareArgs(argv: readonly string[]): ParsedArgs {
  if (argv[1] !== "codex") {
    throw new CliError("cli_compare_target_invalid", CLI_USAGE);
  }
  let task: string | undefined;
  let json = false;
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      if (json) throw new CliError("cli_argument_invalid", CLI_USAGE);
      json = true;
      continue;
    }
    if (argument === "--task") {
      if (task !== undefined || !argv[index + 1] || argv[index + 1]!.startsWith("--")) {
        throw new CliError("cli_compare_task_missing", CLI_USAGE);
      }
      task = argv[index + 1]!;
      index += 1;
      continue;
    }
    throw new CliError("cli_argument_invalid", CLI_USAGE);
  }
  if (task === undefined) throw new CliError("cli_compare_task_missing", CLI_USAGE);
  return { command: "compare", task, json };
}

function parseReportArgs(argv: readonly string[]): ParsedArgs {
  let runId: string | undefined;
  let json = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      if (json) throw new CliError("cli_argument_invalid", CLI_USAGE);
      json = true;
      continue;
    }
    if (!argument?.startsWith("--") && runId === undefined) {
      runId = argument;
      continue;
    }
    throw new CliError("cli_argument_invalid", CLI_USAGE);
  }
  if (!runId) throw new CliError("cli_report_run_id_missing", CLI_USAGE);
  return { command: "report", runId, json };
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const command = argv[0] as RoutedCommand;
  if (![...TASK_COMMANDS, ...LOCAL_COMMANDS, "codex", "compare", "report"].includes(command)) {
    throw new CliError("cli_command_invalid", CLI_USAGE);
  }

  if (command === "codex") return parseCodexArgs(argv);
  if (command === "compare") return parseCompareArgs(argv);
  if (command === "report") return parseReportArgs(argv);

  if (LOCAL_COMMANDS.includes(command as LocalCommand)) {
    const recognized = argv.filter((item, offset) => offset === 0 || item === "--json");
    if (recognized.length !== argv.length || argv.filter((item) => item === "--json").length > 1) {
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
  if (parsed.command === "apply") return applyCommand({ nonInteractive: parsed.json });
  if (parsed.command === "history") return historyCommand();
  if (parsed.command === "report") return reportCommand(parsed.runId!);
  if (parsed.command === "compare") return compareCodexCommand({ task: parsed.task! });
  if (parsed.command === "codex") {
    return codexAutoScopeCommand({
      task: parsed.task!,
      allowFiles: parsed.allowFiles ?? [],
      nonInteractive: parsed.json
    });
  }

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
