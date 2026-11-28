import { parseArgs } from 'node:util';
import { compareOutcomes, readReports } from './compare-junit.js';

const QUADRANTS = ['rust-worker', 'rust-controller', 'rust-both', 'rust-local'] as const;
const USAGE = 'Usage: bun rust/parity/quadrants.ts --original <junit> [--rust-worker <junit>] [--rust-controller <junit>] [--rust-both <junit>] [--rust-local <junit>]';

async function run(args: string[]): Promise<number> {
  const options = {
    original: { type: 'string' },
    'rust-worker': { type: 'string' },
    'rust-controller': { type: 'string' },
    'rust-both': { type: 'string' },
    'rust-local': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  } as const;
  const { values } = parseArgs({ args, options });
  if (values.help || !values.original) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  const original = await readReports(values.original);
  const rows = [];
  for (const quadrant of QUADRANTS) {
    const path = values[quadrant];
    if (path) rows.push({ quadrant, ...compareOutcomes(original, await readReports(path)) });
  }
  console.log('| Quadrant | Same outcome | Different outcome | Failed in both |');
  console.log('| --- | ---: | ---: | ---: |');
  for (const { quadrant, same, differences, failedBoth } of rows) {
    console.log(`| ${quadrant} | ${same} | ${differences.length} | ${failedBoth} |`);
  }
  for (const { quadrant, differences } of rows) {
    for (const { test, expected, actual } of differences) {
      console.log(`DIFFERS ${quadrant}: ${test}: original=${expected} quadrant=${actual}`);
    }
  }
  return rows.some((row) => row.differences.length > 0) ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await run(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    process.exitCode = 2;
  }
}
