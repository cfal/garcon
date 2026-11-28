// Calls a module's exports with explicit inputs in a fresh process and writes
// each outcome, encoded, to the record stream on fd 3. The inputs arrive on
// stdin as JSON lines of `{ id, fn, args, guard? }` and the outcomes leave in
// the same order, so a stalled run can be resumed after the call that stalled.
import { writeSync } from 'node:fs';
import { decode, encodeCall } from './encode.js';
import type { Json } from '../wildcard.js';

export const STREAM_VARIABLE = 'GARCON_UNIT_EVALUATE_FD';

const streamFd = Number(process.env[STREAM_VARIABLE]);
if (!Number.isInteger(streamFd)) {
  throw new Error(`The unit evaluator is started by \`bun rust/parity/cli.ts unit record|replay\` (${STREAM_VARIABLE} is unset).`);
}

// Work a call leaves behind may fail later; only the call's own outcome is
// observed.
process.on('uncaughtException', () => undefined);
process.on('unhandledRejection', () => undefined);

function write(record: object): void {
  try {
    writeSync(streamFd, `${JSON.stringify(record)}\n`);
  } catch { /* The runner stopped reading. */ }
}

interface Input {
  id: string;
  fn: string;
  args: Json[];
  // The guard of a trap variant. The original is not called when the guard
  // rejects the argument.
  guard?: { argument: number; spec: string };
}

// `fn` is an export name, `Class.method` for a static method, or
// `new Class` for a constructor call.
async function evaluateOne(namespace: Record<string, unknown>, fn: string, args: Json[]): Promise<Record<string, Json>> {
  const constructed = /^new (.+)$/.exec(fn);
  const [owner, method] = fn.split('.');
  const target: unknown = constructed
    ? namespace[constructed[1]!]
    : method === undefined ? namespace[fn] : (namespace[owner!] as Record<string, unknown> | undefined)?.[method];
  if (typeof target !== 'function') return { missing: true as const };
  try {
    const decoded = args.map((arg) => decode(arg));
    let result: unknown;
    if (constructed) result = Reflect.construct(target, decoded);
    else if (method === undefined) result = Reflect.apply(target, undefined, decoded);
    else result = Reflect.apply(target, namespace[owner!], decoded);
    if (result instanceof Promise) result = await result;
    const call = encodeCall([], { kind: 'return', value: result });
    return call.ok ? { result: call.result } : { notCaptured: call.failure };
  } catch (error) {
    const call = encodeCall([], { kind: 'throw', value: error });
    return call.ok ? { result: call.result } : { notCaptured: call.failure };
  }
}

// A guard of the recorder (`--guard <function>:<argument index>=<guard>`) is
// an export of the recorded module, or `<file>#<export>`.
const guards = new Map<string, Function>();

async function guardNamed(namespace: Record<string, unknown>, spec: string): Promise<Function> {
  const known = guards.get(spec);
  if (known) return known;
  const hash = spec.indexOf('#');
  const exports: Record<string, unknown> = hash === -1
    ? namespace
    : Object.fromEntries(Object.entries(await import(spec.slice(0, hash))));
  const guard = exports[hash === -1 ? spec : spec.slice(hash + 1)];
  if (typeof guard !== 'function') throw new Error(`The guard is not an exported function: ${spec}`);
  guards.set(spec, guard);
  return guard;
}

// Whether the guard of a trap variant rejects its argument: it throws, or it
// returns null, undefined, or false.
async function rejected(namespace: Record<string, unknown>, input: Input): Promise<boolean> {
  if (!input.guard) return false;
  let value: unknown;
  try {
    value = decode(input.args[input.guard.argument]);
  } catch {
    // The call itself reports an argument that cannot be decoded.
    return false;
  }
  // A guard that is not there stops the recording; it is not a rejection.
  const guard = await guardNamed(namespace, input.guard.spec);
  try {
    const verdict = await guard(value);
    return verdict === null || verdict === undefined || verdict === false;
  } catch {
    return true;
  }
}

// A failure outside a call, such as a module or a guard that cannot be loaded,
// ends the run with its message on stderr and a failing exit code, both of
// which the recorder reports. Without this, the handler above would swallow it.
try {
  await run();
  // A call may have left a timer running; the outcomes are complete.
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function run(): Promise<void> {
  const [modulePath] = Bun.argv.slice(2);
  if (!modulePath) throw new Error('Usage: bun evaluate.ts <module> (inputs on stdin)');
  const namespace = Object.fromEntries(Object.entries(await import(modulePath))) as Record<string, unknown>;
  const lines = (await Bun.stdin.text()).split('\n').filter(Boolean);
  for (const line of lines) {
    const input = JSON.parse(line) as Input;
    // A circular or otherwise unencodable input cannot be decoded.
    if (await rejected(namespace, input)) write({ id: input.id, guarded: true });
    else write({ id: input.id, ...await evaluateOne(namespace, input.fn, input.args) });
  }
}
