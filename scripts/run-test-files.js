#!/usr/bin/env bun

const pattern = Bun.argv[2];
if (!pattern) throw new Error('A test glob is required.');
const testArgs = Bun.argv.slice(3);

const files = [...new Bun.Glob(pattern).scanSync({ cwd: process.cwd(), onlyFiles: true })].sort(
  (left, right) => left.localeCompare(right),
);

for (const file of files) {
  const child = Bun.spawn(['bun', 'test', ...testArgs, file], {
    cwd: process.cwd(),
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) process.exit(exitCode);
}
