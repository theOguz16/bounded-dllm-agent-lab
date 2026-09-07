const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const runtime = require("../dist/packages/product-runtime/src/canonical-runtime.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-task-operations-"));
const repo = path.join(root, "repo");
const registry = path.join(root, "registry");
fs.mkdirSync(repo); fs.mkdirSync(registry);
const hash = (value) => runtime.hashCanonicalJson(value);
const identity = (taskId) => ({ taskId, repositoryPath: repo,
  repositoryIdentityHash: hash({ repo }), baselineSnapshotHash: hash({ baseline: taskId }),
  baselineHeadHash: hash({ head: taskId }), compiledPolicyHash: hash({ policy: taskId }),
  acceptanceCriteriaContractHash: hash({ acceptance: taskId }), taskInputHash: hash({ input: taskId }) });

const active = new runtime.BoundedTaskStateSession({ registryRoot: registry, idempotencyKey: "active-key" }, identity("active-task"));
const activeSummary = runtime.summarizeDurableBoundedTask({ registryRoot: registry, taskId: "active-task", idempotencyKey: "active-key" });
assert.equal(activeSummary.stopReason, "in_progress");
assert.equal(activeSummary.protected, true);
assert.match(activeSummary.operatorNextStep, /active run|checkpoint/i);
active.release();

const done = new runtime.BoundedTaskStateSession({ registryRoot: registry, idempotencyKey: "done-key" }, identity("done-task"));
done.advance("validation_completed");
done.finalize("finalized", { outcome: "accepted_patch", summary: { costBudget: { remainingProviderCalls: 0 } } });
done.release();
const rollback = new runtime.BoundedTaskStateSession({ registryRoot: registry, idempotencyKey: "rollback-key" }, identity("rollback-task"));
rollback.advance("validation_completed");
rollback.writeArtifact("rollback-bundle", { protected: true });
rollback.finalize("finalized", { outcome: "accepted_patch" });
rollback.release();
fs.mkdirSync(path.join(registry, "tasks", "invalid-entry"));
const doneSummary = runtime.summarizeDurableBoundedTask({ registryRoot: registry, taskId: "done-task", idempotencyKey: "done-key" });
assert.equal(doneSummary.stopReason, "completed");
assert.equal(doneSummary.cost.status, "available");
assert.equal(doneSummary.protected, false);

const taskFile = path.join(root, "status-task.json");
fs.writeFileSync(taskFile, JSON.stringify({ schemaVersion: "canonical-cli-task/v1", taskId: "done-task",
  objective: "inspect", repositoryPath: repo, mode: "draft", seedFiles: ["file.ts"], allowedChangeFiles: ["file.ts"],
  forbiddenFiles: [], requiredSymbols: [], requiredTestFiles: [], policyFile: "policy.yml", acceptanceFile: "acceptance.json",
  providerFile: "provider.json", durable: { registryRoot: registry, idempotencyKey: "done-key" }, timeoutMs: 1000 }));
const secret = "pilot-secret-sentinel-1234";
const cli = spawnSync(process.execPath, [path.join(__dirname, "../dist/apps/cli/src/index.js"), "status", "--task", taskFile, "--json"], {
  encoding: "utf8", env: { ...process.env, PILOT_API_KEY: secret }
});
assert.equal(cli.status, 0, cli.stderr);
assert.equal(`${cli.stdout}\n${cli.stderr}`.includes(secret), false);
const cliStatus = JSON.parse(cli.stdout);
assert.equal(cliStatus.stopReason, "completed");
assert.match(cliStatus.operatorNextStep, /receipt/i);
assert.equal(cliStatus.cost.status, "available");

const plan = runtime.planDurableBoundedTaskGarbageCollection({ registryRoot: registry, retentionMs: 0, now: Date.now() + 60_000 });
assert.equal(plan.dryRun, true);
assert.equal(plan.planVersion, "2");
assert.equal(plan.candidates.length, 1);
assert.equal(plan.protectedTasks.length, 2);
assert.deepEqual(new Set(plan.protectedTasks.map((task) => task.taskId)), new Set(["active-task", "rollback-task"]));
assert.equal(plan.invalidEntries.some((entry) => entry.name === "invalid-entry"), true);
assert.throws(() => runtime.applyDurableBoundedTaskGarbageCollection(plan, { planHash: "sha256:" + "0".repeat(64) }),
  (error) => error.code === "bounded_task_retention_plan_mismatch");
