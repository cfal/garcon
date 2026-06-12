import { describe, expect, it } from 'bun:test';

import { jsonError } from '../http-error.ts';

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
