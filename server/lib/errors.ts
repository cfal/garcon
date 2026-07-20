export function errorMessage(error: unknown, fallback?: string): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = error.message;
    if (typeof message === 'string') return message;
  }
  return fallback ?? String(error);
}

export function hasNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(
    error
      && typeof error === 'object'
      && 'code' in error
      && (error as { code?: unknown }).code === code,
  );
}
