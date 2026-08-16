import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CASE_ID_PATTERN = /\[(TLV5-[A-Z0-9]+(?:[.-][A-Z0-9]+)*)\]/g;
const INVENTORY_PATH = fileURLToPath(
  new URL('./conformance/transcript-ledger-v5-cases.txt', import.meta.url),
);

export function parseTranscriptConformanceInventory(contents) {
  const ids = contents.split(/\r?\n/u).filter((line) => line.length > 0);
  const errors = [];

  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) {
    errors.push('Inventory case IDs must be unique');
  }

  const sortedIds = [...ids].sort();
  if (ids.some((id, index) => id !== sortedIds[index])) {
    errors.push('Inventory case IDs must be sorted');
  }

  for (const id of ids) {
    if (!/^TLV5-[A-Z0-9]+(?:[.-][A-Z0-9]+)*$/u.test(id)) {
      errors.push(`Invalid inventory case ID: ${id}`);
    }
  }

  return { ids, errors };
}

export function discoverTranscriptConformanceCases(sources) {
  const occurrences = new Map();

  for (const source of sources) {
    const lines = source.contents.split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      for (const match of line.matchAll(CASE_ID_PATTERN)) {
        const id = match[1];
        const locations = occurrences.get(id) ?? [];
        locations.push(`${source.path}:${index + 1}`);
        occurrences.set(id, locations);
      }
    }
  }

  return occurrences;
}

export function validateTranscriptConformanceInventory(inventoryContents, sources) {
  const inventory = parseTranscriptConformanceInventory(inventoryContents);
  const occurrences = discoverTranscriptConformanceCases(sources);
  const errors = [...inventory.errors];
  const inventoryIds = new Set(inventory.ids);

  for (const id of new Set(inventory.ids)) {
    const locations = occurrences.get(id) ?? [];
    if (locations.length === 0) {
      errors.push(`Missing test case: ${id}`);
    } else if (locations.length > 1) {
      errors.push(`Duplicate test case ${id}: ${locations.join(', ')}`);
    }
  }

  for (const [id, locations] of occurrences) {
    if (!inventoryIds.has(id)) {
      errors.push(`Unregistered test case ${id}: ${locations.join(', ')}`);
    }
  }

  const cases = [...new Set(inventory.ids)].flatMap((id) => {
    const locations = occurrences.get(id) ?? [];
    return locations.length === 1 ? [{ id, location: locations[0] }] : [];
  });

  return { cases, errors };
}

function trackedTestFiles() {
  const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.test.js', '*.test.ts'],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || 'Unable to enumerate test files');
  }
  return result.stdout
    .split(/\r?\n/u)
    .filter((path) => path.length > 0 && existsSync(`${repositoryRoot}/${path}`));
}

export function validateRepositoryTranscriptConformanceInventory() {
  const sources = trackedTestFiles().map((path) => ({
    path,
    contents: readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'),
  }));
  return validateTranscriptConformanceInventory(
    readFileSync(INVENTORY_PATH, 'utf8'),
    sources,
  );
}

function main() {
  const result = validateRepositoryTranscriptConformanceInventory();
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(error);
    process.exitCode = 1;
    return;
  }

  if (process.argv.includes('--list')) {
    for (const item of result.cases) console.log(`${item.id} ${item.location}`);
    return;
  }

  console.log(`Validated ${result.cases.length} Transcript Ledger V5 cases`);
}

if (import.meta.main) main();
