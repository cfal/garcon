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

function structuredErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export function diagnosticErrorCode(error: unknown): string {
  const code = structuredErrorCode(error);
  if (code !== null) return code;
  if (error instanceof Error) return error.name;
  return 'UNKNOWN';
}
