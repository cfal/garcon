import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  AssistantMessage,
  BashToolUseMessage,
  ThinkingMessage,
  ToolResultMessage,
  UserMessage,
} from '@garcon/common/chat-types';
import {
  getOpenCodePreviewFromSessionId,
  loadOpenCodeChatMessages,
} from '../history-loader.js';
import { FILE_CONTEXT_SEPARATOR } from '@garcon/server-agent-common/shared/file-mention-context';

let originalError;
let originalWarn;

beforeEach(() => {
  originalError = console.error;
  originalWarn = console.warn;
  console.error = mock(() => {});
  console.warn = mock(() => {});
});

afterEach(() => {
  console.error = originalError;
  console.warn = originalWarn;
});

describe('OpenCode history loader', () => {
  it('loads user, assistant, thinking, tool use, and tool result messages', async () => {
    const getClient = mock(() => Promise.resolve({
      session: {
        messages: mock(() => Promise.resolve({
          data: [
            {
              info: { role: 'user', time: { created: '2026-07-04T00:00:00.000Z' } },
              parts: [{
                type: 'text',
                text: `hello${FILE_CONTEXT_SEPARATOR}secret file context`,
              }],
            },
            {
              info: { role: 'assistant', time: { created: '2026-07-04T00:00:01.000Z' } },
              parts: [
                { type: 'reasoning', reasoning: 'thinking' },
                { type: 'text', text: 'world' },
                {
                  type: 'tool',
                  tool: 'bash',
                  callID: 'tool-1',
                  state: {
                    status: 'completed',
                    input: { command: 'pwd' },
                    output: 'ok',
                  },
                },
                {
                  type: 'tool',
                  tool: 'bash',
                  callID: 'tool-2',
                  state: {
                    status: 'error',
                    input: { command: 'false' },
                    error: 'failed',
                  },
                },
              ],
            },
          ],
        })),
      },
    }));

    const messages = await loadOpenCodeChatMessages('session-1', getClient);

    expect(messages[0]).toBeInstanceOf(UserMessage);
    expect(messages[0].content).toBe('hello');
    expect(messages[1]).toBeInstanceOf(ThinkingMessage);
    expect(messages[1].content).toBe('thinking');
    expect(messages[2]).toBeInstanceOf(AssistantMessage);
    expect(messages[2].content).toBe('world');
    expect(messages[3]).toBeInstanceOf(BashToolUseMessage);
    expect(messages[3].toolId).toBe('tool-1');
    expect(messages[4]).toBeInstanceOf(ToolResultMessage);
    expect(messages[4].toolId).toBe('tool-1');
    expect(messages[4].isError).toBe(false);
    expect(messages[5]).toBeInstanceOf(BashToolUseMessage);
    expect(messages[5].toolId).toBe('tool-2');
    expect(messages[6]).toBeInstanceOf(ToolResultMessage);
    expect(messages[6].toolId).toBe('tool-2');
    expect(messages[6].isError).toBe(true);
  });

  it('returns an empty transcript when the session id is missing', async () => {
    const getClient = mock(() => Promise.resolve({
      session: {
        messages: mock(() => Promise.resolve({ data: [] })),
      },
    }));

    await expect(loadOpenCodeChatMessages('', getClient)).resolves.toEqual([]);
    expect(getClient).not.toHaveBeenCalled();
  });

  it('returns an empty transcript on SDK failures', async () => {
    const getClient = mock(() => Promise.resolve({
      session: {
        messages: mock(() => Promise.reject(new Error('SDK failed'))),
      },
    }));

    await expect(loadOpenCodeChatMessages('session-1', getClient)).resolves.toEqual([]);
  });

  it('passes directory when loading transcript messages', async () => {
    const messages = mock(() => Promise.resolve({ data: [] }));
    const getClient = mock(() => Promise.resolve({
      session: { messages },
    }));

    await expect(loadOpenCodeChatMessages('session-1', getClient, { directory: '/repo' })).resolves.toEqual([]);

    expect(messages).toHaveBeenCalledWith({ sessionID: 'session-1', directory: '/repo' });
  });

  it('retries transcript loading without directory for legacy unscoped sessions', async () => {
    const messages = mock((args) => Promise.resolve(
      args.directory
        ? { error: { name: 'NotFoundError', data: { message: 'Session not found: session-1' } } }
        : {
            data: [{
              info: { role: 'user', time: { created: '2026-07-04T00:00:00.000Z' } },
              parts: [{ type: 'text', text: 'legacy' }],
            }],
          },
    ));
    const getClient = mock(() => Promise.resolve({
      session: { messages },
    }));

    const loaded = await loadOpenCodeChatMessages('session-1', getClient, { directory: '/repo' });

    expect(messages.mock.calls.map((call) => call[0])).toEqual([
      { sessionID: 'session-1', directory: '/repo' },
      { sessionID: 'session-1' },
    ]);
    expect(loaded[0]).toBeInstanceOf(UserMessage);
    expect(loaded[0].content).toBe('legacy');
  });

  it('loads preview metadata from session and tail messages', async () => {
    const messages = mock(() => Promise.resolve({
      data: [
        {
          info: { role: 'user', time: { created: '2026-07-04T00:00:00.000Z' } },
          parts: [{ type: 'text', text: 'first' }],
        },
        {
          info: { role: 'assistant', time: { created: '2026-07-04T00:00:01.000Z' } },
          parts: [{ type: 'text', text: 'last assistant' }],
        },
      ],
    }));
    const getClient = mock(() => Promise.resolve({
      session: {
        get: mock(() => Promise.resolve({
          data: {
            title: 'OpenCode title',
            time: {
              created: '2026-07-04T00:00:00.000Z',
              updated: '2026-07-04T00:00:02.000Z',
            },
          },
        })),
        messages,
      },
    }));

    await expect(getOpenCodePreviewFromSessionId('session-1', getClient, { directory: '/repo' })).resolves.toEqual({
      firstMessage: 'OpenCode title',
      lastMessage: 'last assistant',
      createdAt: '2026-07-04T00:00:00.000Z',
      lastActivity: '2026-07-04T00:00:02.000Z',
    });
    expect(messages).toHaveBeenCalledWith({ sessionID: 'session-1', limit: 20, directory: '/repo' });
  });

  it('returns null preview when the session id is missing', async () => {
    const getClient = mock(() => Promise.resolve({
      session: {
        get: mock(() => Promise.resolve({ data: null })),
        messages: mock(() => Promise.resolve({ data: [] })),
      },
    }));

    await expect(getOpenCodePreviewFromSessionId('', getClient)).resolves.toBeNull();
    expect(getClient).not.toHaveBeenCalled();
  });

  it('returns null preview when OpenCode has no session data', async () => {
    const getClient = mock(() => Promise.resolve({
      session: {
        get: mock(() => Promise.resolve({ data: null })),
        messages: mock(() => Promise.resolve({ data: [] })),
      },
    }));

    await expect(getOpenCodePreviewFromSessionId('missing-session', getClient)).resolves.toBeNull();
  });
});
