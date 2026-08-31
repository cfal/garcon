import { describe, expect, it } from 'bun:test';
import {
  codexConfigServiceTier,
  codexFastMode,
  codexServiceTier,
} from '../service-tier.js';

function envelope(value) {
  return {
    ownerId: 'codex',
    schemaVersion: 2,
    values: value === undefined ? {} : { codexFastMode: value },
  };
}

describe('Codex service tier', () => {
  it('maps only an exact current-schema On value to Priority', () => {
    expect(codexFastMode(envelope('on'))).toBe('on');
    expect(codexServiceTier(codexFastMode(envelope('on')))).toBe('priority');
    expect(codexConfigServiceTier(codexFastMode(envelope('on')))).toBe('fast');

    for (const settings of [
      envelope('off'),
      envelope(undefined),
      envelope('enabled'),
      { ownerId: 'other', schemaVersion: 2, values: { codexFastMode: 'on' } },
      { ownerId: 'codex', schemaVersion: 1, values: { codexFastMode: 'on' } },
    ]) {
      expect(codexFastMode(settings)).toBe('off');
      expect(codexServiceTier(codexFastMode(settings))).toBe('default');
      expect(codexConfigServiceTier(codexFastMode(settings))).toBe('default');
    }
  });
});
