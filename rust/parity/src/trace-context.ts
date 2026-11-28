import { AsyncLocalStorage } from 'node:async_hooks';
import { relative } from 'node:path';
import { format } from 'node:util';
import { fileURLToPath } from 'node:url';

export interface TraceTest {
  suite: string;
  name: string;
  next: number;
  ids: Map<string, string>;
  pending: Promise<void>[];
}

const tests = new AsyncLocalStorage<TraceTest>();
const describePath: string[] = [];
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
let installed = false;

export function currentTraceTest(): TraceTest | undefined {
  return tests.getStore();
}

function registrationFile(): string {
  const path = new Error().stack?.match(/(?:\(|\bat )([^()\n]+\.test\.[cm]?[jt]sx?):\d+(?::\d+)?/)?.[1];
  if (!path) throw new Error('Cannot identify the suite registering a traced test');
  const suite = relative(repoRoot, path.startsWith('file:') ? fileURLToPath(path) : path);
  if (suite.startsWith('../')) throw new Error('Traced suites must be inside the repository');
  return suite;
}

type Call = (...args: any[]) => any;

function wrapDescribe(original: Call): Call {
  return new Proxy(original, {
    apply(target, receiver, [label, callback, ...options]) {
      if (typeof callback !== 'function') return Reflect.apply(target, receiver, [label, callback, ...options]);
      return Reflect.apply(target, receiver, [label, function (this: unknown) {
        describePath.push(label);
        try {
          return callback.call(this);
        } finally {
          describePath.pop();
        }
      }, ...options]);
    },
    get(target, property, receiver) {
      const fn = Reflect.get(target, property, receiver);
      return ['only', 'skip', 'todo'].includes(String(property)) && typeof fn === 'function' ? wrapDescribe(fn) : fn;
    },
  });
}

function wrapTest(original: Call, onFinished: (hook: () => Promise<unknown>) => void, parameterized = false): Call {
  return new Proxy(original, {
    apply(target, receiver, [label, callback, ...options]) {
      if (typeof label !== 'string' || typeof callback !== 'function') return Reflect.apply(target, receiver, [label, callback, ...options]);
      const suite = registrationFile();
      const prefix = describePath.slice();
      let index = 0;
      const wrapped = function (this: unknown, ...args: unknown[]) {
        const name = parameterized ? format(label.replaceAll('%#', String(index++)), ...args) : label;
        const test: TraceTest = { suite, name: [...prefix, name].join(' > '), next: 0, ids: new Map(), pending: [] };
        onFinished(() => Promise.all(test.pending));
        return tests.run(test, () => callback.apply(this, args));
      };
      if (!parameterized && callback.length > 0) Object.defineProperty(wrapped, 'length', { value: callback.length });
      return Reflect.apply(target, receiver, [label, wrapped, ...options]);
    },
    get(target, property, receiver) {
      const fn = Reflect.get(target, property, receiver);
      if (typeof fn !== 'function') return fn;
      if (property === 'each') return (...args: unknown[]) => wrapTest(fn(...args), onFinished, true);
      if (['if', 'skipIf', 'todoIf'].includes(String(property))) return (...args: unknown[]) => wrapTest(fn(...args), onFinished, parameterized);
      return ['only', 'skip', 'todo', 'concurrent', 'serial', 'failing'].includes(String(property)) ? wrapTest(fn, onFinished, parameterized) : fn;
    },
  });
}

export async function installTraceTestContext(): Promise<void> {
  if (installed || !process.env.GARCON_TEST_TRACE_DIR) return;
  installed = true;
  const bun = await import('bun:test');
  const original = { ...bun };
  const test = wrapTest(original.test, original.onTestFinished);
  bun.mock.module('bun:test', () => ({ ...original, test, it: test, describe: wrapDescribe(original.describe) }));
}
