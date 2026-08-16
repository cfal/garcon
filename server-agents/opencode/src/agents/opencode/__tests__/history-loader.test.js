import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  AssistantMessage,
  BashToolUseMessage,
  ErrorMessage,
  ThinkingMessage,
  ToolResultMessage,
  UserMessage,
} from '@garcon/common/chat-types';
import {
  getOpenCodePreviewFromSessionId,
  loadLegacyOpenCodeChatMessages,
  loadOpenCodeChatMessages,
  loadRequiredOpenCodeChatMessages,
} from '../history-loader.js';
import { FILE_CONTEXT_SEPARATOR } from '@garcon/server-agent-common/shared/file-mention-context';
import { getNativeMessageRevisionSource } from '@garcon/server-agent-common/shared/native-message-source';
import { convertOpenCodeEventToChatMessages } from '../event-converter.js';

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

  it('carries stable part and message identities identically for stored and live rows', async () => {
    const getClient = mock(() => Promise.resolve({
      session: {
        messages: mock(() => Promise.resolve({
          data: [
            {
              info: { id: 'msg_user', role: 'user', time: { created: '2026-07-04T00:00:00.000Z' } },
              parts: [{ id: 'prt_u1', type: 'text', text: 'prompt' }],
            },
            {
              info: { id: 'msg_a', role: 'assistant', time: { created: '2026-07-04T00:00:01.000Z' } },
              parts: [
                { id: 'prt_think', type: 'reasoning', reasoning: 'why' },
                { id: 'prt_tool', type: 'tool', tool: 'bash', callID: 'tool-1', state: { status: 'completed', input: { command: 'pwd' }, output: 'ok' } },
                { id: 'prt_text', type: 'text', text: 'done' },
              ],
            },
          ],
        })),
      },
    }));
    const stored = await loadOpenCodeChatMessages('session-1', getClient);
    const storedTuples = stored.map((message) => getNativeMessageRevisionSource(message));
    expect(storedTuples).toEqual([
      { entryId: 'msg_user', withinSourceOrdinal: 0 },
      { entryId: 'prt_think', withinSourceOrdinal: 0 },
      { entryId: 'prt_tool', withinSourceOrdinal: 0 },
      { entryId: 'prt_tool', withinSourceOrdinal: 1 },
      { entryId: 'prt_text', withinSourceOrdinal: 0 },
    ]);

    // Live conversion of the same parts yields identical identity tuples in
    // the same order, so audits match without type or content guessing.
    const turn = {
      assistantPartTypes: new Map(),
      messageRoles: new Map(),
      publishedPartIds: new Set(),
    };
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const live = [
      { type: 'message.part.updated', properties: { part: { id: 'prt_think', messageID: 'msg_a', role: 'assistant', type: 'reasoning', text: 'why' } } },
      { type: 'message.part.updated', properties: { part: { id: 'prt_tool', messageID: 'msg_a', role: 'assistant', type: 'tool', tool: 'bash', callID: 'tool-1', state: { status: 'completed', input: { command: 'pwd' }, output: 'ok' } } } },
      { type: 'message.part.updated', properties: { part: { id: 'prt_text', messageID: 'msg_a', role: 'assistant', type: 'text', text: 'done' } } },
    ].flatMap((event) => convertOpenCodeEventToChatMessages(event, turn, logger) ?? []);
    expect(live.map((message) => getNativeMessageRevisionSource(message))).toEqual(
      storedTuples.slice(1),
    );
  });

  it('hides provider-owned compaction messages and an overflow replay', async () => {
    const getClient = mock(() => Promise.resolve({
      session: {
        messages: mock(() => Promise.resolve({
          data: [
            {
              info: { role: 'user', time: { created: '2026-07-04T00:00:00.000Z' } },
              parts: [{ type: 'text', text: 'original prompt' }],
            },
            {
              info: { role: 'assistant', time: { created: '2026-07-04T00:00:01.000Z' } },
              parts: [],
            },
            {
              info: { role: 'user', time: { created: '2026-07-04T00:00:02.000Z' } },
              parts: [{ type: 'compaction', auto: true, overflow: true }],
            },
            {
              info: {
                role: 'assistant',
                summary: true,
                mode: 'compaction',
                time: { created: '2026-07-04T00:00:03.000Z' },
              },
              parts: [{ type: 'text', text: 'internal summary' }],
            },
            {
              info: { role: 'user', time: { created: '2026-07-04T00:00:04.000Z' } },
              parts: [{ type: 'text', text: 'original prompt' }],
            },
            {
              info: { role: 'assistant', time: { created: '2026-07-04T00:00:05.000Z' } },
              parts: [{ type: 'text', text: 'recovered reply' }],
            },
            {
              info: { role: 'user', time: { created: '2026-07-04T00:00:06.000Z' } },
              parts: [{ type: 'text', text: 'original prompt' }],
            },
          ],
        })),
      },
    }));

    const messages = await loadOpenCodeChatMessages('session-1', getClient);

    expect(messages.map((message) => [message.type, message.content])).toEqual([
      ['user-message', 'original prompt'],
      ['assistant-message', 'recovered reply'],
      ['user-message', 'original prompt'],
    ]);
  });

  it('keeps a different prompt when overflow compaction finishes without replaying the original', async () => {
    const getClient = mock(() => Promise.resolve({
      session: {
        messages: mock(() => Promise.resolve({
          data: [
            {
              info: { role: 'user', time: { created: '2026-07-04T00:00:00.000Z' } },
              parts: [{ type: 'text', text: 'original prompt' }],
            },
            {
              info: { role: 'user', time: { created: '2026-07-04T00:00:01.000Z' } },
              parts: [{ type: 'compaction', auto: true, overflow: true }],
            },
            {
              info: {
                role: 'assistant',
                summary: true,
                mode: 'compaction',
                time: { created: '2026-07-04T00:00:02.000Z' },
              },
              parts: [{ type: 'text', text: 'internal summary' }],
            },
            {
              info: { role: 'user', time: { created: '2026-07-04T00:00:03.000Z' } },
              parts: [{ type: 'text', text: 'different follow-up' }],
            },
          ],
        })),
      },
    }));

    const messages = await loadOpenCodeChatMessages('session-1', getClient);

    expect(messages.map((message) => [message.type, message.content])).toEqual([
      ['user-message', 'original prompt'],
      ['user-message', 'different follow-up'],
    ]);
  });

  it('hides synthetic continuation prompts but keeps real text from mixed user messages', async () => {
    const getClient = mock(() => Promise.resolve({
      session: {
        messages: mock(() => Promise.resolve({
          data: [
            {
              info: { role: 'user', time: { created: '2026-07-04T00:00:00.000Z' } },
              parts: [{ type: 'text', text: 'internal continuation', synthetic: true }],
            },
            {
              info: { role: 'user', time: { created: '2026-07-04T00:00:01.000Z' } },
              parts: [
                { type: 'text', text: 'real prompt' },
                { type: 'text', text: 'internal context', synthetic: true },
              ],
            },
          ],
        })),
      },
    }));

    const messages = await loadOpenCodeChatMessages('session-1', getClient);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toBeInstanceOf(UserMessage);
    expect(messages[0].content).toBe('real prompt');
  });

  it('restores provider failures without turning an abort into an error row', async () => {
    const getClient = mock(() => Promise.resolve({
      session: {
        messages: mock(() => Promise.resolve({
          data: [
            {
              info: {
                role: 'assistant',
                error: { name: 'ProviderAuthError', data: { message: 'invalid key' } },
                time: { created: '2026-07-04T00:00:00.000Z' },
              },
              parts: [{ type: 'text', text: 'partial reply' }],
            },
            {
              info: {
                role: 'assistant',
                error: { name: 'MessageAbortedError', data: { message: 'aborted' } },
                time: { created: '2026-07-04T00:00:01.000Z' },
              },
              parts: [{
                type: 'tool',
                tool: 'bash',
                callID: 'interrupted-tool',
                state: {
                  status: 'completed',
                  input: { command: 'sleep 30' },
                  output: '(no output)\n\n<shell_metadata>\nUser aborted the command\n</shell_metadata>',
                },
              }],
            },
          ],
        })),
      },
    }));

    const messages = await loadOpenCodeChatMessages('session-1', getClient);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toBeInstanceOf(AssistantMessage);
    expect(messages[0].content).toBe('partial reply');
    expect(messages[1]).toBeInstanceOf(ErrorMessage);
    expect(messages[1].content).toBe('invalid key');
  });

  it('restores a failed compaction error without exposing its internal summary', async () => {
    const getClient = mock(() => Promise.resolve({
      session: {
        messages: mock(() => Promise.resolve({
          data: [
            {
              info: { role: 'user', time: { created: '2026-07-04T00:00:00.000Z' } },
              parts: [{ type: 'compaction', auto: true, overflow: true }],
            },
            {
              info: {
                role: 'assistant',
                summary: true,
                mode: 'compaction',
                error: { name: 'ContextOverflowError', data: { message: 'cannot compact' } },
                time: { created: '2026-07-04T00:00:01.000Z' },
              },
              parts: [{ type: 'text', text: 'partial internal summary' }],
            },
            {
              info: { role: 'user', time: { created: '2026-07-04T00:00:02.000Z' } },
              parts: [{ type: 'text', text: 'next real prompt' }],
            },
          ],
        })),
      },
    }));

    const messages = await loadOpenCodeChatMessages('session-1', getClient);

    expect(messages.map((message) => [message.type, message.content])).toEqual([
      ['error', 'cannot compact'],
      ['user-message', 'next real prompt'],
    ]);
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

  it('[TLV5-ADOPT.07-OPENCODE-UNIT-01] rejects an invalid stored part and retries the repaired source', async () => {
    let storedMessages = [{
      info: { id: 'message-1', role: 'user' },
      parts: [{}],
    }];
    const get = mock(() => Promise.resolve({ data: { directory: '/tmp' } }));
    const messages = mock(() => Promise.resolve({ data: storedMessages }));
    const getClient = mock(() => Promise.resolve({ session: { get, messages } }));

    await expect(loadLegacyOpenCodeChatMessages('session-1', getClient, {
      directory: '/tmp',
    })).rejects.toThrow();

    storedMessages = [];
    await expect(loadLegacyOpenCodeChatMessages('session-1', getClient, {
      directory: '/tmp',
    })).resolves.toEqual([]);
    expect(get).toHaveBeenCalledTimes(2);
    expect(messages).toHaveBeenCalledTimes(2);
  });

  it('[TLV5-ADOPT.08-OPENCODE-NATIVE-UNIT-01] rejects an invalid selected part and retries the repaired source', async () => {
    let storedMessages = [{
      info: { id: 'message-1', role: 'user' },
      parts: [{}],
    }];
    const get = mock(() => Promise.resolve({ data: { directory: '/tmp' } }));
    const messages = mock(() => Promise.resolve({ data: storedMessages }));
    const getClient = mock(() => Promise.resolve({ session: { get, messages } }));

    await expect(loadRequiredOpenCodeChatMessages('session-1', getClient, {
      directory: '/tmp',
    })).rejects.toThrow();

    storedMessages = [];
    await expect(loadRequiredOpenCodeChatMessages('session-1', getClient, {
      directory: '/tmp',
    })).resolves.toEqual([]);
    expect(get).toHaveBeenCalledTimes(2);
    expect(messages).toHaveBeenCalledTimes(2);
  });

  it('passes directory when loading transcript messages', async () => {
    const messages = mock(() => Promise.resolve({ data: [] }));
    const getClient = mock(() => Promise.resolve({
      session: { messages },
    }));

    await expect(loadOpenCodeChatMessages('session-1', getClient, { directory: '/repo' })).resolves.toEqual([]);

    expect(messages).toHaveBeenCalledWith({ sessionID: 'session-1', directory: '/repo' });
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

  it('keeps compaction internals out of preview metadata', async () => {
    const getClient = mock(() => Promise.resolve({
      session: {
        get: mock(() => Promise.resolve({ data: { title: 'OpenCode title' } })),
        messages: mock(() => Promise.resolve({
          data: [
            {
              info: { role: 'assistant', time: { created: '2026-07-04T00:00:00.000Z' } },
              parts: [{ type: 'text', text: 'visible reply' }],
            },
            {
              info: { role: 'user', time: { created: '2026-07-04T00:00:01.000Z' } },
              parts: [{ type: 'compaction', auto: true }],
            },
            {
              info: {
                role: 'assistant',
                summary: true,
                time: { created: '2026-07-04T00:00:02.000Z' },
              },
              parts: [{ type: 'text', text: 'internal summary' }],
            },
            {
              info: { role: 'user', time: { created: '2026-07-04T00:00:03.000Z' } },
              parts: [{ type: 'text', text: 'internal continuation', synthetic: true }],
            },
          ],
        })),
      },
    }));

    const preview = await getOpenCodePreviewFromSessionId('session-1', getClient);

    expect(preview?.lastMessage).toBe('visible reply');
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
