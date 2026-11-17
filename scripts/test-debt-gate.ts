import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

export function testDebtProblems(before: readonly string[] | null, after: readonly string[], addedFiles: readonly string[]): string[] {
  const problems: string[] = [];
  for (const file of after) {
    if (!/^(?:server|server-agents|cli)\/.*\/__tests__\/.*\.ts$/.test(file)
      && !/^cli\/__tests__\/.*\.ts$/.test(file)) problems.push(`Not an explicit test path: ${file}`);
    if (/[*?\[\]]/.test(file)) problems.push(`Wildcard test exclusion: ${file}`);
    if (before && !before.includes(file)) problems.push(`Test exclusion grew: ${file}`);
  }
  if (new Set(after).size !== after.length) problems.push('Duplicate test exclusions');
  for (const file of addedFiles) {
    if (/^(?:server|server-agents|cli)\/.*\.test\.[cm]?jsx?$/.test(file)) {
      problems.push(`New backend tests must use TypeScript: ${file}`);
    }
  }
  return problems;
}

if (import.meta.main) {
  const file = 'tsconfig.tests.json';
  const current = JSON.parse(readFileSync(file, 'utf8')) as { exclude: string[] };
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const base = process.argv[2];
  const head = process.argv[3] ?? 'HEAD';
  let before: string[] | null = null;
  let added: string[] = [];
  if (base) {
    const commonBase = git('merge-base', base, head);
    if (git('ls-tree', '--name-only', commonBase, '--', file)) {
      before = JSON.parse(git('show', `${commonBase}:${file}`)).exclude;
    }
    added = git('diff', '--no-renames', '--diff-filter=A', '--name-only', commonBase, head).split('\n');
  }
  const problems = testDebtProblems(before, current.exclude, added);
  for (const path of current.exclude) if (!existsSync(path)) problems.push(`Missing excluded test: ${path}`);
  if (problems.length) throw new Error(problems.join('\n'));
  console.log(`Test exclusions checked: ${current.exclude.length}${base ? ' (shrink-only)' : ''}.`);
}
