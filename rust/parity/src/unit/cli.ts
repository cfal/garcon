import { resolve } from 'node:path';
import { replaySummary } from '../report.js';
import { writeCases, type GuardSpec } from './cases.js';
import { recordUnit } from './record.js';
import { replayCases, replayUnit, renderUnitReport } from './replay.js';

export const UNIT_USAGE = `Usage:
  bun rust/parity/cli.ts unit record <module.ts> --tests <test file>... [--inputs <file.jsonl>]
                              [--guard <function>:<argument index>=<guard>]... --out <dir>
  bun rust/parity/cli.ts unit replay <dir>

record   Runs the module's tests twice with every call to its function exports
         recorded, adds trap variants and explicit inputs, and replays the
         result against the original. Writes cases.jsonl and manifest.json
         only when that replay passes. A guard keeps a trap variant of a typed
         argument only when the original's own function for that type accepts
         the value; <guard> is an export of the recorded module or
         <file>#<export>.
replay   Calls the original with every recorded case and compares.`;

interface RecordArguments {
  module: string;
  tests: string[];
  inputs?: string;
  guards: GuardSpec[];
  out: string;
}

// `--guard <function>:<argument index>=<guard>`, where <guard> is an export
// of the recorded module or `<file>#<export>`.
function parseGuard(text: string): GuardSpec {
  const match = /^(.+):(\d+)=(.+)$/.exec(text);
  const [, fn, index, guard] = match ?? [];
  // An export name, or a file and an export name around one `#`.
  const hash = (guard ?? '').indexOf('#');
  const named = hash === -1 || (hash > 0 && hash < guard!.length - 1 && hash === guard!.lastIndexOf('#'));
  if (!fn || !guard || !named) {
    throw new Error(`A guard is <function>:<argument index>=<guard>, where <guard> is an export of the recorded module or <file>#<export>; got "${text}".`);
  }
  return { fn, argument: Number(index), guard };
}

export function parseRecord(args: string[]): RecordArguments {
  const [module, ...rest] = args;
  if (!module || module.startsWith('-')) throw new Error('record takes the module path first.');
  const parsed: RecordArguments = { module, tests: [], guards: [], out: '' };
  let fillingTests = false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (argument === '--tests') {
      fillingTests = true;
    } else if (['--inputs', '--out', '--guard'].includes(argument)) {
      fillingTests = false;
      const value = rest[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} needs a value.`);
      if (argument === '--guard') parsed.guards.push(parseGuard(value));
      else parsed[argument === '--inputs' ? 'inputs' : 'out'] = value;
      index += 1;
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (!fillingTests) {
      throw new Error(`Unexpected argument: ${argument}`);
    } else {
      parsed.tests.push(argument);
    }
  }
  if (parsed.out === '') throw new Error('record needs --out <dir>.');
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
      console.log(replaySummary([result], renderUnitReport(result)));
      if (!passed(result)) {
        console.error(`The original does not replay this recording; nothing was written to ${options.out}.`);
        return 1;
      }
      await writeCases(resolve(options.out), recording.cases, recording.manifest);
      return 0;
    }
    if (command === 'replay' && rest.length === 1) {
      const result = await replayUnit(repoRoot, rest[0]!);
      console.log(replaySummary([result], renderUnitReport(result)));
      return passed(result) ? 0 : 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  console.log(UNIT_USAGE);
  return 2;
}
