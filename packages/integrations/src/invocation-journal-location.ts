import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { InvocationJournalError } from "./durable-invocation-journal.js";

export const INVOCATION_JOURNAL_LOCATION_POLICY_VERSION =
  "invocation-journal-location/v1" as const;

export type InvocationJournalLocationAssessment = Readonly<{
  policyVersion: typeof INVOCATION_JOURNAL_LOCATION_POLICY_VERSION;
  /** Caller-supplied journal path, unmodified. */
  journalPath: string;
  /** Journal path with every existing ancestor and symlink fully resolved. */
  resolvedJournalPath: string;
  /** Source repository root after symlink resolution. */
  resolvedSourceRepositoryRoot: string;
  insideSourceRepository: boolean;
}>;

const MAX_LINK_RESOLUTION_DEPTH = 32;

/**
 * Resolves a journal path whose file may not exist yet. Existing ancestors are
 * symlink-resolved; each missing or symlinked component is followed so that a
 * configured path whose link chain enters the repository is detected even when
 * the configured path itself is expressed outside it. This matters because
 * SQLite derives -wal/-shm sibling names from the file location, so any path
 * component pointing into the repository would place durable writes there.
 */
function resolvePotentialPath(target: string, depth = 0): string {
  const normalized = path.normalize(target);
  if (depth > MAX_LINK_RESOLUTION_DEPTH) {
    throw new InvocationJournalError("invocation_journal_unavailable",
      "Invocation journal path exceeds the symlink resolution limit.");
  }
  try {
    return realpathSync(normalized);
  } catch { /* Missing tail or broken symlink: resolve component by component. */ }
  const parent = path.dirname(normalized);
  const base = path.basename(normalized);
  if (parent === normalized) return normalized;
  try {
    if (lstatSync(normalized).isSymbolicLink()) {
      const link = readlinkSync(normalized);
      const linkTarget = path.isAbsolute(link) ? link : path.join(parent, link);
      return resolvePotentialPath(linkTarget, depth + 1);
    }
  } catch { /* Plain missing tail: re-append it below. */ }
  return path.join(resolvePotentialPath(parent, depth + 1), base);
}

function contains(container: string, candidate: string): boolean {
  return candidate === container || candidate.startsWith(`${container}${path.sep}`);
}

/**
 * Determines whether the invocation-journal path would place durable writes
 * inside the source repository. Both the textual normalized path and the
 * fully resolved path are checked: any configuration whose path enters the
 * repository, directly or through a symlink, is treated as inside. The source
 * repository must be a real, accessible directory; an unresolvable root fails
 * closed instead of allowing an unverifiable journal location.
 */
export function resolveInvocationJournalLocation(input: Readonly<{
  journalPath: string;
  sourceRepositoryRoot: string;
}>): InvocationJournalLocationAssessment {
  if (typeof input.journalPath !== "string" || !path.isAbsolute(input.journalPath) ||
      input.journalPath.includes("\0")) {
    throw new InvocationJournalError("invocation_journal_unavailable",
      "Invocation journal path must be an absolute path without NUL characters.");
  }
  if (typeof input.sourceRepositoryRoot !== "string" || input.sourceRepositoryRoot.length === 0 ||
      input.sourceRepositoryRoot.includes("\0")) {
    throw new InvocationJournalError("invocation_journal_unavailable",
      "Source repository root must be a non-empty path without NUL characters.");
  }
  let resolvedSourceRepositoryRoot: string;
  try {
    resolvedSourceRepositoryRoot = realpathSync(input.sourceRepositoryRoot);
    if (!statSync(resolvedSourceRepositoryRoot).isDirectory()) {
      throw new Error("Source repository root is not a directory.");
    }
  } catch {
    throw new InvocationJournalError("invocation_journal_unavailable",
      "Source repository root could not be resolved as a real directory.");
  }
  const normalizedJournalPath = path.normalize(input.journalPath);
  const resolvedJournalPath = resolvePotentialPath(normalizedJournalPath);
  const insideSourceRepository =
    contains(resolvedSourceRepositoryRoot, resolvedJournalPath) ||
    contains(resolvedSourceRepositoryRoot, normalizedJournalPath);
  return Object.freeze({
    policyVersion: INVOCATION_JOURNAL_LOCATION_POLICY_VERSION,
    journalPath: input.journalPath,
    resolvedJournalPath,
    resolvedSourceRepositoryRoot,
    insideSourceRepository
  });
}

/**
 * Fails closed before any provider invocation when the durable invocation
 * journal would be written inside the source repository: the journal is
 * mutable runtime state, and writing it there makes the product's own journal
 * updates look like source drift to the repository-currentness guard.
 */
export function assertInvocationJournalLocationOutsideSourceRepository(input: Readonly<{
  journalPath: string;
  sourceRepositoryRoot: string;
}>): InvocationJournalLocationAssessment {
  const assessment = resolveInvocationJournalLocation(input);
  if (assessment.insideSourceRepository) {
    throw new InvocationJournalError("invocation_journal_inside_source_repository",
      "Configured invocation journal path resolves inside the source repository; " +
      "move the journal to a persistent location outside the repository.");
  }
  return assessment;
}
