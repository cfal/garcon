import { resolve } from 'node:path';
import { bunCheck, pinnedBunVersion } from '../bun-version.js';
import { replaySummary } from '../report.js';
import { recordedBunVersion, writeCases, type GuardSpec, type JsonArgument } from './cases.js';
import { recordUnit } from './record.js';
import { replayCases, replayUnit, renderUnitReport } from './replay.js';

// Records on another Bun than the one the repository pins (ADR-026).
const ANY_BUN = '--any-bun';

export const UNIT_USAGE = `Usage:
  bun rust/parity/cli.ts unit record <module.ts> --tests <test file>... [--inputs <file.jsonl>]
                              [--guard <function>:<argument index>=<guard>]...
                              [--json <function>:<argument index>]... [--instances] [--any-bun] --out <dir>
  bun rust/parity/cli.ts unit replay <dir>

record   Runs the module's tests twice with every call to its function exports
         recorded, adds trap variants and explicit inputs, and replays the
         result against the original. Writes cases.jsonl and manifest.json
         only when that replay passes. A guard keeps a trap variant of a typed
         argument only when the original's own function for that type accepts
         the value; <guard> is an export of the recorded module or
         <file>#<export>. An argument declared with --json reaches the port as
         JSON, so NaN and the infinities are not tried on it. --instances
         records returned class names and their enumerable own fields. It runs only on
         the Bun the repository pins, unless --any-bun is given.
replay   Calls the original with every recorded case and compares. It warns
         when the recording or this replay is on another Bun than the pinned one.`;

interface RecordArguments {
  module: string;
  tests: string[];
  inputs?: string;
  guards: GuardSpec[];
  jsonArguments: JsonArgument[];
  instances?: true;
  out: string;
}

// `<function>:<argument index>`, as a guard and a JSON declaration name it.
function parseTarget(text: string): { fn: string; argument: number } {
  const [, fn, index] = /^(.+):(\d+)$/.exec(text) ?? [];
  if (!fn) throw new Error(`A function and an argument are <function>:<argument index>; got "${text}".`);
  return { fn, argument: Number(index) };
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
  const parsed: RecordArguments = { module, tests: [], guards: [], jsonArguments: [], out: '' };
  let fillingTests = false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (argument === '--tests') {
      fillingTests = true;
    } else if (argument === '--instances') {
      fillingTests = false;
      parsed.instances = true;
    } else if (['--inputs', '--out', '--guard', '--json'].includes(argument)) {
      fillingTests = false;
      const value = rest[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} needs a value.`);
      if (argument === '--guard') parsed.guards.push(parseGuard(value));
      else if (argument === '--json') parsed.jsonArguments.push(parseTarget(value));
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
    // `--any-bun` records on another Bun than the pinned one (ADR-026).
    const anyBun = rest.includes(ANY_BUN);
    const operands = rest.filter((argument) => argument !== ANY_BUN);
    if (command === 'record' || command === 'replay') {
      const bun = bunCheck(command, Bun.version, await pinnedBunVersion(repoRoot), anyBun);
      if (bun.refuse) {
        console.error(bun.warning);
        return 2;
      }
      if (bun.warning) console.error(`warning: ${bun.warning}`);
    }
    if (command === 'record') {
      const options = parseRecord(operands);
      const recording = await recordUnit({ ...options, repoRoot });
      for (const line of recording.review) console.log(line);
      const result = await replayCases(recording.modulePath, recording.cases, recording.manifest.module, recording.manifest.instances);
      console.log(replaySummary([result], renderUnitReport(result)));
      if (!passed(result)) {
        console.error(`The original does not replay this recording; nothing was written to ${options.out}.`);
        return 1;
      }
      await writeCases(resolve(options.out), recording.cases, recording.manifest);
      return 0;
    }
    if (command === 'replay' && operands.length === 1) {
      const recorded = await recordedBunVersion(resolve(repoRoot, operands[0]!));
      if (recorded !== null && recorded !== Bun.version) {
        console.error(`warning: this recording was made on Bun ${recorded} and is replayed on ${Bun.version}, on which the original may behave differently.`);
      }
      const result = await replayUnit(repoRoot, operands[0]!);
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
