// Bun test preload of the unit recorder. It loads the recorded module,
// replaces every function export with a recording proxy through
// `mock.module`, and appends each call, encoded, to the record stream on fd 3.
// `bun rust/parity/cli.ts unit record` starts it; it is not loaded by hand.
import { writeSync } from 'node:fs';
import { relative } from 'node:path';
import { mock } from 'bun:test';
import { encode, encodeOutcome, INSTANCES_VARIABLE, recordLine, type EncodedValue } from './encode.js';

// The recorder passes its settings in the environment, since a preload has no
// arguments of its own.
export const MODULE_VARIABLE = 'GARCON_UNIT_RECORD_MODULE';
export const STREAM_VARIABLE = 'GARCON_UNIT_RECORD_FD';
export const ROOT_VARIABLE = 'GARCON_UNIT_RECORD_ROOT';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`The unit recorder preload is started by \`bun rust/parity/cli.ts unit record\` (${name} is unset).`);
  }
  return value;
}

const modulePath = required(MODULE_VARIABLE);
const streamFd = Number(required(STREAM_VARIABLE));
const root = required(ROOT_VARIABLE);
const instances = process.env[INSTANCES_VARIABLE] === '1';

// Calls are numbered in call order. A promise result is written when it
// settles, so the reader sorts each process's records by this number.
let sequence = 0;

function write(record: object): void {
  try {
    writeSync(streamFd, recordLine(record));
  } catch { /* The recorder stopped reading; the tests still run. */ }
}

// The first stack frame outside this preload and the recorded module, as a
// repository-relative `file:line:column`. It names the test that made a call
// the recorder could not encode.
function caller(): string | null {
  const stack = new Error().stack ?? '';
  for (const line of stack.split('\n')) {
    if (line.includes(import.meta.path) || line.includes(modulePath)) continue;
    const match = /\(?([^()\s]+):(\d+):(\d+)\)?\s*$/.exec(line);
    if (!match) continue;
    return `${relative(root, match[1]!)}:${match[2]!}:${match[3]!}`;
  }
  return null;
}

function finish(seq: number, fn: string, args: EncodedValue, kind: 'return' | 'throw', value: unknown): void {
  if (!args.ok) {
    write({ seq, fn, notCaptured: { ...args.failure, where: 'args', at: caller() } });
    return;
  }
  const result = encodeOutcome({ kind, value }, instances);
  if (!result.ok) {
    write({ seq, fn, notCaptured: { ...result.failure, where: 'result', at: caller() } });
    return;
  }
  write({ seq, fn, args: args.value, result: result.value });
}

// `thisArg` is what the caller passed. Through the proxy it is the proxy
// itself, which the recorded function must not see in place of its module's
// own binding.
function invoke(fn: string, target: Function, thisArg: unknown, args: unknown[]): unknown {
  const seq = sequence++;
  const before = encode(args, '$.args');
  let result: unknown;
  try {
    result = Reflect.apply(target, thisArg, args);
  } catch (error) {
    finish(seq, fn, before, 'throw', error);
    throw error;
  }
  if (result instanceof Promise) {
    const settled = (kind: 'return' | 'throw') => (value: unknown) => finish(seq, fn, before, kind, value);
    void result.then(settled('return'), settled('throw'));
  } else {
    finish(seq, fn, before, 'return', result);
  }
  return result;
}

// A proxy keeps `name`, `length`, `prototype`, and property descriptors of the
// function it stands for, which a wrapper function would not. A class also
// records its static methods and `new`; its prototype is left alone, so
// instance methods and `instanceof` are untouched.
function recordingProxy(name: string, target: Function): Function {
  const isClass = /^class\s/.test(Function.prototype.toString.call(target));
  const statics = new Map<string, Function>();
  const self = (thisArg: unknown): unknown => (thisArg === proxy ? target : thisArg);
  const proxy = new Proxy(target, {
    apply(method, thisArg, args) {
      return invoke(name, method, thisArg, args);
    },
    construct(method, args, newTarget) {
      const seq = sequence++;
      const before = encode(args, '$.args');
      let instance: object;
      try {
        instance = Reflect.construct(method, args, newTarget === proxy ? method : newTarget);
      } catch (error) {
        finish(seq, `new ${name}`, before, 'throw', error);
        throw error;
      }
      finish(seq, `new ${name}`, before, 'return', instance);
      return instance;
    },
    ...(isClass ? {
      get(method: Function, property: string | symbol, receiver: unknown) {
        if (typeof property !== 'string' || property === 'constructor' || property === 'prototype') {
          return Reflect.get(method, property, receiver);
        }
        const found: unknown = Reflect.get(method, property, receiver);
        if (typeof found !== 'function') return found;
        let recording = statics.get(property);
        if (!recording) {
          recording = new Proxy(found, {
            apply: (owner, thisArg, args) => invoke(`${name}.${property}`, owner, self(thisArg), args),
          });
          statics.set(property, recording);
        }
        return recording;
      },
    } : {}),
  });
  return proxy;
}

const namespace = await import(modulePath);
const exportsBefore = Object.fromEntries(Object.entries(namespace)) as Record<string, unknown>;
const mocked = Object.fromEntries(Object.entries(exportsBefore).map(([name, value]) => [
  name,
  typeof value === 'function' ? recordingProxy(name, value) : value,
]));
mock.module(modulePath, () => mocked);
