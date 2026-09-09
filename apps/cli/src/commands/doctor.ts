import type { CliCommandResult } from "../bounded-task.js";
import {
  BOUNDED_LOCAL_CONFIG_VERSION,
  doctorBoundedLocalConfig
} from "../product-config.js";

export async function doctorCommand(startPath = process.cwd()): Promise<CliCommandResult> {
  const diagnosed = await doctorBoundedLocalConfig(startPath);
  return {
    exitCode: 0,
    output: {
      ok: true,
      command: "doctor",
      configVersion: BOUNDED_LOCAL_CONFIG_VERSION,
      repositoryRoot: diagnosed.repositoryRoot,
      packageManager: diagnosed.config.packageManager.name,
      typescript: diagnosed.config.typescript.detected,
      scripts: diagnosed.config.scripts,
      checks: diagnosed.checks
    }
  };
}
