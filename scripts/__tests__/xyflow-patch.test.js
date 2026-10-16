import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const commonjs = require('@xyflow/system');
const esmPath = resolve(dirname(require.resolve('@xyflow/system')), '../esm/index.mjs');
const esm = await import(pathToFileURL(esmPath).href);

test('XYFlow patch preserves export parity across ESM and CommonJS', () => {
  expect(Object.keys(commonjs).sort()).toEqual(Object.keys(esm).sort());
});

test('XYFlow UMD supports browser consumers without a Node process global', () => {
  const browser = {};
  runInNewContext(readFileSync(require.resolve('@xyflow/system'), 'utf8'), browser);
  expect('process' in browser).toBe(false);
  browser.XYFlowSystem.handleAttributionWarning('svelte');
  expect(browser.XYFlowSystem.getNodesBounds([
    { id: 'synthetic-node', position: { x: 10, y: 20 }, width: 100, height: 50, data: {} },
  ])).toEqual({ x: 10, y: 20, width: 100, height: 50 });
});

describe.each([['ESM', esm], ['CommonJS', commonjs]])('%s interaction cancellation', (_, runtime) => {
  test('unregisters callbacks and aborts each host independently', () => {
    const first = {};
    const second = {};
    const calls = [];
    const unregister = runtime.registerInteractionAbort(first, () => calls.push('removed'));
    unregister();
    runtime.registerInteractionAbort(first, () => calls.push('first'));
    runtime.registerInteractionAbort(second, () => calls.push('second'));
    runtime.abortInteractions(first);
    runtime.abortInteractions(first);
    expect(calls).toEqual(['first']);
    runtime.abortInteractions(second);
    expect(calls).toEqual(['first', 'second']);
  });

  test('finishes cleanup after a callback throws and releases the registration', () => {
    const host = {};
    const calls = [];
    runtime.registerInteractionAbort(host, () => { throw new Error('synthetic failure'); });
    runtime.registerInteractionAbort(host, () => calls.push('cleaned'));
    expect(() => runtime.abortInteractions(host)).toThrow(AggregateError);
    expect(calls).toEqual(['cleaned']);
    expect(() => runtime.abortInteractions(host)).not.toThrow();
    runtime.registerInteractionAbort(host, () => calls.push('next'));
    runtime.abortInteractions(host);
    expect(calls).toEqual(['cleaned', 'next']);
  });
});
