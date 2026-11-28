export function isWellFormedFixture(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return ['running', 'reserved', 'stopping', 'reconnecting'].every((field) => {
    const ids = (value as Record<string, unknown>)[field];
    return Array.isArray(ids) && ids.every((id) => typeof id === 'string' && id.isWellFormed());
  });
}
