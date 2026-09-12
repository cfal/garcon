import { mock } from 'bun:test';
import { FFIType } from 'bun:ffi';

const [mode, failure, timeout] = process.argv.slice(2);
const calls: unknown[] = [];
const native = Object.fromEntries(['signal', 'sigemptyset', 'sigaddset', 'pthread_sigmask', 'alarm'].map((name) => [name, (...args: unknown[]) => {
  calls.push([name, ...args]);
  return name === failure ? (name === 'signal' ? -1n : -1) : 0;
}]));
mock.module('bun:ffi', () => ({ FFIType, ptr: (buffer: BigUint64Array) => { if (buffer.byteLength !== 128) throw new Error('Invalid synthetic mask'); return 1; },
  dlopen() {
    if (failure === 'dlopen') throw new Error('synthetic private libc failure');
    return { symbols: native, close() { calls.push(['close']); } };
  } }));
mock.module('../../../lib/bounded-text-stream.js', () => ({ readTextStreamWithLimit() { calls.push(['stdin']); throw new Error('Unexpected stdin'); } }));
mock.module('../../systemd/bus.js', () => ({ NativeSystemdBus: class { constructor() { calls.push(['bus']); throw new Error('Unexpected bootstrap'); } } }));
if (mode === 'main') {
  process.argv = [process.execPath, 'synthetic-helper', '--internal-systemd-helper'];
  await (await import('../../systemd/helper-main.js')).runSystemdHelperMain();
  console.error(JSON.stringify(calls));
} else {
  try {
    await (await import('../../systemd/helper-deadline.js')).armSystemdHelperDeadline(Number(timeout));
    console.log(JSON.stringify({ armed: true, calls }));
  } catch { console.log(JSON.stringify({ armed: false, calls })); }
}
