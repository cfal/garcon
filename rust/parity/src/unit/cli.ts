import { resolve } from 'node:path';
import { consoleReport } from '../report.js';
import { writeCases } from './cases.js';
import { recordUnit } from './record.js';
import { replayCases, replayUnit, renderUnitReport } from './replay.js';

export const UNIT_USAGE = `Usage:
  bun rust/parity/cli.ts unit record <module.ts> --tests <test file>... [--inputs <file.jsonl>] --out <dir>
  bun rust/parity/cli.ts unit replay <dir>

record   Runs the module's tests twice with every call to its function exports
         recorded, adds trap variants and explicit inputs, and replays the
         result against the original. Writes cases.jsonl and manifest.json
         only when that replay passes.
replay   Calls the original with every recorded case and compares.`;

interface RecordArguments {
  module: string;
  tests: string[];
  inputs?: string;
  out: string;
}

function parseRecord(args: string[]): RecordArguments {
  const [module, ...rest] = args;
  if (!module || module.startsWith('-')) throw new Error('record takes the module path first.');
  const parsed: RecordArguments = { module, tests: [], out: '' };
  let fillingTests = false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (argument === '--tests') {
      fillingTests = true;
    } else if (argument === '--inputs' || argument === '--out') {
      fillingTests = false;
      const value = rest[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} needs a value.`);
      parsed[argument === '--inputs' ? 'inputs' : 'out'] = value;
      index += 1;
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (!fillingTests) {
      throw new Error(`Unexpected argument: ${argument}`);
    } else {
      parsed.tests.push(argument);
    }
  }
  if (parsed.out === undefined) throw new Error('record needs --out <dir>.');
  if (parsed.tests.length === 0 && parsed.inputs === undefined) throw new Error('record needs --tests or --inputs.');
  return parsed;
}

const passed = (result: { cases: Array<{ difference: unknown }> }): boolean =>
  result.cases.every((entry) => entry.difference === null);

// Runs `unit <command>` with `args` after it and returns the exit code.
export async function unitCli(args: string[], repoRoot: string): Promise<number> {
  try {
    const [command, ...rest] = args;
    if (command === 'record') {
      const options = parseRecord(rest);
      const recording = await recordUnit({ ...options, repoRoot });
      for (const line of recording.review) console.log(line);
      const result = await replayCases(recording.modulePath, recording.cases, recording.manifest.module);
      consoleReport([result], renderUnitReport(result));
      if (!passed(result)) {
        console.error(`The original does not replay this recording; nothing was written to ${options.out}.`);
        return 1;
      }
      await writeCases(resolve(options.out), recording.cases, recording.manifest);
      return 0;
    }
    if (command === 'replay' && rest.length === 1) {
      const result = await replayUnit(repoRoot, rest[0]!);
      consoleReport([result], renderUnitReport(result));
      return passed(result) ? 0 : 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  console.log(UNIT_USAGE);
  return 2;
}
