import { resolve } from 'node:path';
import type { Golden } from '../golden.js';
import { compareScenario, renderReport, type ScenarioResult } from '../report.js';
import type { CaseRun } from '../runner.js';
import { wildcardPaths, type Json } from '../wildcard.js';
import { readCases, type RecordedCase } from './cases.js';
import { EVALUATE_STALL_MS, evaluateInputs, type Evaluation } from './record.js';

// An outcome that is not an encoded result, as the value the comparison sees.
function captureOf(evaluation: Evaluation): Json {
  if ('result' in evaluation) return evaluation.result;
  if ('timedOut' in evaluation) return { 'no outcome within': `${EVALUATE_STALL_MS} ms` };
  if ('missing' in evaluation) return { 'no longer exported': true };
  return { 'not encodable': `${evaluation.notCaptured.type} at ${evaluation.notCaptured.path}` };
}

// Calls the original with every case in a fresh process and compares each
// outcome with the recorded result.
export async function replayCases(modulePath: string, cases: RecordedCase[], label: string, instances = false): Promise<ScenarioResult> {
  const evaluations = await evaluateInputs(modulePath, cases, EVALUATE_STALL_MS, instances);
  const golden: Golden = {
    scenario: label,
    cases: cases.map((entry) => ({ name: entry.id, expected: entry.result, noise: wildcardPaths(entry.result) })),
  };
  const runs: CaseRun[] = cases.map((entry, index) => ({ name: entry.id, capture: captureOf(evaluations[index]!), fallbacks: [] }));
  return compareScenario(golden, runs, label);
}

// Replays a recording on disk against the original. Fails before any call
// when the case file was edited.
export async function replayUnit(repoRoot: string, outDirectory: string): Promise<ScenarioResult> {
  const { manifest, cases } = await readCases(outDirectory);
  return replayCases(resolve(repoRoot, manifest.module), cases, manifest.module, manifest.instances === true);
}

export function renderUnitReport(result: ScenarioResult): string {
  return renderReport('original', [result], false);
}
