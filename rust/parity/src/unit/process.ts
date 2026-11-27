import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { Json } from '../wildcard.js';

// Only the tail of a child's ordinary output is kept, for error messages.
const OUTPUT_LIMIT = 64 * 1024;

export interface StreamRun {
  code: number | null;
  stalled: boolean;
  output: string;
  // A line of the record stream that was not JSON.
  malformed: string | null;
}

export interface RecordStreamOptions {
  // Text written to the child's stdin before it is closed.
  stdin?: string;
  // A child that writes no record for this long is killed, with its process
  // group, and the run ends as stalled.
  stallMs?: number;
  onRecord: (record: Json) => void;
}

// A stalled call cannot be interrupted from inside its process, so the
// process goes, together with anything it started.
function killGroup(child: ChildProcess): void {
  try {
    process.kill(-child.pid!, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

// Runs `command` with a private record stream on fd 3: the child writes JSON
// lines there and its ordinary output stays on stdout and stderr.
// `onRecord` receives each line as it arrives, before the run resolves.
export function runWithRecordStream(command: string[], environment: NodeJS.ProcessEnv, options: RecordStreamOptions): Promise<StreamRun> {
  const { stdin, stallMs, onRecord } = options;
  return new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), {
      env: environment,
      // Detached makes the child its own process group, so a stalled run is
      // killed whole.
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    let output = '';
    const capture = (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-OUTPUT_LIMIT);
    };
    child.stdout!.on('data', capture);
    child.stderr!.on('data', capture);
    let settled = false;
    let stalled = false;
    let malformed: string | null = null;
    let stallTimer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer);
      resolve({ code: child.exitCode, stalled, output, malformed });
    };
    createInterface({ input: child.stdio[3] as Readable }).on('line', (line) => {
      clearTimeout(stallTimer);
      if (stallMs !== undefined) {
        stallTimer = setTimeout(() => {
          stalled = true;
          killGroup(child);
          finish();
        }, stallMs);
      }
      try {
        onRecord(JSON.parse(line) as Json);
      } catch {
        malformed ??= line.slice(0, 200);
      }
    });
    child.on('error', (error) => {
      output += `\n${error.message}`;
      finish();
    });
    child.on('close', finish);
    if (stallMs !== undefined) {
      stallTimer = setTimeout(() => {
        stalled = true;
        killGroup(child);
        finish();
      }, stallMs);
    }
    if (stdin !== undefined) {
      child.stdin!.on('error', () => undefined);
      child.stdin!.end(stdin);
    }
  });
}
