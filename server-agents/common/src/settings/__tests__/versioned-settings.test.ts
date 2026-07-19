import { describe, expect, test } from 'bun:test';
import { createVersionedSettings } from '../versioned-settings.js';

function settings() {
  return createVersionedSettings({
    ownerId: 'test',
    schemaVersion: 1,
    defaults: { mode: 'fast', count: 1 },
    descriptors: [
      {
        key: 'mode',
        type: 'enum',
        label: 'Mode',
        options: [{ value: 'fast', label: 'Fast' }],
      },
      { key: 'count', type: 'number', label: 'Count', min: 0, max: 2, step: 1 },
    ],
  });
}

describe('createVersionedSettings', () => {
  test('validates envelopes, values, and patches without mutating inputs', async () => {
    const facet = settings();
    const defaults = facet.defaults();
    const patched = facet.applyPatch(defaults, { count: 2 });
    expect(defaults.values.count).toBe(1);
    expect(patched.values.count).toBe(2);
    expect(await facet.migrate(patched)).toEqual(patched);
    expect(() => facet.parse({ ...defaults, ownerId: 'other' })).toThrow('Invalid settings');
    expect(() => facet.applyPatch(defaults, { unknown: true })).toThrow('Unknown setting');
    expect(() => facet.applyPatch(defaults, { count: 3 })).toThrow('Invalid value');
  });
});
