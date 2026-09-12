import { fileURLToPath } from 'node:url';

export function serverSelfCommand(args: readonly string[]): [string, ...string[]] {
  return Reflect.get(globalThis, Symbol.for('garcon.compiled-mode')) === true
    ? [process.execPath, ...args]
    : [process.execPath, fileURLToPath(new URL('../main.ts', import.meta.url)), ...args];
}
