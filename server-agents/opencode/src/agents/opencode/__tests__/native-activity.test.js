import { expect, it, mock } from 'bun:test';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { createOpenCodeNativeActivityProbe } from '../native-activity.ts';

it('uses a bounded OpenCode message read and reports its newest visible creation time', async () => {
  const messages = mock(async (request) => ({
    data: [
      {
        info: {
          id: 'assistant-1',
          role: 'assistant',
          time: { created: '2026-08-12T00:00:01.000Z' },
        },
        parts: [{ type: 'text', text: 'answer' }],
      },
    ],
    request,
  }));
  const client = {
    session: {
      messages,
      get: mock(async () => ({ data: null })),
    },
  };
  const nativeSessions = createPathNativeSessionCodec('opencode');
  const probe = createOpenCodeNativeActivityProbe({
    nativeSessions,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    withClient: (operation) => operation(async () => client),
  });
  const ref = nativeSessions.encode({
    path: '!opencode:session-1',
    agentSessionId: 'session-1',
    modelEndpointId: null,
  });

  await expect(probe.lastActivity(ref, new AbortController().signal)).resolves.toEqual({
    kind: 'ready',
    value: { lastEntryAt: '2026-08-12T00:00:01.000Z' },
  });
  expect(messages).toHaveBeenCalledWith(
    expect.objectContaining({ sessionID: 'session-1', limit: 20 }),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});
