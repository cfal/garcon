// Calls the export of runtime.ts for the recorder test to capture.
import { expect, test } from 'bun:test';
import { runtime } from './runtime.js';

test('reports its runtime', () => {
  expect(runtime()[0]).toBe(Bun.version);
});
