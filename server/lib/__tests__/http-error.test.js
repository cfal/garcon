import { describe, expect, it } from 'bun:test';

import { jsonError, jsonErrorFromUnknown } from '../http-error.ts';
import {
  ACTIVE_INPUT_NOT_DELIVERED_MESSAGE,
  ACTIVE_INPUT_OUTCOME_UNKNOWN_MESSAGE,
  ActiveInputDeliveryError,
} from '../domain-error.ts';

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

  it('sanitizes active-input delivery errors while preserving retry safety', async () => {
    const preAcceptCause = new Error('/secret/workspace/chat.jsonl could not be appended');
    const postAcceptCause = new Error('Codex RPC turn/steer rejected internal request 987');
    const preAcceptError = new ActiveInputDeliveryError(preAcceptCause, false);
    const postAcceptError = new ActiveInputDeliveryError(postAcceptCause, true);

    const [preAcceptResponse, postAcceptResponse] = [
      jsonErrorFromUnknown(preAcceptError),
      jsonErrorFromUnknown(postAcceptError),
    ];
    const [preAcceptBody, postAcceptBody] = await Promise.all([
      preAcceptResponse.json(),
      postAcceptResponse.json(),
    ]);

    expect(preAcceptError.cause).toBe(preAcceptCause);
    expect(postAcceptError.cause).toBe(postAcceptCause);
    expect(preAcceptBody).toMatchObject({
      error: ACTIVE_INPUT_NOT_DELIVERED_MESSAGE,
      errorCode: 'ACTIVE_INPUT_NOT_DELIVERED',
      retryable: true,
    });
    expect(postAcceptBody).toMatchObject({
      error: ACTIVE_INPUT_OUTCOME_UNKNOWN_MESSAGE,
      errorCode: 'ACTIVE_INPUT_OUTCOME_UNKNOWN',
      retryable: false,
    });
    expect(JSON.stringify([preAcceptBody, postAcceptBody])).not.toContain('/secret/workspace');
    expect(JSON.stringify([preAcceptBody, postAcceptBody])).not.toContain('turn/steer');
  });
});