assert.throws(() => runtime.applyDurableBoundedTaskGarbageCollection({ ...plan, planVersion: "1" },
  { planHash: plan.planHash }), (error) => error.code === "bounded_task_retention_plan_version_unsupported");

const unreviewed = new runtime.BoundedTaskStateSession(
  { registryRoot: registry, idempotencyKey: "unreviewed-key" }, identity("unreviewed-task"));
unreviewed.advance("validation_completed"); unreviewed.finalize("finalized", { outcome: "accepted_patch" });
unreviewed.release();
const laterPlan = runtime.planDurableBoundedTaskGarbageCollection({
  registryRoot: registry, retentionMs: 0, now: Date.now() + 60_000
});
const injected = structuredClone(plan);
injected.candidates.push(laterPlan.candidates.find((candidate) => candidate.taskId === "unreviewed-task"));
assert.throws(() => runtime.applyDurableBoundedTaskGarbageCollection(injected, { planHash: plan.planHash }),
  (error) => error.code === "bounded_task_retention_plan_mismatch");
assert.equal(fs.existsSync(plan.candidates[0].directory), true);
assert.equal(fs.existsSync(laterPlan.candidates.find((candidate) =>
  candidate.taskId === "unreviewed-task").directory), true);

const applied = runtime.applyDurableBoundedTaskGarbageCollection(plan, { planHash: plan.planHash });
assert.deepEqual(applied.deleted, ["done-task"]);
assert.deepEqual(applied.skipped, []);
assert.equal(fs.existsSync(path.join(registry, "tasks")), true);

const raceRegistry = path.join(root, "race-registry"); fs.mkdirSync(raceRegistry);
const raced = new runtime.BoundedTaskStateSession(
  { registryRoot: raceRegistry, idempotencyKey: "raced-key" }, identity("raced-task"));
raced.advance("validation_completed"); raced.finalize("finalized", { outcome: "accepted_patch" }); raced.release();
const racePlan = runtime.planDurableBoundedTaskGarbageCollection({
  registryRoot: raceRegistry, retentionMs: 0, now: Date.now() + 60_000
});
const liveResume = new runtime.BoundedTaskStateSession(
  { registryRoot: raceRegistry, idempotencyKey: "raced-key", resume: true }, identity("raced-task"));
const racedApply = runtime.applyDurableBoundedTaskGarbageCollection(racePlan, { planHash: racePlan.planHash });
assert.deepEqual(racedApply.deleted, []);
assert.deepEqual(racedApply.skipped, ["raced-task"]);
assert.equal(fs.existsSync(racePlan.candidates[0].directory), true);
liveResume.release();
const afterRelease = runtime.applyDurableBoundedTaskGarbageCollection(racePlan, { planHash: racePlan.planHash });
assert.deepEqual(afterRelease.deleted, ["raced-task"]);

const changedRegistry = path.join(root, "changed-registry"); fs.mkdirSync(changedRegistry);
const changed = new runtime.BoundedTaskStateSession(
  { registryRoot: changedRegistry, idempotencyKey: "changed-key" }, identity("changed-task"));
changed.advance("validation_completed"); changed.finalize("finalized", { outcome: "accepted_patch" }); changed.release();
const changedPlan = runtime.planDurableBoundedTaskGarbageCollection({
  registryRoot: changedRegistry, retentionMs: 0, now: Date.now() + 60_000
});
const changedResume = new runtime.BoundedTaskStateSession(
  { registryRoot: changedRegistry, idempotencyKey: "changed-key", resume: true }, identity("changed-task"));
changedResume.writeArtifact("incident-record", { unresolved: true }); changedResume.release();
const changedApply = runtime.applyDurableBoundedTaskGarbageCollection(changedPlan,
  { planHash: changedPlan.planHash });
assert.deepEqual(changedApply.deleted, []);
assert.deepEqual(changedApply.skipped, ["changed-task"]);
assert.equal(fs.existsSync(changedPlan.candidates[0].directory), true);
console.log("bounded task operational summary and dry-run GC: PASS");
