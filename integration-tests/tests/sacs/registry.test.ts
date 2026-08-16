import { expect, test } from 'bun:test';
import {
  requiredSacsScriptedDriverIds,
  sacsScriptedDriverFactories,
} from './drivers.js';

test('[TLV5-L12.04-SACS-REGISTRY-01] registers every required scripted integration exactly once', () => {
  const ids = sacsScriptedDriverFactories.map((driver) => driver.id);
  expect(ids).toEqual([...requiredSacsScriptedDriverIds]);
  expect(new Set(ids).size).toBe(ids.length);
});
