#!/usr/bin/env bun

export const ISOLATED_TEST_FILES = new Set([
  'server/lib/__tests__/http-request.test.js',
  'server/routes/__tests__/chats-last-selected.test.js',
  'server/routes/__tests__/chats-search.test.js',
  'server/routes/__tests__/chats-validate-start.test.js',
  'server/routes/__tests__/files-identity.test.js',
  'server/routes/__tests__/files.test.js',
  'server/routes/__tests__/terminals.test.js',
]);

export function parseArguments(args) {
  const pattern = args[0];
  if (!pattern) throw new Error('A test glob is required.');
  let batchSize = 1;
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] !== '--batch') throw new Error(`Unknown option: ${args[index]}`);
    const rawBatchSize = args[index + 1];
    if (!rawBatchSize || !/^\d+$/.test(rawBatchSize) || Number(rawBatchSize) < 1) {
      throw new Error('--batch must be a positive integer.');
    }
    batchSize = Number(rawBatchSize);
    index += 1;
  }
  return { pattern, batchSize };
}

export function createTestBatches(files, batchSize, isolatedFiles = ISOLATED_TEST_FILES) {
  const batches = [];
  let batch = [];
  const flush = () => {
    if (batch.length > 0) batches.push(batch);
    batch = [];
  };

  for (const file of files) {
    if (isolatedFiles.has(file)) {
      flush();
      batches.push([file]);
      continue;
    }
    batch.push(file);
    if (batch.length === batchSize) flush();
  }
  flush();
  return batches;
}

export async function runTestFiles(args = Bun.argv.slice(2)) {
  const { pattern, batchSize } = parseArguments(args);
  const files = [...new Bun.Glob(pattern).scanSync({ cwd: process.cwd(), onlyFiles: true })]
    .sort((left, right) => left.localeCompare(right));

  for (const batch of createTestBatches(files, batchSize)) {
    const child = Bun.spawn(['bun', 'test', ...batch], {
      cwd: process.cwd(),
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) return exitCode;
  }
  return 0;
}

if (import.meta.main) process.exit(await runTestFiles());
