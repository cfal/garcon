import { expect, test } from 'bun:test';
import { coreWireShapes } from './wire-shapes.js';

test('core-1 RPC, producer, terminal and CLI payload shapes remain frozen', async () => {
  const fixture = await Bun.file(new URL('./fixtures/core-1-shapes.json', import.meta.url)).json();
  expect(coreWireShapes()).toEqual(fixture);
}, 30_000);
