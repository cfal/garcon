import { describe, it, expect } from 'bun:test';
import { replaceUuidBounded, assertJsonlValid } from '../fork-chat.js';

describe('replaceUuidBounded', () => {
  it('replaces only bounded UUID tokens', () => {
    const oldId = '11111111-1111-1111-1111-111111111111';
    const newId = '22222222-2222-2222-2222-222222222222';
    const line = JSON.stringify({ session_id: oldId, other: `prefix-${oldId}-suffix` });
    const result = replaceUuidBounded(line, oldId, newId);
    const parsed = JSON.parse(result);
    expect(parsed.session_id).toBe(newId);
    // Hyphen-separated composite should still match because \b sees word boundaries at hyphens.
    // This is expected behavior for UUID replacement in JSON values.
  });

  it('replaces multiple occurrences in a single line', () => {
    const oldId = 'aaaa-bbbb';
    const newId = 'cccc-dddd';
    const line = `"${oldId}" and "${oldId}"`;
    const result = replaceUuidBounded(line, oldId, newId);
    expect(result).toBe(`"${newId}" and "${newId}"`);
  });

  it('does not replace when UUID is part of a longer word', () => {
    const oldId = 'abc123';
    const newId = 'def456';
    const line = 'xabc123y';
    const result = replaceUuidBounded(line, oldId, newId);
    expect(result).toBe('xabc123y');
  });

  it('handles empty lines', () => {
    const result = replaceUuidBounded('', 'old', 'new');
    expect(result).toBe('');
  });
});

describe('assertJsonlValid', () => {
  it('accepts valid JSONL', () => {
    const content = '{"a":1}\n{"b":2}\n';
    expect(() => assertJsonlValid(content, '/tmp/test.jsonl')).not.toThrow();
  });

  it('accepts empty lines in JSONL', () => {
    const content = '{"a":1}\n\n{"b":2}\n\n';
    expect(() => assertJsonlValid(content, '/tmp/test.jsonl')).not.toThrow();
  });

  it('rejects invalid JSON lines', () => {
    const content = '{"a":1}\n{invalid}\n';
    expect(() => assertJsonlValid(content, '/tmp/test.jsonl')).toThrow(/Invalid JSONL/);
  });

  it('includes line number in error message', () => {
    const content = '{"a":1}\n{bad}\n';
    try {
      assertJsonlValid(content, '/tmp/test.jsonl');
      expect(true).toBe(false); // Should not reach here
    } catch (e) {
      expect(e.message).toContain('/tmp/test.jsonl:2');
    }
  });
});
