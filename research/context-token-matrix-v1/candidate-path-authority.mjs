import fs from 'node:fs';
import path from 'node:path';

export class CandidatePathAuthorityError extends Error {
  constructor(code, diagnostic) {
    super(`candidate_path_authority_invalid: ${code}`);
    this.name = 'CandidatePathAuthorityError';
    this.code = code;
    this.diagnostic = { ...diagnostic, comparisonOutcome: 'rejected', issueCode: code };
  }
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Canonical file authority, with lexical traversal and in-root symlinks denied. */
export function authorizeCandidateFile({ authorityRoot, candidatePath, expectedCanonicalRoot }) {
  const diagnostic = { lexicalNormalizedPath: null, canonicalNormalizedPath: null,
    authorityCanonicalRoot: null };
  const fail = code => { throw new CandidatePathAuthorityError(code, diagnostic); };
  if (typeof authorityRoot !== 'string' || !path.isAbsolute(authorityRoot) ||
      typeof candidatePath !== 'string' || !path.isAbsolute(candidatePath)) fail('path_not_absolute');
  if (candidatePath.split(path.sep).includes('..')) fail('parent_traversal');
  const lexicalRoot = path.resolve(authorityRoot);
  const lexicalCandidate = path.resolve(candidatePath);
  diagnostic.lexicalNormalizedPath = lexicalCandidate;
  let canonicalRoot;
  try {
    if (!fs.statSync(lexicalRoot).isDirectory()) fail('authority_root_not_directory');
    canonicalRoot = fs.realpathSync.native(lexicalRoot);
  } catch (error) {
    if (error instanceof CandidatePathAuthorityError) throw error;
    fail('authority_root_unavailable');
  }
  diagnostic.authorityCanonicalRoot = canonicalRoot;
  if (expectedCanonicalRoot !== undefined &&
      (typeof expectedCanonicalRoot !== 'string' ||
        path.resolve(expectedCanonicalRoot) !== canonicalRoot)) fail('authority_root_changed');
  const inputRoot = within(lexicalRoot, lexicalCandidate) ? lexicalRoot :
    within(canonicalRoot, lexicalCandidate) ? canonicalRoot : null;
  const lexicalRelative = inputRoot === null ? null : path.relative(inputRoot, lexicalCandidate);
  if (lexicalRelative === null) fail('lexical_outside_authority');
  let cursor = inputRoot;
  try {
    for (const component of lexicalRelative.split(path.sep)) {
      cursor = path.join(cursor, component);
      if (fs.lstatSync(cursor).isSymbolicLink()) fail('symlink_component');
    }
    if (!fs.statSync(lexicalCandidate).isFile()) fail('candidate_not_regular_file');
    diagnostic.canonicalNormalizedPath = fs.realpathSync.native(lexicalCandidate);
  } catch (error) {
    if (error instanceof CandidatePathAuthorityError) throw error;
    fail('candidate_path_unavailable');
  }
  if (!within(canonicalRoot, diagnostic.canonicalNormalizedPath)) fail('canonical_outside_authority');
  return { ...diagnostic, comparisonOutcome: 'inside_authority', issueCode: null };
}
