export class AcpRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function dataMessage(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const message = (data as Record<string, unknown>).message;
  return typeof message === 'string' ? message : '';
}

export function isMethodNotFoundError(error: unknown): boolean {
  return error instanceof AcpRpcError && error.code === -32601;
}

export function isInvalidParamsError(error: unknown): boolean {
  return error instanceof AcpRpcError && error.code === -32602;
}

export function isSessionNotFoundError(error: unknown): boolean {
  if (!(error instanceof AcpRpcError)) return false;
  if (error.code === -32601) return true;
  if (error.code !== -32602) return false;
  const message = `${error.message} ${dataMessage(error.data)}`.toLowerCase();
  return message.includes('session') && message.includes('not found');
}

export function isRecoverableLoadFailure(error: unknown): boolean {
  return isMethodNotFoundError(error) || isSessionNotFoundError(error);
}
