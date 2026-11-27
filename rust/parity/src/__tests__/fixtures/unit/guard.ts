// A guard that lives in another file than the module recorded.
export function isTagOfAtMostEight(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 8;
}
