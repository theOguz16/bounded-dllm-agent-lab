import type { CliCommandResult } from "../bounded-task.js";
import {
  BOUNDED_CONFIG_PATH,
  BOUNDED_GITIGNORE_PATH,
  BOUNDED_LOCAL_CONFIG_VERSION,
  BOUNDED_POLICY_PATH,
  initializeBoundedLocalConfig
} from "../product-config.js";

export async function initCommand(startPath = process.cwd()): Promise<CliCommandResult> {
  const initialized = await initializeBoundedLocalConfig(startPath);
  return {
    exitCode: 0,
    output: {
      ok: true,
      command: "init",
      configVersion: BOUNDED_LOCAL_CONFIG_VERSION,
      repositoryRoot: initialized.repositoryRoot,
      configPath: BOUNDED_CONFIG_PATH,
      policyPath: BOUNDED_POLICY_PATH,
      gitignorePath: BOUNDED_GITIGNORE_PATH,
      packageManager: initialized.config.packageManager.name,
      typescript: initialized.config.typescript.detected,
      scripts: initialized.config.scripts
    }
  };
}
