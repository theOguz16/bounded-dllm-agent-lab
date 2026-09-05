import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { canonicalizeRepositoryRelativePath } from "./runtime-contract-foundation.js";
import type { WorkspaceMutation } from "./workspace-mutation.js";

export const TEXT_FILE_UPDATE_VERSION = "text-file-update/v1" as const;
export const MUTATION_LIMITS = Object.freeze({ maxFileBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024, maxFiles: 32 });
export type TextFileUpdateClaimV1 = {
  claimVersion: typeof TEXT_FILE_UPDATE_VERSION;
  type: "patch_draft" | "repair_draft";
  operation: "update";
  file: string;
  expectedContentHash: string;
  newContent: string;
  description: string;
};
export class MutationContractError extends Error {
  constructor(readonly code: string, message: string, readonly file?: string) { super(message); }
}
const fail = (code: string, message: string, file?: string): never => { throw new MutationContractError(code, message, file); };
export const mutationContentHash = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export function textUpdateBytes(content: string, file?: string): Uint8Array {
  if (content.includes("\0")) fail("MUTATION_BINARY_UNSUPPORTED", "NUL-containing content is not supported.", file);
  if (Buffer.byteLength(content, "utf8") > MUTATION_LIMITS.maxFileBytes) fail("MUTATION_FILE_LIMIT_EXCEEDED", "File exceeds 1 MiB.", file);
  const bytes = Buffer.from(content, "utf8");
  if (bytes.toString("utf8") !== content) fail("MUTATION_UTF8_INVALID", "Content contains invalid Unicode.", file);
  return bytes;
}
export function parseTextFileUpdates(mutation: WorkspaceMutation): TextFileUpdateClaimV1[] {
  if (mutation === null || typeof mutation !== "object" || Array.isArray(mutation)) fail("MUTATION_SCHEMA_INVALID", "Mutation must be an object.");
  if (!((mutation.role === "coder" && mutation.target === "patchDraft") || (mutation.role === "remask" && mutation.target === "repairDraft"))) fail("MUTATION_SCHEMA_INVALID", "Only coder patchDraft or remask repairDraft updates are supported.");
  if (!Array.isArray(mutation.claims) || mutation.claims.length === 0) fail("MUTATION_SCHEMA_INVALID", "At least one update claim is required.");
  if (mutation.claims.length > MUTATION_LIMITS.maxFiles) fail("MUTATION_FILE_COUNT_EXCEEDED", "At most 32 files are supported.");
  let total = 0;
  const seen = new Set<string>();
  const claims = mutation.claims.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) fail("MUTATION_SCHEMA_INVALID", "Claim must be an object.");
    const c = value as Record<string, unknown>;
    if (![Object.prototype, null].includes(Object.getPrototypeOf(c)) || Object.getOwnPropertySymbols(c).length || Object.values(Object.getOwnPropertyDescriptors(c)).some((descriptor) => !("value" in descriptor))) fail("MUTATION_SCHEMA_INVALID", "Claim must be a plain data object.");
    const file = typeof c.file === "string" ? c.file : undefined;
    for (const operation of ["create", "delete", "rename"] as const) {
      if (c.operation === operation || operation in c || (operation === "rename" && ["from", "to", "newPath", "renameTo"].some((key) => key in c))) fail(`MUTATION_${operation.toUpperCase()}_UNSUPPORTED`, `${operation} is not supported.`, file);
    }
    if (["mode", "chmod"].some((key) => key in c || c.operation === key)) fail("MUTATION_MODE_CHANGE_UNSUPPORTED", "File mode changes are not supported.", file);
    if (["symlinkTarget", "linkTarget"].some((key) => key in c) || c.operation === "symlink") fail("MUTATION_SYMLINK_UNSUPPORTED", "Symbolic links are not supported.", file);
    if (["binary", "encoding", "base64"].some((key) => key in c) || c.operation === "binary" || c.newContent instanceof Uint8Array) fail("MUTATION_BINARY_UNSUPPORTED", "Only UTF-8 text updates are supported.", file);
    if ("proposedPatch" in c) fail("MUTATION_LEGACY_PATCH_FIELD", "Migrate proposedPatch to versioned update/newContent claims.", file);
    const fields = ["claimVersion", "type", "operation", "file", "expectedContentHash", "newContent", "description"];
    if (c.claimVersion !== TEXT_FILE_UPDATE_VERSION || c.operation !== "update" ||
        c.type !== (mutation.target === "patchDraft" ? "patch_draft" : "repair_draft") ||
        typeof c.file !== "string" || typeof c.newContent !== "string" ||
        typeof c.description !== "string" || !c.description.trim()) fail("MUTATION_SCHEMA_INVALID", "Expected an exact versioned text update claim.", file);
    if (typeof c.expectedContentHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(c.expectedContentHash)) fail("MUTATION_SOURCE_HASH_MISMATCH", "expectedContentHash is required.", file);
    if (Object.keys(c).length !== fields.length || fields.some((key) => !(key in c))) fail("MUTATION_SCHEMA_INVALID", "Expected an exact versioned text update claim.", file);
    try { canonicalizeRepositoryRelativePath(c.file); } catch { fail("MUTATION_SCHEMA_INVALID", "File path must be canonical.", file); }
    if (seen.has(file!)) fail("MUTATION_DUPLICATE_FILE", "Only one claim per file is supported.", file);
    seen.add(file!);
    total += textUpdateBytes(c.newContent as string, file).length;
    if (total > MUTATION_LIMITS.maxTotalBytes) fail("MUTATION_TOTAL_LIMIT_EXCEEDED", "New content total exceeds 4 MiB.");
    return c as unknown as TextFileUpdateClaimV1;
  });
  if (!Array.isArray(mutation.touchedFiles)) fail("MUTATION_SCHEMA_INVALID", "Claims and touchedFiles must match exactly.");
  const touched = new Set<string>();
  for (const value of mutation.touchedFiles) {
    if (typeof value !== "string") fail("MUTATION_SCHEMA_INVALID", "touchedFiles entries must be canonical paths.");
    try { canonicalizeRepositoryRelativePath(value); } catch { fail("MUTATION_SCHEMA_INVALID", "touchedFiles entries must be canonical paths.", value); }
    if (touched.has(value)) fail("MUTATION_DUPLICATE_FILE", "touchedFiles must not contain duplicate paths.", value);
    touched.add(value);
  }
  if (seen.size !== touched.size || [...seen].some((file) => !touched.has(file))) fail("MUTATION_SCHEMA_INVALID", "Claims and touchedFiles must match exactly.");
  return claims;
}
export function validateUpdateSource(claim: TextFileUpdateClaimV1, bytes: Uint8Array): void {
  if (bytes.length > MUTATION_LIMITS.maxFileBytes) fail("MUTATION_FILE_LIMIT_EXCEEDED", "Source exceeds 1 MiB.", claim.file);
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail("MUTATION_UTF8_INVALID", "Source is not valid UTF-8.", claim.file); }
  if (bytes.includes(0)) fail("MUTATION_BINARY_UNSUPPORTED", "Binary source files are not supported.", claim.file);
  if (mutationContentHash(bytes) !== claim.expectedContentHash) fail("MUTATION_SOURCE_HASH_MISMATCH", "Source content differs from the expected snapshot.", claim.file);
  if (Buffer.from(bytes).equals(textUpdateBytes(claim.newContent, claim.file))) fail("MUTATION_NO_CHANGE", "New content is identical to source.", claim.file);
}
export function validateUpdateSourceMap(claims: readonly TextFileUpdateClaimV1[], sources: Record<string, string>): void {
  let total = 0;
  for (const claim of claims) {
    if (!Object.hasOwn(sources, claim.file)) fail("MUTATION_CREATE_UNSUPPORTED", "An existing source file is required.", claim.file);
    const bytes = textUpdateBytes(sources[claim.file], claim.file);
    total += bytes.length;
    if (total > MUTATION_LIMITS.maxTotalBytes) fail("MUTATION_TOTAL_LIMIT_EXCEEDED", "Source total exceeds 4 MiB.");
    validateUpdateSource(claim, bytes);
  }
}
export async function readBoundedMutationBytes(handle: { read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }> }, maxBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const buffer = Buffer.alloc(Math.min(65536, maxBytes + 1 - total));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
    if (!bytesRead) return Buffer.concat(chunks, total);
    total += bytesRead;
    if (total > maxBytes) fail("MUTATION_FILE_LIMIT_EXCEEDED", "Source exceeds its byte limit.");
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}
export async function readTextUpdateSource(repository: string, file: string): Promise<{ bytes: Uint8Array; mode: number }> {
  canonicalizeRepositoryRelativePath(file);
  let cursor = repository;
  const segments = file.split("/");
  for (let i = 0; i < segments.length; i++) {
    cursor = path.join(cursor, segments[i]);
    let metadata;
    try { metadata = await lstat(cursor); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("MUTATION_CREATE_UNSUPPORTED", "Target must already exist.", file);
      throw error;
    }
    if (metadata.isSymbolicLink()) fail("MUTATION_SYMLINK_UNSUPPORTED", "Symlink traversal is not supported.", file);
    if (i < segments.length - 1 ? !metadata.isDirectory() : !metadata.isFile()) fail("MUTATION_FILE_TYPE_UNSUPPORTED", "Target must be a regular file with directory ancestors.", file);
  }
  const handle = await open(cursor, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) fail("MUTATION_FILE_TYPE_UNSUPPORTED", "Target must be a regular file.", file);
    if (metadata.mode & 0o7000) fail("MUTATION_MODE_CHANGE_UNSUPPORTED", "Special permission bits are unsupported.", file);
    if (metadata.size > MUTATION_LIMITS.maxFileBytes) fail("MUTATION_FILE_LIMIT_EXCEEDED", "Source exceeds 1 MiB.", file);
    return { bytes: await readBoundedMutationBytes(handle, MUTATION_LIMITS.maxFileBytes), mode: metadata.mode & 0o777 };
  } finally { await handle.close(); }
}
