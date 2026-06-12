import { describe, expect, it } from 'bun:test';

import { jsonError, jsonErrorFromUnknown } from '../http-error.ts';

describe('jsonError', () => {
  it('emits the shared HTTP error envelope', async () => {
    const response = jsonError(
      'Rate limited',
      429,
      'RATE_LIMITED',
      true,
      'Retry after the current window.',
    );
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body).toEqual({
      success: false,
      error: 'Rate limited',
      errorCode: 'RATE_LIMITED',
      retryable: true,
      details: 'Retry after the current window.',
    });
  });
});

describe('jsonErrorFromUnknown', () => {
  it('does not expose unexpected 500 error details', async () => {
    const response = jsonErrorFromUnknown(new Error('/secret/path failed'));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe('Internal server error');
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('keeps explicit non-500 validation messages', async () => {
    const response = jsonErrorFromUnknown(new Error('name is required'), 400);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('name is required');
    expect(body.errorCode).toBe('VALIDATION_FAILED');
  });
});
