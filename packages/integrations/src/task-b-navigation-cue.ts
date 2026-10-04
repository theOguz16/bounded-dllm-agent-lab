import { createHash } from "node:crypto";
import { verifyCanonicalRepoIntelligence,
  type CanonicalRepoIntelligence } from "../../product-runtime/src/canonical-repo-intelligence.js";

export const TASK_B_NAVIGATION_RULE = "task-b-selected-seed-sole-function/v1";
export const TASK_B_NAVIGATION_ANALYZER_HASH =
  "sha256:9f9dd6ac6b83045163508cf5c7ffe1959afee5ecc88fd1d337740f71adfe1670";
export const TASK_B_NAVIGATION_CONTEXT_HASH =
  "sha256:1380c7fe3080ffd7557cd6747fc66952879a2622cb23fe7a892e6b370edc6bc2";
export const TASK_B_NAVIGATION_SOURCE = "ea6bc88e947e78b7539b9614b4c637dd9b2805a9";
export const TASK_B_NAVIGATION_FILES = Object.freeze([
  { path: "packages/integrations/src/codex-event-parser.ts",
    sha256: "sha256:2fddcdcc6f346d5db20eafc6843551b64a9cb52e5fd25e94f6968be0472b2f12", bytes: 18225 },
  { path: "scripts/smoke/codex-event-parser-smoke.cjs",
    sha256: "sha256:23d3a00af138742767eabc51bbcf6c1dcdb25372226751b6f011f7914be27a9d", bytes: 6443 }
]);
export const TASK_B_NAVIGATION_BLOCK =
  "Navigation cue (symbols only):\n" + JSON.stringify({ symbolsByFile: {
    [TASK_B_NAVIGATION_FILES[0].path]: ["parseCodexJsonl"],
    [TASK_B_NAVIGATION_FILES[1].path]: ["main"]
  } });
export const TASK_B_NAVIGATION_HASH =
  "sha256:bb8d818d86dafa932ed304f957ccaa7aa698b9ced91999d851acdbf0ab2f5b88";
export const TASK_B_NAVIGATION_BYTES = 174;
export const TASK_B_NAVIGATION_ESTIMATED_TOKENS = 44;
const sha = (bytes: string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function gate(ok: unknown, reason: string): asserts ok {
  if (!ok) throw Error(`task_b_navigation_cue_invalid: ${reason}`);
}

/** Project only facts from the caller's already-computed analyzer result. Never scans. */
export function deriveTaskBNavigationCue(intelligence: CanonicalRepoIntelligence,
  selectedFileHashes: readonly { path: string; sha256: string; bytes: number }[]) {
  gate(intelligence?.intelligenceHash === TASK_B_NAVIGATION_ANALYZER_HASH &&
    verifyCanonicalRepoIntelligence(intelligence), "analyzer identity");
  gate(sha(JSON.stringify(selectedFileHashes)) === TASK_B_NAVIGATION_CONTEXT_HASH &&
    JSON.stringify(selectedFileHashes) === JSON.stringify(TASK_B_NAVIGATION_FILES),
  "selected context identity");
  const facts = TASK_B_NAVIGATION_FILES.map(file => intelligence.scannedFiles.find(
    fact => fact.path === file.path && fact.contentHash === file.sha256 &&
      fact.bytes === file.bytes));
  gate(facts.every(Boolean), "analyzer file facts");
  const parserFunctions = facts[0]!.symbols.filter(symbol =>
    symbol.kind === "function" && symbol.exported).map(symbol => symbol.name);
  const testFunctions = facts[1]!.symbols.filter(symbol =>
    symbol.kind === "function").map(symbol => symbol.name);
  gate(parserFunctions.length === 1 && testFunctions.length === 1,
    "sole function projection");
  const block = "Navigation cue (symbols only):\n" + JSON.stringify({ symbolsByFile: {
    [TASK_B_NAVIGATION_FILES[0].path]: parserFunctions,
    [TASK_B_NAVIGATION_FILES[1].path]: testFunctions
  } });
  gate(block === TASK_B_NAVIGATION_BLOCK && sha(block) === TASK_B_NAVIGATION_HASH &&
    Buffer.byteLength(block) === TASK_B_NAVIGATION_BYTES,
  "frozen cue serialization");
  return Object.freeze({ block, cueHash: TASK_B_NAVIGATION_HASH,
    bytes: TASK_B_NAVIGATION_BYTES, estimatedTokens: TASK_B_NAVIGATION_ESTIMATED_TOKENS,
    analyzerHash: intelligence.intelligenceHash, contextHash: TASK_B_NAVIGATION_CONTEXT_HASH,
    projectionRule: TASK_B_NAVIGATION_RULE,
    symbolInventory: Object.freeze(facts.map(fact => Object.freeze({
      path: fact!.path, symbols: Object.freeze(fact!.symbols.map(symbol =>
        Object.freeze({ name: symbol.name, kind: symbol.kind, exported: symbol.exported })))
    }))) });
}
