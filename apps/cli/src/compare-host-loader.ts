import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { CliError } from "./cli-errors.js";
import { findGitRepositoryRoot } from "./product-config.js";
import type { CompareCodexDependencies } from "./commands/compare.js";

type CompareHostExports = Pick<CompareCodexDependencies, "trustedBehavior">;
type OfflineExports = Pick<CompareCodexDependencies,
  "adapter" | "model" | "prepareValidationSubstrate">;

function outside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === ".." || relative.startsWith(`..${path.sep}`);
}

async function externalModule(configured: string, repositoryRoot: string): Promise<Record<string, unknown>> {
  if (!path.isAbsolute(configured)) {
    throw new CliError("cli_compare_host_path_invalid", "Compare host module path must be absolute.", 5);
  }
  const resolved = await realpath(configured);
  const stat = await lstat(configured);
  if (!stat.isFile() || stat.isSymbolicLink() || !outside(repositoryRoot, resolved) ||
      (stat.mode & 0o022) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new CliError("cli_compare_host_boundary_invalid",
      "Compare host module must be an owner-controlled regular file outside the repository.", 5);
  }
  const loaded: unknown = await import(pathToFileURL(resolved).href);
  if (loaded === null || typeof loaded !== "object") {
    throw new CliError("cli_compare_host_invalid", "Compare host module has no exports.", 5);
  }
  return loaded as Record<string, unknown>;
}

/** Host authority is explicit and outside the agent-controlled repository. */
export async function loadCompareCliDependencies(startPath: string): Promise<CompareCodexDependencies> {
  const repositoryRoot = await realpath(await findGitRepositoryRoot(startPath));
  const dependencies: { -readonly [K in keyof CompareCodexDependencies]?: CompareCodexDependencies[K] } = {};
  const hostPath = process.env.BOUNDED_COMPARE_TRUSTED_HOST_MODULE?.trim();
  if (hostPath) {
    const host = await externalModule(hostPath, repositoryRoot);
    if (typeof host.trustedBehavior !== "function") {
      throw new CliError("cli_compare_host_invalid", "Compare host must export trustedBehavior.", 5);
    }
    dependencies.trustedBehavior = host.trustedBehavior as CompareHostExports["trustedBehavior"];
  }
  const offlinePath = process.env.BOUNDED_COMPARE_OFFLINE_FIXTURE_MODULE?.trim();
  if (offlinePath) {
    if (process.env.NODE_ENV !== "test" || process.env.CI !== "1") {
      throw new CliError("cli_compare_offline_fixture_forbidden",
        "Offline compare fixture requires the explicit test environment.", 5);
    }
    const fixture = await externalModule(offlinePath, repositoryRoot);
    if (!fixture.adapter || typeof fixture.adapter !== "object" ||
        typeof (fixture.adapter as { run?: unknown }).run !== "function" ||
        typeof fixture.model !== "string" || typeof fixture.prepareValidationSubstrate !== "function") {
      throw new CliError("cli_compare_offline_fixture_invalid", "Offline compare fixture is incomplete.", 5);
    }
    dependencies.adapter = fixture.adapter as OfflineExports["adapter"];
    dependencies.model = fixture.model as string;
    dependencies.prepareValidationSubstrate = fixture.prepareValidationSubstrate as OfflineExports["prepareValidationSubstrate"];
  }
  return dependencies;
}
