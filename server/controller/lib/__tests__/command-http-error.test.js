import { expect, test } from 'bun:test';
import { commandHttpError } from '../command-http-error.ts';
import { CommandValidationError } from '../command-validation-error.ts';
import { DomainError } from '../../../common/domain-error.ts';

test('keeps command validation and domain errors in the same HTTP envelope', async () => {
  for (const ErrorType of [CommandValidationError, DomainError]) {
    const response = commandHttpError(new ErrorType('SESSION_BUSY', 'Synthetic conflict', 409, true));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ success: false, error: 'Synthetic conflict', errorCode: 'SESSION_BUSY', retryable: true });
  }
});
