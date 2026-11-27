// A module of function declarations, with a value export beside them.
export const LABEL = 'functions';

export function join(parts: string[], separator = ','): string {
  return parts.join(separator);
}

export function upper(text: string): string {
  return text.toUpperCase();
}

// Calls another export, which the recorder captures as well.
export function shout(text: string): string {
  return `${upper(text)}!`;
}

export function reject(code: string): never {
  const error = new Error(`rejected ${code}`) as Error & { code?: string; status?: number };
  error.code = code;
  error.status = 418;
  throw error;
}

export function refuse(reason: string): never {
  throw reason;
}

export function later(text: string): Promise<string> {
  return Promise.resolve(`later ${text}`);
}

export function echo(value: unknown): unknown {
  return value;
}

export function kinds(): unknown[] {
  return [
    undefined, NaN, Infinity, -Infinity, -0,
    new Date('2026-11-27T10:11:12.000Z'),
    new Map([['a', 1]]),
    new Set([1, 2]),
    Uint8Array.from([1, 2, 3]),
    Buffer.from('hi'),
    10n,
  ];
}

export class Thing {
  constructor(readonly name: string) {}
}

export function wrap(name: string): Thing {
  return new Thing(name);
}

export function make(): (value: number) => number {
  return (value) => value + 1;
}

export function never(): Promise<string> {
  return new Promise(() => undefined);
}

export function forever(): number {
  while (true) { /* A call that does not return. */ }
}
