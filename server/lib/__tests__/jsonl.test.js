import { describe, expect, it } from 'bun:test';
import { parseFirstJsonlValue } from '../jsonl.ts';

describe('parseFirstJsonlValue', () => {
  it('preserves a valid JSON value', () => {
    const line = '  {"nested":{"items":[1,2]},"text":"value"}  ';

    expect(parseFirstJsonlValue(line)).toEqual({
      kind: 'value',
      value: { nested: { items: [1, 2] }, text: 'value' },
      raw: '{"nested":{"items":[1,2]},"text":"value"}',
      discardedSuffix: false,
    });
  });

  it('retains only the first value from a concatenated physical line', () => {
    const first = { type: 'user', uuid: 'entry-1', text: 'caf\u00e9' };
    const second = { type: 'mode', mode: 'normal' };

    const result = parseFirstJsonlValue(`${JSON.stringify(first)}${JSON.stringify(second)}`);

    expect(result).toEqual({
      kind: 'value',
      value: first,
      raw: JSON.stringify(first),
      discardedSuffix: true,
    });
  });

  it('discards third and later values on the same physical line', () => {
    const first = { value: 1 };
    const result = parseFirstJsonlValue(
      `${JSON.stringify(first)}${JSON.stringify({ value: 2 })}${JSON.stringify({ value: 3 })}`,
    );

    expect(result).toEqual({
      kind: 'value',
      value: first,
      raw: JSON.stringify(first),
      discardedSuffix: true,
    });
  });

  it('does not split delimiter-like text inside a string', () => {
    const value = { text: 'before }{ after', escaped: '\\"quoted\\"' };
    const line = JSON.stringify(value);

    expect(parseFirstJsonlValue(line)).toEqual({
      kind: 'value',
      value,
      raw: line,
      discardedSuffix: false,
    });
  });

  it('retains a complete value before a partial suffix', () => {
    const first = { value: 'complete' };
    const result = parseFirstJsonlValue(`${JSON.stringify(first)}{"partial":`);

    expect(result).toEqual({
      kind: 'value',
      value: first,
      raw: JSON.stringify(first),
      discardedSuffix: true,
    });
  });

  it('distinguishes incomplete and malformed values', () => {
    expect(parseFirstJsonlValue('{"partial":')).toEqual({ kind: 'incomplete' });

    const malformed = parseFirstJsonlValue('{bad}');
    expect(malformed.kind).toBe('invalid');
    expect(malformed.error).toBeInstanceOf(SyntaxError);
  });

  it('returns empty for whitespace-only input', () => {
    expect(parseFirstJsonlValue('  \t  ')).toEqual({ kind: 'empty' });
  });
});
