import { expect, it } from 'bun:test';
import { parseAgentNativeChildDescriptor, parseAgentNativeChildRef } from '../../contracts/native-child-observation.js';

const ref = { ownerId: 'claude', schemaVersion: 1, key: 'synthetic-child', value: { root: 'synthetic-root' } };

it('validates and clones provider-qualified child locators', () => {
  const parsed = parseAgentNativeChildRef(ref)!;
  expect(parsed).toEqual(ref);
  expect(parsed.value).not.toBe(ref.value);
  expect(parseAgentNativeChildDescriptor({ ref, parentKey: null, label: 'Synthetic task', model: null })).toEqual({
    ref, parentKey: null, label: 'Synthetic task', model: null,
  });
});

it('rejects missing, oversized and non-JSON observation identities', () => {
  for (const input of [null, {}, { ...ref, schemaVersion: 0 }, { ...ref, key: '' },
    { ...ref, key: 'a'.repeat(1025) }, { ...ref, value: { value: Infinity } },
    { ...ref, value: { value: undefined } }, { ...ref, value: { text: 'a'.repeat(16 * 1024) } }]) {
    expect(parseAgentNativeChildRef(input)).toBeNull();
  }
  expect(parseAgentNativeChildDescriptor({ ref, parentKey: null, model: null })).toBeNull();
});
