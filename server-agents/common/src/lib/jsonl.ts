export type JsonlLineResult<T = unknown> =
  | { kind: 'empty' }
  | {
      kind: 'value';
      value: T;
      raw: string;
      discardedSuffix: boolean;
    }
  | { kind: 'incomplete' }
  | { kind: 'invalid'; error: SyntaxError };

export function parseFirstJsonlValue<T = unknown>(line: string): JsonlLineResult<T> {
  const input = line.trim();
  if (!input) return { kind: 'empty' };

  const parsed = Bun.JSONL.parseChunk(input);
  if (parsed.values.length > 0) {
    const value = parsed.values[0] as T;
    const hasAdditionalValues = parsed.values.length > 1;
    const raw = hasAdditionalValues
      ? JSON.stringify(value)
      : input.slice(0, parsed.read).trimEnd();
    return {
      kind: 'value',
      value,
      raw,
      discardedSuffix: hasAdditionalValues || !parsed.done || parsed.read < input.length,
    };
  }

  if (!parsed.error && !parsed.done) return { kind: 'incomplete' };
  return {
    kind: 'invalid',
    error: parsed.error ?? new SyntaxError('Invalid JSONL line'),
  };
}
