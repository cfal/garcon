const values: Record<string, unknown> = { fixture: 'value' };

export function lookup(key: string): unknown {
  return values[key];
}
