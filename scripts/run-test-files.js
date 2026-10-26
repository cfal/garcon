#!/usr/bin/env bun

export function parseTestArguments(args) {
  let shard;
  const testArgs = [];
  for (const arg of args) {
    if (arg !== '--shard' && !arg.startsWith('--shard=')) {
      testArgs.push(arg);
      continue;
    }
    if (shard) throw new Error('Only one --shard argument is allowed.');
    const match = /^--shard=([1-9]\d*)\/([1-9]\d*)$/.exec(arg);
    if (!match) throw new Error('Expected --shard=INDEX/TOTAL with positive integers.');
    const index = Number(match[1]);
    const total = Number(match[2]);
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index > total) {
      throw new Error('Shard index must be within the total number of shards.');
    }
    shard = { index, total };
  }
  return { shard, testArgs };
}

export function selectTestFiles(files, shard) {
  const sorted = [...files].sort((left, right) => left.localeCompare(right));
  const selected = shard
    ? sorted.filter((_, index) => index % shard.total === shard.index - 1)
    : sorted;
  if (selected.length === 0) throw new Error('No test files selected.');
  return selected;
}

if (import.meta.main) {
  const pattern = Bun.argv[2];
  if (!pattern) throw new Error('A test glob is required.');
  const { shard, testArgs } = parseTestArguments(Bun.argv.slice(3));
  const files = [...new Bun.Glob(pattern).scanSync({ cwd: process.cwd(), onlyFiles: true })];
  const selected = selectTestFiles(files, shard);
  if (shard) console.log(`Test shard ${shard.index}/${shard.total}: ${selected.length} of ${files.length} files`);

  for (const file of selected) {
    const child = Bun.spawn(['bun', 'test', ...testArgs, file], {
      cwd: process.cwd(),
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) process.exit(exitCode);
  }
}
