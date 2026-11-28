// A module with typed arguments and the original's own guards for them, for
// the recorder's `--guard`.

// Written out rather than calling `isTag`, so that a call to `tagOf` does not
// make the recorder capture a call to `isTag` as well.
export function tagOf(value: unknown, otherwise: unknown = '-'): unknown {
  return typeof value === 'string' && value.length <= 8 ? `<${value}>` : otherwise;
}

export function isTag(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 8;
}

// A guard that throws for a value of another type rejects it too.
export function isShortTag(value: unknown): value is string {
  return (value as string).trim().length <= 8;
}

export function total(parts: { first: number; second?: number }): number {
  return parts.first + (parts.second ?? 0);
}

export function triple(count: number): number {
  return count * 3;
}
