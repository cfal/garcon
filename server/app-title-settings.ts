import {
  APP_TITLE_MAX_LENGTH,
  type AppIdentityUiSettings,
} from '../common/settings.js';

export class AppTitleValidationError extends Error {
  readonly status = 400;
  readonly errorCode: string;

  constructor(message: string, errorCode: string) {
    super(message);
    this.name = 'AppTitleValidationError';
    this.errorCode = errorCode;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function sanitizeAppIdentityPatch(value: unknown): AppIdentityUiSettings | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  if (!('title' in raw)) return {};

  if (typeof raw.title !== 'string') {
    throw new AppTitleValidationError('Title must be text.', 'title_invalid');
  }

  const title = raw.title.trim();
  if (!title) {
    throw new AppTitleValidationError('Title is required.', 'title_required');
  }
  if (title.length > APP_TITLE_MAX_LENGTH) {
    throw new AppTitleValidationError('Title is too long.', 'title_too_long');
  }

  return { title };
}
