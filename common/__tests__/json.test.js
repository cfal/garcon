import { describe, expect, it } from 'bun:test';
import { isRecord, stableJsonStringify } from '../json.ts';

describe('isRecord', () => {
  it('accepts keyed objects', () => {
    expect(isRecord({ value: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
  });

  it('rejects non-record JSON values', () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord('value')).toBe(false);
  });
});

describe('stableJsonStringify', () => {
  it('sorts object keys recursively while preserving array order and JSON semantics', () => {
    const first = { z: 1, nested: { b: 2, a: 1 }, rows: [{ y: 2, x: 1 }, 3] };
    const second = { rows: [{ x: 1, y: 2 }, 3], nested: { a: 1, b: 2 }, z: 1 };
    expect(stableJsonStringify(first)).toBe(stableJsonStringify(second));
    expect(stableJsonStringify([2, 1])).not.toBe(stableJsonStringify([1, 2]));
    expect(stableJsonStringify({ omitted: undefined, kept: null })).toBe('{"kept":null}');
  });
});
