// Computes in Bun what the helpers of garcon-js must reproduce.
//
// Reads a JSON request from the file named by the second argument and writes
// a JSON reply to stdout. Doubles travel as the 16-digit hex form of their
// bits, so that the reply never reformats them.

import path from "node:path";

interface Reply { [section: string]: unknown }

const request = JSON.parse(await Bun.file(process.argv[2]!).text()) as Record<string, unknown>;
const reply: Reply = {};

function fromBits(bits: string): number {
  const buffer = new ArrayBuffer(8);
    new DataView(buffer).setBigUint64(0, BigInt(`0x${bits}`));
  return new DataView(buffer).getFloat64(0);
}

function toBits(value: number): string {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value);
  return new DataView(buffer).getBigUint64(0).toString(16).padStart(16, "0");
}

function outcome(operation: () => unknown): unknown {
  try {
    return { value: operation() };
  } catch (error) {
    return { error: `${(error as Error).name}: ${(error as Error).message}` };
  }
}

const bits = (section: unknown): string[] => (section as string[]) ?? [];

if (request.numberToString) {
  reply.numberToString = bits(request.numberToString).map((bits) => String(fromBits(bits)));
}
if (request.jsonStringify) {
  reply.jsonStringify = bits(request.jsonStringify).map((bits) => JSON.stringify(fromBits(bits)));
}
if (request.mathRound) {
  reply.mathRound = bits(request.mathRound).map((bits) => toBits(Math.round(fromBits(bits))));
}
if (request.numberClass) {
  reply.numberClass = bits(request.numberClass).map((bits) => {
    const value = fromBits(bits);
    return [Number.isInteger(value), Number.isSafeInteger(value), Number.isFinite(value)];
  });
}
if (request.toFixed) {
  reply.toFixed = (request.toFixed as [string, number][]).map(([bits, digits]) =>
    outcome(() => fromBits(bits).toFixed(digits)));
}
if (request.parseInt) {
  reply.parseInt = (request.parseInt as [string, number][]).map(([text, radix]) => {
    const value = parseInt(text, radix);
    return Number.isNaN(value) ? { nan: true } : { value: toBits(value) };
  });
}
if (request.iso) {
  // Milliseconds travel as decimal strings because they exceed 2^53 nowhere
  // but keep their sign and exact value this way.
  reply.iso = bits(request.iso).map((milliseconds) =>
    outcome(() => new Date(Number(milliseconds)).toISOString()));
}
if (request.posixNormalize) reply.posixNormalize = bits(request.posixNormalize).map((value) => path.posix.normalize(value));
if (request.posixDirname) reply.posixDirname = bits(request.posixDirname).map((value) => path.posix.dirname(value));
if (request.posixBasename) reply.posixBasename = bits(request.posixBasename).map((value) => path.posix.basename(value));
if (request.posixJoin) {
  reply.posixJoin = (request.posixJoin as string[][]).map((parts) => path.posix.join(...parts));
}
if (request.posixResolve) {
  reply.posixResolve = (request.posixResolve as [string, string[]][]).map(([cwd, parts]) => {
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      return path.posix.resolve(...parts);
    } finally {
      process.chdir(previous);
    }
  });
}
if (request.posixRelative) {
  reply.posixRelative = (request.posixRelative as [string, string, string][]).map(([cwd, from, to]) => {
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      return path.posix.relative(from, to);
    } finally {
      process.chdir(previous);
    }
  });
}
if (request.win32IsAbsolute) reply.win32IsAbsolute = bits(request.win32IsAbsolute).map((value) => path.win32.isAbsolute(value));
if (request.win32Normalize) reply.win32Normalize = bits(request.win32Normalize).map((value) => path.win32.normalize(value));
if (request.win32Dirname) reply.win32Dirname = bits(request.win32Dirname).map((value) => path.win32.dirname(value));
if (request.win32ParseRoot) reply.win32ParseRoot = bits(request.win32ParseRoot).map((value) => path.win32.parse(value).root);
if (request.jsonRoundTrip) {
  reply.jsonRoundTrip = bits(request.jsonRoundTrip).map((text) => outcome(() => JSON.stringify(JSON.parse(text))));
}
if (request.defaultSort) {
  reply.defaultSort = (request.defaultSort as string[][]).map((values) => [...values].sort());
}

process.stdout.write(JSON.stringify(reply));
