const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8").replace(/\s+/g, " ");
const scope = read("docs/PRODUCT_SCOPE_V1.md");
const productPath = read("docs/PRODUCT_PATH.md");
const currentState = read("docs/CURRENT_STATE.md");
const architecture = read("docs/ARCHITECTURE.md");

function hasAll(document, fragments, label) {
  for (const fragment of fragments) {
    assert.ok(document.includes(fragment), `${label} must include ${JSON.stringify(fragment)}`);
  }
}

hasAll(scope, [
  "Untested product hypothesis",
  "Not a validated market claim",
  "single-machine, developer-supervised",
  "## Supported scenario 1: bug fix in an existing function",
  "## Supported scenario 2: bounded behavior change in existing files",
  "## Supported scenario 3: regression test in an existing test file",
  "### Required inputs",
  "### Allowed changes",
  "### Mandatory checks",
  "### User delivery and measurable acceptance",
  "## `text-file-update/v1` mutation boundary",
  "does **not** support creating, deleting, or renaming files",
  "### Canonical product runtime",
  "### Legacy review pipeline",
  "### Research and benchmark pipeline",
  "Validated no change",
  "Human review required",
  "Replan required",
  "Recovery required",
  "**Control result:**",
  "**Behavior result:**",
  "## Unsupported work and environments",
  "## Compatibility decision"
], "product scope");

assert.equal((scope.match(/### Required inputs/g) || []).length, 3);
assert.equal((scope.match(/### Allowed changes/g) || []).length, 3);
assert.equal((scope.match(/### Mandatory checks/g) || []).length, 3);
assert.equal((scope.match(/### User delivery and measurable acceptance/g) || []).length, 3);

hasAll(productPath, [
  "PRODUCT_SCOPE_V1.md",
  "Legacy review pipeline",
  "required controls passed",
  "requested behavior was demonstrated"
], "product path");

hasAll(currentState, [
  "PRODUCT_SCOPE_V1.md",
  "text-file-update/v1",
  "controls passed",
  "behavioral success",
  "bounded-task-receipt/v3",
  "Schema 3 and older records are rejected"
], "current state");

hasAll(architecture, [
  "### Canonical runtime",
  "### Legacy review pipeline",
  "### Research and benchmark pipeline",
  "does not create, delete, or rename files",
  "control results and behavioral acceptance are separate"
], "architecture");

console.log("product scope v1 documentation contract passed");
