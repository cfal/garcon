import { describe, expect, it } from 'bun:test';
import { isRecord } from '../json.ts';

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
