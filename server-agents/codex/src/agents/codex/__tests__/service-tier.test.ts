import { describe, expect, it } from 'bun:test';
import { assertEffectiveTier, codexServiceTier, codexSpeed } from '../service-tier.js';

describe('Codex speed selection', () => {
  it('defaults an old empty settings envelope to Standard without accepting unknown values', () => {
    const envelope = { ownerId: 'codex', schemaVersion: 1, values: {} };
    expect(codexServiceTier(codexSpeed(envelope))).toBe('default');
    for (const speed of [null, 'priority', 'toString']) {
      expect(() => codexSpeed({ ...envelope, values: { speed } })).toThrow('Invalid value');
    }
  });

  it('accepts native aliases but rejects a different effective tier', () => {
    for (const standard of [null, 'default']) {
      expect(() => assertEffectiveTier('default', standard, 'm')).not.toThrow();
    }
    expect(() => assertEffectiveTier('priority', 'fast', 'm')).not.toThrow();
    for (const effective of [null, 'priority', 'default', 'flex']) {
      expect(() => assertEffectiveTier('ultrafast', effective, 'm')).toThrow('Ultrafast speed is unavailable');
    }
    expect(() => assertEffectiveTier('default', 'ultrafast', 'm')).toThrow();
  });

});
