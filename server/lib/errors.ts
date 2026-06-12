export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function hasNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(
    error
      && typeof error === 'object'
      && 'code' in error
      && (error as { code?: unknown }).code === code,
  );
}
