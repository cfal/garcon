import { jsonError, jsonErrorFromUnknown } from '../../common/http-error.js';
import { CommandValidationError } from './command-validation-error.js';

export function commandHttpError(error: unknown): Response {
  if (error instanceof CommandValidationError) {
    return jsonError(error.message, error.status, error.code, error.retryable);
  }
  return jsonErrorFromUnknown(error);
}
