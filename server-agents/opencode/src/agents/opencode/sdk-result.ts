export interface OpenCodeRequestScope {
  directory?: string;
}

export function createOpenCodeRequestScope(projectPath: string | null | undefined): OpenCodeRequestScope {
  const directory = typeof projectPath === 'string' ? projectPath.trim() : '';
  return directory ? { directory } : {};
}

export function withOpenCodeRequestScope<T extends Record<string, unknown>>(
  parameters: T,
  scope: OpenCodeRequestScope,
): T & OpenCodeRequestScope {
  return scope.directory ? { ...parameters, directory: scope.directory } : parameters;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function openCodeResultErrorMessage(result: unknown, fallback: string): string {
  const record = asRecord(result);
  const error = asRecord(record.error);
  const data = asRecord(error.data);
  const dataMessage = typeof data.message === 'string' ? data.message.trim() : '';
  const errorMessage = typeof error.message === 'string' ? error.message.trim() : '';
  return dataMessage || errorMessage || fallback;
}

export function hasOpenCodeResultError(result: unknown): boolean {
  return Boolean(asRecord(result).error);
}

export function isOpenCodeNotFoundResult(result: unknown): boolean {
  const record = asRecord(result);
  const error = asRecord(record.error);
  if (error.name === 'NotFoundError') return true;

  const response = asRecord(record.response);
  if (response.status !== 404) return false;

  return openCodeResultErrorMessage(result, '').toLowerCase().includes('not found');
}

export function throwOpenCodeResultError(result: unknown, fallback: string): void {
  if (hasOpenCodeResultError(result)) {
    throw new Error(openCodeResultErrorMessage(result, fallback));
  }
}
