import { describe, expect, it } from 'bun:test';

import {
  NATIVE_SESSION_ID_MAX_BYTES,
  NativeSessionLookupValidationError,
  parseNativeSessionId,
  parseNativeSessionLookupRequest,
  parseNativeSessionLookupResponse,
} from '../native-session-lookup.ts';

const CHAT_ID = '1783725900000200';

describe('native session lookup contract', () => {
  it('preserves exact opaque native session IDs and accepts non-UUID formats', () => {
    expect(parseNativeSessionLookupRequest({
      nativeSessionId: ' ses_session-123 ',
      agent: 'codex',
    })).toEqual({
      nativeSessionId: ' ses_session-123 ',
      agent: 'codex',
    });
  });

  it.each([
    [undefined, 'nativeSessionId is required'],
    ['', 'nativeSessionId is required'],
    ['   ', 'nativeSessionId is required'],
    ['session\0id', 'nativeSessionId must not contain control characters'],
    ['session\nid', 'nativeSessionId must not contain control characters'],
    ['session\u2028id', 'nativeSessionId must not contain control characters'],
    ['x'.repeat(NATIVE_SESSION_ID_MAX_BYTES + 1), `nativeSessionId must be at most ${NATIVE_SESSION_ID_MAX_BYTES} bytes`],
  ])('rejects invalid native session ID %p', (value, message) => {
    expect(() => parseNativeSessionId(value)).toThrow(message);
  });

  it('bounds native session IDs by UTF-8 byte length', () => {
    expect(parseNativeSessionId('é'.repeat(NATIVE_SESSION_ID_MAX_BYTES / 2)))
      .toHaveLength(NATIVE_SESSION_ID_MAX_BYTES / 2);
    expect(() => parseNativeSessionId('é'.repeat(NATIVE_SESSION_ID_MAX_BYTES / 2 + 1)))
      .toThrow(`nativeSessionId must be at most ${NATIVE_SESSION_ID_MAX_BYTES} bytes`);
  });

  it.each([[null], [[]], ['session-123'], [1]])('rejects non-object request body %p', (value) => {
    expect(() => parseNativeSessionLookupRequest(value)).toThrow(
      new NativeSessionLookupValidationError('request body must be an object'),
    );
  });

  it('distinguishes an omitted agent from invalid explicit values', () => {
    expect(parseNativeSessionLookupRequest({ nativeSessionId: 'session-123' })).toEqual({
      nativeSessionId: 'session-123',
    });
    for (const agent of [null, '', 'Codex', 'a', 'agent.dot']) {
      expect(() => parseNativeSessionLookupRequest({ nativeSessionId: 'session-123', agent }))
        .toThrow('agent must be a valid agent ID');
    }
  });

  it('parses only responses with a valid Garcon chat ID', () => {
    expect(parseNativeSessionLookupResponse({ chatId: CHAT_ID })).toEqual({ chatId: CHAT_ID });
    for (const value of [null, [], {}, { chatId: '123' }, { chatId: 1783725900000200 }]) {
      expect(() => parseNativeSessionLookupResponse(value)).toThrow();
    }
  });
});
