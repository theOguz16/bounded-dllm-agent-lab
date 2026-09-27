#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateExperimentResult } from './result.mjs';

const FIELD_NAMES = ['variant','status','decision','route','initialPromptEstimatedTokens',
  'selectedFileCount','selectedBytes','input','cached','uncached','output','total',
  'plannerInput','coderInput','turns','tools','expansionsRequested','expansionsGranted',
  'changedFiles','scopeViolations','validation','behavior','inputChangeVsCurrentPercent'];
const nullable = value => value === null || value === undefined ? '' : String(value);
function percent(value, control) { return value === null || control === null || control === 0
  ? null : Number(((value - control) / control * 100).toFixed(2)); }
function ratio(numerator, denominator) { return numerator === null || denominator === null || denominator === 0
  ? null : Number((numerator / denominator).toFixed(4)); }
export function compareExperimentResults(results, { historical = false } = {}) {
  if (!Array.isArray(results) || results.length === 0 || results.length > 30) throw new Error('comparison requires 1-30 results');
  results.forEach(validateExperimentResult);
  const first = results[0];
  for (const entry of results) {
    if (entry.task.taskHash !== first.task.taskHash || entry.task.sourceHead !== first.task.sourceHead ||
      entry.configuration.model !== first.configuration.model ||
      entry.configuration.reasoning !== first.configuration.reasoning)
      throw new Error('comparison inputs must have the same task, source HEAD, model, and reasoning');
  }
  const controls = results.filter(x => x.context.variant === 'current');
  if (controls.length > 1) throw new Error('comparison has multiple current controls');
  const controlInput = controls[0]?.usage.aggregate.input ?? null;
  const rows = results.map(entry => {
    const u = entry.usage.aggregate;
    const validation = entry.outcome.validation;
    return { variant: entry.context.variant, status: entry.outcome.status,
      decision: entry.outcome.decision, route: entry.outcome.route,
      initialPromptEstimatedTokens: entry.context.initialPromptEstimatedTokens,
      selectedFileCount: entry.context.selectedFileCount, selectedBytes: entry.context.selectedBytes,
      input: u.input, cached: u.cached, uncached: u.uncached, output: u.output, total: u.total,
      plannerInput: entry.usage.planner?.cumulativeInputTokens ?? null,
      coderInput: entry.usage.coder?.cumulativeInputTokens ?? null,
      turns: u.totalTurns, tools: u.totalToolCalls,
      expansionsRequested: entry.context.expansion.requested,
      expansionsGranted: entry.context.expansion.granted,
      changedFiles: entry.outcome.candidateChangedFiles.join(';'),
      scopeViolations: entry.outcome.scopeViolations.join(';'),
      validation: [validation.scope, validation.syntax, validation.typecheck, validation.tests]
        .map(nullable).join('/'),
      behavior: entry.outcome.behavior,
      inputChangeVsCurrentPercent: percent(u.input, controlInput),
      derived: { coderShareOfInput: ratio(entry.usage.coder?.cumulativeInputTokens ?? null, u.input),
        plannerShareOfInput: ratio(entry.usage.planner?.cumulativeInputTokens ?? null, u.input),
        cumulativeInputToInitialRatio: ratio(u.input, entry.context.initialPromptEstimatedTokens),
        inputChangeVsCurrentPercent: percent(u.input, controlInput) } };
  });
  const report = { comparisonSchema: 'context-token-matrix-comparison/v1',
    comparisonKind: 'same_task_descriptive', taskHash: first.task.taskHash,
    sourceHead: first.task.sourceHead, model: first.configuration.model,
    reasoning: first.configuration.reasoning,
    derivedMetricsAreProviderEvidence: false, rows };
  if (historical) report.historical = JSON.parse(fs.readFileSync(new URL('./historical-references.json', import.meta.url), 'utf8'));
  return report;
}
function csvCell(value) { const s = nullable(value); return `"${s.replaceAll('"','""')}"`; }
export function renderComparison(report, format = 'table') {
  if (format === 'json') return JSON.stringify(report, null, 2) + '\n';
  if (format === 'csv') return [FIELD_NAMES.join(','), ...report.rows.map(row =>
    FIELD_NAMES.map(key => csvCell(row[key])).join(','))].join('\n') + '\n';
  if (format !== 'table') throw new Error('format must be table, json, or csv');
  const show = value => value === null || value === undefined ? '—' : String(value);
  const lines = [
    'variant | outcome | context files/bytes/initial | input/cached/uncached/output | planner/coder input | turns/tools | expansion req/granted | changed files | validation/behavior',
    ...report.rows.map(row => [row.variant, `${row.status}:${row.route}`,
      `${row.selectedFileCount}/${row.selectedBytes}/${show(row.initialPromptEstimatedTokens)}`,
      `${show(row.input)}/${show(row.cached)}/${show(row.uncached)}/${show(row.output)}`,
      `${show(row.plannerInput)}/${show(row.coderInput)}`,
      `${show(row.turns)}/${show(row.tools)}`,
      `${show(row.expansionsRequested)}/${show(row.expansionsGranted)}`,
      row.changedFiles || '—', `${row.validation}/${show(row.behavior)}`].join(' | '))
  ];
  if (report.historical) lines.push('', 'Historical references: non-paired; no statistical inference.');
  return lines.join('\n') + '\n';
}
function main(argv) {
  let format = 'table', historical = false;
  const files = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--format') format = argv[++index];
    else if (arg === '--historical') historical = true;
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else files.push(arg);
  }
  if (files.length === 0) throw new Error('usage: compare.mjs [--format table|json|csv] [--historical] result.json ...');
  const results = files.map(file => {
    if (fs.statSync(file).size > 1024 * 1024) throw new Error('result file too large');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  });
  process.stdout.write(renderComparison(compareExperimentResults(results, { historical }), format));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
