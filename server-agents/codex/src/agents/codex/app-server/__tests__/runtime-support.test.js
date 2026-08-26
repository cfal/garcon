import { describe, expect, it } from 'bun:test';
import { humanizeCodexAppServerError } from '../runtime-support.ts';

describe('Codex app-server error messages', () => {
  it('explains how to recover from an invalid Responses continuation', () => {
    expect(humanizeCodexAppServerError(
      new Error('API error 400: Invalid `previous_response_id`.'),
    )).toBe(
      'Codex conversation state expired or belongs to a different API endpoint. Start a new chat or switch back to the endpoint used to start this chat.',
    );
  });
});
