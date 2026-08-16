import { expect, test } from 'bun:test';
import {
  sacsScriptedDriverFactories,
} from './drivers.js';

test('[TLV5-L12.04-SACS-REGISTRY-01] registers every required scripted integration exactly once', () => {
  const ids = sacsScriptedDriverFactories.map((driver) => driver.id);
  expect(ids).toEqual([
    'claude',
    'codex',
    'direct-openai-responses-compatible',
    'direct-openai-compatible',
    'direct-anthropic-compatible',
    ...(process.platform === 'linux' ? ['opencode'] : []),
    'pi',
  ]);
  expect(new Set(ids).size).toBe(ids.length);
});
