# Results

This directory contains stable, human-readable result pages derived from
benchmark artifacts.

## First Milestone

- [`FIRST_MILESTONE_FIGURES.md`](FIRST_MILESTONE_FIGURES.md): visual summary of
  the first behavior and code benchmark milestone.

## Phase Results

- [`PHASE_S_REPAIR_VERIFICATION_RESULTS.md`](PHASE_S_REPAIR_VERIFICATION_RESULTS.md):
  deterministic repairDraft verification results, including local checks and
  live RunPod forced-remask validation.
- [`PHASE_T_PATCH_DRY_RUN_RESULTS.md`](PHASE_T_PATCH_DRY_RUN_RESULTS.md):
  deterministic patch application dry-run results, including local checks and
  live RunPod forced-remask validation.
- [`PHASE_V_TEMPORARY_WORKSPACE_EXECUTION_RESULTS.md`](PHASE_V_TEMPORARY_WORKSPACE_EXECUTION_RESULTS.md):
  bounded temporary workspace execution verification results, including local
  fixtures, live RunPod forced-remask validation, and cleanup guarantees.

Raw benchmark artifacts are generated under `reports/` during local or RunPod
runs. Those artifacts are not the main documentation surface; this directory
keeps the curated result pages that are easier to share and read.
