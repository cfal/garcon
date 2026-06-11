export interface PaginationOptions {
  defaultLimit?: number;
  defaultOffset?: number;
  maxLimit: number;
}

export const CHAT_MESSAGES_MAX_LIMIT = 200;

export interface PaginationParams {
  limit: number;
  offset: number;
}

function finiteInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value.trim())
      : Number.NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.trunc(numeric);
}

function positiveBound(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}

function nonNegativeBound(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

export function parsePagination(limit: unknown, offset: unknown, options: PaginationOptions): PaginationParams {
  const maxLimit = positiveBound(options.maxLimit, 1);
  const defaultLimit = Math.min(positiveBound(options.defaultLimit ?? 20, 20), maxLimit);
  const defaultOffset = nonNegativeBound(options.defaultOffset ?? 0, 0);
  const parsedLimit = finiteInteger(limit, defaultLimit);
  const parsedOffset = finiteInteger(offset, defaultOffset);

  return {
    limit: Math.min(Math.max(parsedLimit, 1), maxLimit),
    offset: Math.max(parsedOffset, 0),
  };
}
