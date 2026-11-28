import { createHash } from 'node:crypto';
import type { Golden } from './golden.js';
import { compareWithKnown, missingKnownCase, type KnownDifference } from './known-differences.js';
import type { CaseRun, UnavailableCase } from './runner.js';
import type { Difference } from './wildcard.js';

export interface CaseResult {
  scenario: string;
  name: string;
  difference: Difference | null;
  native: boolean;
  unavailable?: UnavailableCase;
  fallbacks: string[];
}

export interface ScenarioResult {
  scenario: string;
  missingGolden: boolean;
  cases: CaseResult[];
}

export function compareScenario(golden: Golden | null, runs: CaseRun[], scenario: string, known: readonly KnownDifference[] = []): ScenarioResult {
  if (!golden) {
    return { scenario, missingGolden: true, cases: [] };
  }
  const result = (name: string, difference: Difference | null, run?: CaseRun): CaseResult => ({
    scenario,
    name,
    difference,
    native: difference === null && run !== undefined && !run.unavailable && run.fallbacks.length === 0,
    fallbacks: run?.fallbacks ?? [],
  });
  const byName = new Map(runs.map((run) => [run.name, run]));
  const recorded = new Set(golden.cases.map((expected) => expected.name));
  const approvals = known.filter((entry) => entry.scope === 'scenario' && entry.name === scenario);
  const cases = golden.cases.map((expected) => {
    const run = byName.get(expected.name);
    if (!run) return result(expected.name, { path: '$', kind: 'missing', expected: 'a recorded case', actual: '(case no longer generated)' });
    if (run.unavailable) return { ...result(expected.name, null, run), unavailable: run.unavailable };
    if (run.unresolvedPlaceholder !== undefined) {
      return result(expected.name, { path: '$.request', kind: 'missing', expected: 'all response placeholders resolved', actual: run.unresolvedPlaceholder }, run);
    }
    return result(expected.name, compareWithKnown(expected.expected, run.capture, approvals.filter((entry) => entry.case === expected.name)), run);
  });
  // A step added without recording again would otherwise never be checked.
  const unrecorded = runs.filter((run) => !recorded.has(run.name)).map((run) =>
    result(run.name, { path: '$', kind: 'extra', expected: '(not recorded)', actual: 'a generated case; run bun run parity:record' }, run));
  const stale = approvals.filter((entry) => !recorded.has(entry.case) && !byName.has(entry.case));
  return { scenario, missingGolden: false, cases: [...cases, ...unrecorded, ...stale.map((entry) => result(entry.case, missingKnownCase(entry)))] };
}

export function replayPassed(results: ScenarioResult[], allowUnported = false): boolean {
  return results.every((result) => !result.missingGolden
    && result.cases.every((entry) => entry.difference === null && (allowUnported || !entry.unavailable)));
}

function counts(cases: CaseResult[]) {
  return {
    passed: cases.filter((entry) => !entry.difference && !entry.unavailable).length,
    native: cases.filter((entry) => entry.native).length,
    unported: cases.filter((entry) => entry.unavailable?.kind === 'unported').length,
    blocked: cases.filter((entry) => entry.unavailable?.kind === 'blocked').length,
    mismatching: cases.filter((entry) => entry.difference).length,
  };
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

// What a replay prints: the head of a report, with the scenarios that were
// never recorded, and the first difference of each of the first failing cases.
export function replaySummary(results: ScenarioResult[], report: string): string {
  const failing = results.flatMap((result) => result.cases).filter((result) => result.difference);
  const shown = [report.split('\n\n## ', 1)[0]!];
  for (const { scenario, cases } of results) {
    const { unported } = counts(cases);
    if (unported > 0) shown.push(`UNPORTED ${scenario}: ${unported} cases`);
    for (const entry of cases) {
      if (entry.unavailable?.kind === 'blocked') {
        shown.push(`BLOCKED ${scenario}/${entry.name} by ${entry.unavailable.supplier}`);
      }
    }
  }
  for (const result of failing.slice(0, 20)) {
    shown.push(`FAIL ${result.scenario}/${result.name} at ${result.difference!.path}: expected ${result.difference!.expected}, got ${result.difference!.actual}`);
  }
  return shown.join('\n');
}

// Renders a report with no timings or temporary paths, so two replays of the
// same build write the same file and it can be diffed in CI.
export function renderReport(label: string, results: ScenarioResult[], measuresFallback: boolean): string {
  const cases = results.flatMap((result) => result.cases);
  const failing = cases.filter((result) => result.difference);
  const total = counts(cases);
  const lines: string[] = [];
  lines.push('# Parity replay report', '');
  lines.push(`Build: \`${label}\``, '');
  lines.push(`Passed: ${total.passed}/${cases.length} cases`);
  if (measuresFallback) {
    lines.push(
      `Matched natively: ${total.native}/${cases.length} cases`,
      `Matched via fallback: ${total.passed - total.native}/${cases.length} cases`,
      `Unported: ${total.unported}/${cases.length} cases`,
      `Blocked by an unported step: ${total.blocked}/${cases.length} cases`,
      `Mismatching: ${total.mismatching}/${cases.length} cases`,
    );
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

  lines.push('', '## Scenarios', '');
  if (measuresFallback) {
    lines.push('| scenario | passed | matched natively | unported | blocked | mismatching |', '| --- | ---: | ---: | ---: | ---: | ---: |');
  } else {
    lines.push('| scenario | passed | native |', '| --- | ---: | ---: |');
  }
  for (const result of results) {
    const { passed, native, unported, blocked, mismatching } = counts(result.cases);
    const runCount = result.cases.length;
    const classifications = measuresFallback ? `${native}/${runCount} | ${unported} | ${blocked} | ${mismatching}` : 'n/a';
    lines.push(`| ${result.scenario} | ${passed}/${runCount} | ${classifications} |`);
  }

  if (total.unported + total.blocked > 0) {
    lines.push('', '## Unported and blocked cases', '');
    for (const entry of cases) {
      if (entry.unavailable?.kind === 'unported') lines.push(`- ${entry.scenario}/${entry.name}: unported`);
      if (entry.unavailable?.kind === 'blocked') {
        lines.push(`- ${entry.scenario}/${entry.name}: blocked by ${entry.unavailable.supplier}`);
      }
    }
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
