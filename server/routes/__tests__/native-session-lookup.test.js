import { beforeEach, describe, expect, it, mock } from 'bun:test';

import { resetServerConfigForTests } from '../../config.ts';
import { wrapRoute } from '../../lib/http-route.ts';
import { createNativeSessionLookupRoutes } from '../native-session-lookup.ts';

const CHAT_ID = '1783725900000200';
const OTHER_CHAT_ID = '1783725900000201';
const ROUTE = '/api/v1/chats/lookup-native-session';

const registry = {
  lookupNativeSession: mock(() => ({ status: 'not-found' })),
};
const agents = {
  hasAgent: mock((agentId) => agentId === 'codex' || agentId === 'claude'),
};

function request(body, headers = {}) {
  return new Request(`http://localhost${ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function invoke(body) {
  const handler = createNativeSessionLookupRoutes(registry, agents)[ROUTE].POST;
  const url = new URL(`http://localhost${ROUTE}`);
  const response = await handler(request(body), url);
  return { response, body: await response.json() };
}

describe('POST /api/v1/chats/lookup-native-session', () => {
  beforeEach(() => {
    resetServerConfigForTests();
    registry.lookupNativeSession.mockReset();
    registry.lookupNativeSession.mockReturnValue({ status: 'not-found' });
    agents.hasAgent.mockClear();
  });

  it('returns the unique current binding with an optional agent filter', async () => {
    registry.lookupNativeSession.mockReturnValue({ status: 'found', chatId: CHAT_ID });

    const unfiltered = await invoke({ nativeSessionId: 'session-123' });
    const filtered = await invoke({ nativeSessionId: 'session-123', agent: 'codex' });

    expect(unfiltered.response.status).toBe(200);
    expect(unfiltered.body).toEqual({ chatId: CHAT_ID });
    expect(filtered.response.status).toBe(200);
    expect(filtered.body).toEqual({ chatId: CHAT_ID });
    expect(registry.lookupNativeSession.mock.calls).toEqual([
      ['session-123', undefined],
      ['session-123', 'codex'],
    ]);
  });

  it('returns exact not-found and ambiguity responses without candidate details', async () => {
    const missing = await invoke({ nativeSessionId: 'missing' });
    registry.lookupNativeSession.mockReturnValue({ status: 'ambiguous' });
    const ambiguous = await invoke({ nativeSessionId: 'duplicate' });

    expect(missing.response.status).toBe(404);
    expect(missing.body).toEqual({
      success: false,
      error: 'No chat matches the native session ID',
      errorCode: 'NATIVE_SESSION_NOT_FOUND',
      retryable: false,
    });
    expect(ambiguous.response.status).toBe(409);
    expect(ambiguous.body).toEqual({
      success: false,
      error: 'Multiple chats match the native session ID',
      errorCode: 'NATIVE_SESSION_AMBIGUOUS',
      retryable: false,
    });
  });

  it.each([
    [{}, 'nativeSessionId is required'],
    [{ nativeSessionId: '' }, 'nativeSessionId is required'],
    [{ nativeSessionId: 'x'.repeat(257) }, 'nativeSessionId must be at most 256 bytes'],
    [{ nativeSessionId: 'session\0id' }, 'nativeSessionId must not contain control characters'],
    [{ nativeSessionId: 'session-123', agent: 'Codex' }, 'agent must be a valid agent ID'],
  ])('rejects invalid input %#', async (input, message) => {
    const result = await invoke(input);

    expect(result.response.status).toBe(400);
    expect(result.body).toEqual({
      success: false,
      error: message,
      errorCode: 'VALIDATION_FAILED',
      retryable: false,
    });
    expect(registry.lookupNativeSession).not.toHaveBeenCalled();
  });

  it('rejects syntactically valid unsupported agents before lookup', async () => {
    const result = await invoke({ nativeSessionId: 'session-123', agent: 'cursor' });

    expect(result.response.status).toBe(422);
    expect(result.body).toEqual({
      success: false,
      error: 'Unsupported agent: cursor',
      errorCode: 'UNSUPPORTED_AGENT',
      retryable: false,
    });
    expect(registry.lookupNativeSession).not.toHaveBeenCalled();
  });

  it('uses only the registry supplied for the connected workspace', async () => {
    const firstRegistry = { lookupNativeSession: mock(() => ({ status: 'found', chatId: CHAT_ID })) };
    const secondRegistry = { lookupNativeSession: mock(() => ({ status: 'found', chatId: OTHER_CHAT_ID })) };
    const url = new URL(`http://localhost${ROUTE}`);
    const firstHandler = createNativeSessionLookupRoutes(firstRegistry, agents)[ROUTE].POST;
    const secondHandler = createNativeSessionLookupRoutes(secondRegistry, agents)[ROUTE].POST;

    const first = await firstHandler(request({ nativeSessionId: 'shared' }), url);
    const second = await secondHandler(request({ nativeSessionId: 'shared' }), url);

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ chatId: CHAT_ID });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ chatId: OTHER_CHAT_ID });
    expect(firstRegistry.lookupNativeSession).toHaveBeenCalledTimes(1);
    expect(secondRegistry.lookupNativeSession).toHaveBeenCalledTimes(1);
  });

  it('inherits authenticated route wrapping and rejects missing credentials', async () => {
    const handler = createNativeSessionLookupRoutes(registry, agents)[ROUTE].POST;
    const wrapped = wrapRoute(handler, ROUTE, 'POST');

    const response = await wrapped(request({ nativeSessionId: 'session-123' }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Access denied. No token provided.',
      errorCode: 'VALIDATION_FAILED',
      retryable: false,
    });
    expect(registry.lookupNativeSession).not.toHaveBeenCalled();
  });
});
