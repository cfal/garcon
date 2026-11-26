import { createHash } from 'node:crypto';
import type { Golden } from './golden.js';
import type { CaseRun } from './runner.js';
import { firstDifference, type Difference } from './wildcard.js';

export interface CaseResult {
  scenario: string;
  name: string;
  difference: Difference | null;
  native: boolean;
  fallbacks: string[];
}

export interface ScenarioResult {
  scenario: string;
  missingGolden: boolean;
  cases: CaseResult[];
}

export function compareScenario(golden: Golden | null, runs: CaseRun[], scenario: string): ScenarioResult {
  if (!golden) {
    return { scenario, missingGolden: true, cases: [] };
  }
  const result = (name: string, difference: Difference | null, run?: CaseRun): CaseResult => ({
    scenario,
    name,
    difference,
    native: run !== undefined && run.fallbacks.length === 0,
    fallbacks: run?.fallbacks ?? [],
  });
  const byName = new Map(runs.map((run) => [run.name, run]));
  const recorded = new Set(golden.cases.map((expected) => expected.name));
  const cases = golden.cases.map((expected) => {
    const run = byName.get(expected.name);
    return run
      ? result(expected.name, firstDifference(expected.expected, run.capture), run)
      : result(expected.name, { path: '$', kind: 'missing', expected: 'a recorded case', actual: '(case no longer generated)' });
  });
  // A step added without recording again would otherwise never be checked.
  const unrecorded = runs.filter((run) => !recorded.has(run.name)).map((run) =>
    result(run.name, { path: '$', kind: 'extra', expected: '(not recorded)', actual: 'a generated case; run bun run parity:record' }, run));
  return { scenario, missingGolden: false, cases: [...cases, ...unrecorded] };
}

// Failures that differ the same way share one field and kind, so one port bug
// that breaks forty cases is one row in the report.
function differenceGroup(result: CaseResult): { field: string; kind: string } {
  const difference = result.difference!;
  return { field: difference.path.replace(/\[\d+\]/g, '[]'), kind: difference.kind };
}

function shortId(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 6);
}

function cell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

// Renders a report with no timings or temporary paths, so two replays of the
// same build write the same file and it can be diffed in CI.
export function renderReport(label: string, results: ScenarioResult[], measuresFallback: boolean): string {
  const cases = results.flatMap((result) => result.cases);
  const failing = cases.filter((result) => result.difference);
  const native = cases.filter((result) => result.native).length;
  const lines: string[] = [];
  lines.push('# Parity replay report', '');
  lines.push(`Build: \`${label}\``, '');
  lines.push(`Passed: ${cases.length - failing.length}/${cases.length} cases`);
  if (measuresFallback) {
    const rate = cases.length === 0 ? 0 : ((cases.length - native) / cases.length) * 100;
    lines.push(`Served without falling back to the original: ${native}/${cases.length} (fallback rate ${rate.toFixed(1)}%)`);
  }
  const missing = results.filter((result) => result.missingGolden).map((result) => result.scenario);
  if (missing.length > 0) lines.push('', `Never recorded: ${missing.join(', ')}`);

  if (failing.length > 0) {
    const groups = new Map<string, { field: string; kind: string; cases: CaseResult[] }>();
    for (const result of failing) {
      const { field, kind } = differenceGroup(result);
      const key = `${field}|${kind}`;
      const group = groups.get(key) ?? { field, kind, cases: [] };
      group.cases.push(result);
      groups.set(key, group);
    }
    lines.push('', '## Distinct differences', '', '| id | count | field | kind | first case |', '| --- | ---: | --- | --- | --- |');
    const ordered = [...groups.entries()].sort((left, right) =>
      right[1].cases.length - left[1].cases.length || left[0].localeCompare(right[0]));
    for (const [key, { field, kind, cases: group }] of ordered) {
      lines.push(`| ${shortId(key)} | ${group.length} | \`${cell(field)}\` | ${kind} | ${cell(`${group[0].scenario}/${group[0].name}`)} |`);
    }
  }

  lines.push('', '## Scenarios', '', '| scenario | passed | native |', '| --- | ---: | ---: |');
  for (const result of results) {
    const passed = result.cases.filter((entry) => !entry.difference).length;
    const nativeCount = result.cases.filter((entry) => entry.native).length;
    lines.push(`| ${result.scenario} | ${passed}/${result.cases.length} | ${measuresFallback ? `${nativeCount}/${result.cases.length}` : 'n/a'} |`);
  }

  if (failing.length > 0) {
    lines.push('', '## Failing cases');
    for (const result of failing) {
      const difference = result.difference!;
      lines.push('', `### ${result.scenario}/${result.name}`, '');
      lines.push(`- at \`${difference.path}\` (${difference.kind})`);
      lines.push(`- expected: \`${cell(difference.expected)}\``);
      lines.push(`- actual: \`${cell(difference.actual)}\``);
      if (result.fallbacks.length > 0) lines.push(`- fell back: ${result.fallbacks.map((line) => `\`${cell(line)}\``).join(', ')}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
