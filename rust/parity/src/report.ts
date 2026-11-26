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
  const byName = new Map(runs.map((run) => [run.name, run]));
  const cases = golden.cases.map((expected): CaseResult => {
    const run = byName.get(expected.name);
    if (!run) {
      return {
        scenario,
        name: expected.name,
        difference: { path: '$', kind: 'missing', expected: 'a recorded case', actual: '(case no longer generated)' },
        native: false,
        fallbacks: [],
      };
    }
    return {
      scenario,
      name: expected.name,
      difference: firstDifference(expected.expected, run.capture),
      native: run.fallbacks.length === 0,
      fallbacks: run.fallbacks,
    };
  });
  return { scenario, missingGolden: false, cases };
}

// The difference signature groups failures that differ the same way, so one
// port bug that breaks forty cases is one row in the report.
function signature(result: CaseResult): string {
  const difference = result.difference!;
  const field = difference.path.replace(/\[\d+\]/g, '[]');
  return `${field}|${difference.kind}`;
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
    const groups = new Map<string, CaseResult[]>();
    for (const result of failing) {
      const key = signature(result);
      groups.set(key, [...(groups.get(key) ?? []), result]);
    }
    lines.push('', '## Distinct differences', '', '| id | count | field | kind | first case |', '| --- | ---: | --- | --- | --- |');
    for (const [key, group] of [...groups.entries()].sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))) {
      const [field, kind] = key.split('|');
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
