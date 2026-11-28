export function expectedSegmentId(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}
