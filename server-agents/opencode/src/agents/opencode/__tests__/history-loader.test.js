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
  OpenCodeTranscriptNotFoundError,
  loadLegacyOpenCodeChatMessages,
  loadOpenCodeChatMessages,
  loadRequiredOpenCodeChatMessages,
} from '../history-loader.js';
import { FILE_CONTEXT_SEPARATOR } from '@garcon/server-agent-common/shared/file-mention-context';
import { getNativeMessageRevisionSource } from '@garcon/server-agent-common/shared/native-message-source';
import { convertOpenCodeEventToChatMessages } from '../event-converter.js';

let originalError;
let originalWarn;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const invalidImportPartCases = [
  ['user text missing', 'user', { type: 'text' }],
  ['user text non-string', 'user', { type: 'text', text: 17 }],
  ['assistant text missing', 'assistant', { type: 'text' }],
  ['assistant text non-string', 'assistant', { type: 'text', text: 17 }],
  ['reasoning payloads missing', 'assistant', { type: 'reasoning' }],
  ['reasoning non-string', 'assistant', { type: 'reasoning', reasoning: false }],
  ['reasoning fallback text non-string', 'assistant', { type: 'reasoning', text: 17 }],
  ['reasoning carriers non-string', 'assistant', { type: 'reasoning', reasoning: false, text: 17 }],
];

function storedImportMessage(id, role, parts) {
  return {
    info: { id, role, time: { created: '2026-08-16T00:00:00.000Z' } },
    parts,
  };
}

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

  it('restores terminal tools from aborted assistants without turning an abort into an error row', async () => {
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

    expect(messages).toHaveLength(4);
    expect(messages[0]).toBeInstanceOf(AssistantMessage);
    expect(messages[0].content).toBe('partial reply');
    expect(messages[1]).toBeInstanceOf(ErrorMessage);
    expect(messages[1].content).toBe('invalid key');
    expect(messages[2]).toBeInstanceOf(BashToolUseMessage);
    expect(messages[2].command).toBe('sleep 30');
    expect(messages[3]).toBeInstanceOf(ToolResultMessage);
    expect(messages[3].toolId).toBe('interrupted-tool');
    expect(JSON.stringify(messages[3].content)).toContain('User aborted the command');
  });

  it('omits pending and running tools from native history', async () => {
    const getClient = mock(() => Promise.resolve({
      session: {
        messages: mock(() => Promise.resolve({
          data: [{
            info: {
              role: 'assistant',
              time: { created: '2026-07-04T00:00:00.000Z' },
            },
            parts: [
              {
                type: 'tool',
                tool: 'bash',
                callID: 'pending-tool',
                state: { status: 'pending', input: { command: 'pending command' } },
              },
              {
                type: 'tool',
                tool: 'bash',
                callID: 'running-tool',
                state: { status: 'running', input: { command: 'running command' } },
              },
              {
                type: 'tool',
                tool: 'bash',
                callID: 'completed-tool',
                state: {
                  status: 'completed',
                  input: { command: 'completed command' },
                  output: 'completed output',
                },
              },
            ],
          }],
        })),
      },
    }));

    const messages = await loadOpenCodeChatMessages('session-1', getClient);

    expect(messages.map((message) => [message.type, message.toolId])).toEqual([
      ['bash-tool-use', 'completed-tool'],
      ['tool-result', 'completed-tool'],
    ]);
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

  it('restores a manual compaction boundary anchored to the successful summary', async () => {
    const getClient = mock(() => Promise.resolve({
      session: {
        messages: mock(() => Promise.resolve({
          data: [
            {
              info: { role: 'user', time: { created: '2026-07-04T00:00:00.000Z' } },
              parts: [{ type: 'text', text: 'before compaction' }],
            },
            {
              info: { id: 'msg_control', role: 'user', time: { created: '2026-07-04T00:00:01.000Z' } },
              parts: [{ type: 'compaction', auto: false }],
            },
            {
              info: {
                id: 'msg_summary',
                role: 'assistant',
                summary: true,
                mode: 'compaction',
                finish: 'stop',
                time: { created: '2026-07-04T00:00:02.000Z', completed: 1751582402000 },
              },
              parts: [{ type: 'text', text: 'internal summary' }],
            },
            {
              info: { role: 'user', time: { created: '2026-07-04T00:00:03.000Z' } },
              parts: [{ type: 'text', text: 'after compaction' }],
            },
          ],
        })),
      },
    }));

    const messages = await loadOpenCodeChatMessages('session-1', getClient);

    expect(messages.map((message) => message.type)).toEqual([
      'user-message',
      'compaction',
      'user-message',
    ]);
    expect(messages[1]).toMatchObject({ trigger: 'manual', summary: '' });
    expect(getNativeMessageRevisionSource(messages[1])).toMatchObject({ entryId: 'msg_summary' });
  });

  it('reloads an aborted manual compaction as no boundary at all', async () => {
    const getClient = mock(() => Promise.resolve({
      session: {
        messages: mock(() => Promise.resolve({
          data: [
            {
              info: { role: 'user', time: { created: '2026-07-04T00:00:00.000Z' } },
              parts: [{ type: 'text', text: 'before compaction' }],
            },
            {
              info: { id: 'msg_control', role: 'user', time: { created: '2026-07-04T00:00:01.000Z' } },
              parts: [{ type: 'compaction', auto: false }],
            },
            {
              info: {
                id: 'msg_summary',
                role: 'assistant',
                summary: true,
                mode: 'compaction',
                error: { name: 'MessageAbortedError' },
                time: { created: '2026-07-04T00:00:02.000Z', completed: 1751582402000 },
              },
              parts: [{ type: 'text', text: 'partial internal summary' }],
            },
            {
              info: { role: 'user', time: { created: '2026-07-04T00:00:03.000Z' } },
              parts: [{ type: 'text', text: 'after abort' }],
            },
          ],
        })),
      },
    }));

    const messages = await loadOpenCodeChatMessages('session-1', getClient);

    expect(messages.map((message) => [message.type, message.content])).toEqual([
      ['user-message', 'before compaction'],
      ['user-message', 'after abort'],
    ]);
  });

  it('reloads an aborted automatic compaction summary as nothing', async () => {
    const getClient = mock(() => Promise.resolve({
      session: {
        messages: mock(() => Promise.resolve({
          data: [
            {
              info: { role: 'user', time: { created: '2026-07-04T00:00:00.000Z' } },
              parts: [{ type: 'text', text: 'before compaction' }],
            },
            {
              info: { role: 'user', time: { created: '2026-07-04T00:00:01.000Z' } },
              parts: [{ type: 'compaction', auto: true }],
            },
            {
              info: {
                role: 'assistant',
                summary: true,
                mode: 'compaction',
                error: { name: 'MessageAbortedError' },
                time: { created: '2026-07-04T00:00:02.000Z', completed: 1751582402000 },
              },
              parts: [],
            },
            {
              info: { role: 'user', time: { created: '2026-07-04T00:00:03.000Z' } },
              parts: [{ type: 'text', text: 'after abort' }],
            },
          ],
        })),
      },
    }));

    const messages = await loadOpenCodeChatMessages('session-1', getClient);

    expect(messages.map((message) => [message.type, message.content])).toEqual([
      ['user-message', 'before compaction'],
      ['user-message', 'after abort'],
    ]);
  });

  it('reloads a finish-error summary without an error object as a provider failure', async () => {
    const getClient = mock(() => Promise.resolve({
      session: {
        messages: mock(() => Promise.resolve({
          data: [
            {
              info: { role: 'user', time: { created: '2026-07-04T00:00:00.000Z' } },
              parts: [{ type: 'compaction', auto: false }],
            },
            {
              info: {
                id: 'msg_summary',
                role: 'assistant',
                summary: true,
                mode: 'compaction',
                finish: 'error',
                time: { created: '2026-07-04T00:00:01.000Z', completed: 1751582401000 },
              },
              parts: [],
            },
          ],
        })),
      },
    }));

    const messages = await loadOpenCodeChatMessages('session-1', getClient);

    expect(messages.map((message) => [message.type, message.content])).toEqual([
      ['error', 'OpenCode session failed'],
    ]);
  });

  it('reloads an incomplete summary as no boundary', async () => {
    const getClient = mock(() => Promise.resolve({
      session: {
        messages: mock(() => Promise.resolve({
          data: [
            {
              info: { role: 'user', time: { created: '2026-07-04T00:00:00.000Z' } },
              parts: [{ type: 'compaction', auto: false }],
            },
            {
              info: {
                id: 'msg_summary',
                role: 'assistant',
                summary: true,
                mode: 'compaction',
                time: { created: '2026-07-04T00:00:01.000Z' },
              },
              parts: [],
            },
          ],
        })),
      },
    }));

    const messages = await loadOpenCodeChatMessages('session-1', getClient);

    expect(messages).toEqual([]);
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

  it('[TLV5-ADOPT.07-OPENCODE-UNIT-01] rejects invalid stored parts and recognized content payloads before retry', async () => {
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

    const outcomes = [];
    for (const [label, role, part] of invalidImportPartCases) {
      storedMessages = [storedImportMessage(`message-${label}`, role, [part])];
      try {
        await loadLegacyOpenCodeChatMessages('session-1', getClient, { directory: '/tmp' });
        outcomes.push([label, 'fulfilled']);
      } catch {
        outcomes.push([label, 'rejected']);
      }
    }

    storedMessages = [
      storedImportMessage('empty-user', 'user', [{ type: 'text', text: '' }]),
      storedImportMessage('empty-assistant', 'assistant', [
        { type: 'text', text: '' },
        { type: 'reasoning', reasoning: '' },
        { type: 'reasoning', text: '' },
        { type: 'reasoning', reasoning: false, text: '' },
        { type: 'reasoning', reasoning: '', text: 17 },
        { type: 'step-start' },
      ]),
    ];
    await expect(loadLegacyOpenCodeChatMessages('session-1', getClient, {
      directory: '/tmp',
    })).resolves.toEqual([]);

    storedMessages = [];
    await expect(loadLegacyOpenCodeChatMessages('session-1', getClient, {
      directory: '/tmp',
    })).resolves.toEqual([]);
    expect(outcomes).toEqual(invalidImportPartCases.map(([label]) => [label, 'rejected']));
    expect(get).toHaveBeenCalledTimes(invalidImportPartCases.length + 3);
    expect(messages).toHaveBeenCalledTimes(invalidImportPartCases.length + 3);
  });

  it('restores submitted images from stored user file parts', async () => {
    const getClient = mock(() => Promise.resolve({
      session: {
        messages: mock(() => Promise.resolve({
          data: [
            {
              info: { id: 'msg_img', role: 'user', time: { created: '2026-08-20T00:00:00.000Z' } },
              parts: [
                { id: 'prt_text', type: 'text', text: 'describe this' },
                {
                  id: 'prt_img',
                  type: 'file',
                  mime: 'image/png',
                  filename: 'screenshot.png',
                  url: 'data:image/png;base64,aGVsbG8=',
                },
                { id: 'prt_doc', type: 'file', mime: 'application/pdf', url: 'data:application/pdf;base64,ZG9j' },
              ],
            },
            {
              info: { id: 'msg_img_only', role: 'user', time: { created: '2026-08-20T00:00:01.000Z' } },
              parts: [{
                id: 'prt_only',
                type: 'file',
                mime: 'image/jpeg',
                url: 'data:image/jpeg;base64,d29ybGQ=',
              }],
            },
          ],
        })),
      },
    }));

    const messages = await loadOpenCodeChatMessages('session-1', getClient);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      type: 'user-message',
      content: 'describe this',
      images: [{ data: 'data:image/png;base64,aGVsbG8=', name: 'screenshot.png', mimeType: 'image/png' }],
    });
    expect(messages[1]).toMatchObject({
      type: 'user-message',
      content: '',
      images: [{ data: 'data:image/jpeg;base64,d29ybGQ=', name: 'image', mimeType: 'image/jpeg' }],
    });
  });

  it('[TLV5-ADOPT.07-OPENCODE-UNIT-02] fails legacy import for a recorded session the provider cannot return', async () => {
    let getResult = { error: { name: 'NotFoundError' } };
    const get = mock(() => Promise.resolve(getResult));
    const messages = mock(() => Promise.resolve({ data: [] }));
    const getClient = mock(() => Promise.resolve({ session: { get, messages } }));

    await expect(loadLegacyOpenCodeChatMessages('session-1', getClient, {
      directory: '/tmp',
    })).rejects.toThrow(OpenCodeTranscriptNotFoundError);

    getResult = { data: { directory: '/tmp/elsewhere' } };
    await expect(loadLegacyOpenCodeChatMessages('session-1', getClient, {
      directory: '/tmp',
    })).rejects.toThrow(OpenCodeTranscriptNotFoundError);

    await expect(loadLegacyOpenCodeChatMessages(null, getClient)).resolves.toEqual([]);
    await expect(loadLegacyOpenCodeChatMessages('', getClient)).resolves.toEqual([]);
    expect(getClient).toHaveBeenCalledTimes(2);
    expect(messages).not.toHaveBeenCalled();
  });

  it('[TLV5-ADOPT.08-OPENCODE-NATIVE-UNIT-01] rejects invalid selected parts and recognized content payloads before retry', async () => {
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

    const outcomes = [];
    for (const [label, role, part] of invalidImportPartCases) {
      storedMessages = [storedImportMessage(`message-${label}`, role, [part])];
      try {
        await loadRequiredOpenCodeChatMessages('session-1', getClient, { directory: '/tmp' });
        outcomes.push([label, 'fulfilled']);
      } catch {
        outcomes.push([label, 'rejected']);
      }
    }

    storedMessages = [
      storedImportMessage('empty-user', 'user', [{ type: 'text', text: '' }]),
      storedImportMessage('empty-assistant', 'assistant', [
        { type: 'text', text: '' },
        { type: 'reasoning', reasoning: '' },
        { type: 'reasoning', text: '' },
        { type: 'reasoning', reasoning: false, text: '' },
        { type: 'reasoning', reasoning: '', text: 17 },
        { type: 'step-start' },
      ]),
    ];
    await expect(loadRequiredOpenCodeChatMessages('session-1', getClient, {
      directory: '/tmp',
    })).resolves.toEqual([]);

    storedMessages = [];
    await expect(loadRequiredOpenCodeChatMessages('session-1', getClient, {
      directory: '/tmp',
    })).resolves.toEqual([]);
    expect(outcomes).toEqual(invalidImportPartCases.map(([label]) => [label, 'rejected']));
    expect(get).toHaveBeenCalledTimes(invalidImportPartCases.length + 3);
    expect(messages).toHaveBeenCalledTimes(invalidImportPartCases.length + 3);
  });

  it('preserves cancellation when the scoped session request rejects', async () => {
    const controller = new AbortController();
    const reason = new Error('fork admission cancelled');
    const pendingGet = deferred();
    const get = mock((_args, options) => pendingGet.promise);
    const messages = mock(() => Promise.resolve({ data: [] }));
    const getClient = mock(() => Promise.resolve({ session: { get, messages } }));
    const outcome = loadRequiredOpenCodeChatMessages('session-1', getClient, {
      directory: '/repo',
      signal: controller.signal,
    });

    await Promise.resolve();
    controller.abort(reason);
    pendingGet.reject(new Error('session transport failed'));

    await expect(outcome).rejects.toBe(reason);
    expect(get).toHaveBeenCalledWith(
      { sessionID: 'session-1', directory: '/repo' },
      { signal: controller.signal },
    );
    expect(messages).not.toHaveBeenCalled();
  });

  it('preserves cancellation when the scoped session request resolves with an error', async () => {
    const controller = new AbortController();
    const reason = new Error('fork admission cancelled');
    const pendingGet = deferred();
    const get = mock(() => pendingGet.promise);
    const messages = mock(() => Promise.resolve({ data: [] }));
    const getClient = mock(() => Promise.resolve({ session: { get, messages } }));
    const outcome = loadRequiredOpenCodeChatMessages('session-1', getClient, {
      directory: '/repo',
      signal: controller.signal,
    });

    await Promise.resolve();
    controller.abort(reason);
    pendingGet.resolve({ error: { message: 'session unavailable' } });

    await expect(outcome).rejects.toBe(reason);
    expect(messages).not.toHaveBeenCalled();
  });

  it('passes directory when loading transcript messages', async () => {
    const messages = mock(() => Promise.resolve({ data: [] }));
    const getClient = mock(() => Promise.resolve({
      session: { messages },
    }));

    await expect(loadOpenCodeChatMessages('session-1', getClient, { directory: '/repo' })).resolves.toEqual([]);

    expect(messages).toHaveBeenCalledWith({ sessionID: 'session-1', directory: '/repo' });
  });

  it('normalizes stored glob and grep results to structured counts', async () => {
    const getClient = mock(() => Promise.resolve({
      session: {
        messages: mock(() => Promise.resolve({
          data: [
            {
              info: { role: 'assistant', time: { created: '2026-07-04T00:00:00.000Z' } },
              parts: [
                {
                  type: 'tool',
                  tool: 'glob',
                  callID: 'tool-glob',
                  state: {
                    status: 'completed',
                    input: { pattern: '**/*.ts' },
                    output: '/repo/src/a.ts\n/repo/src/b.ts',
                    metadata: { count: 2, truncated: false },
                  },
                },
                {
                  type: 'tool',
                  tool: 'grep',
                  callID: 'tool-grep',
                  state: {
                    status: 'completed',
                    input: { pattern: 'updated' },
                    output: [
                      'Found 2 matches',
                      '/repo/src/a.ts:',
                      '  Line 1: updated',
                      '/repo/src/b.ts:',
                      '  Line 4: updated',
                    ].join('\n'),
                    metadata: { matches: 2, truncated: false },
                  },
                },
              ],
            },
          ],
        })),
      },
    }));

    const messages = await loadOpenCodeChatMessages('session-1', getClient);

    const globResult = messages.find(
      (message) => message instanceof ToolResultMessage && message.toolId === 'tool-glob',
    );
    expect(globResult?.content).toEqual({
      filenames: ['/repo/src/a.ts', '/repo/src/b.ts'],
      numFiles: 2,
    });
    const grepResult = messages.find(
      (message) => message instanceof ToolResultMessage && message.toolId === 'tool-grep',
    );
    expect(grepResult?.content).toEqual({
      filenames: ['/repo/src/a.ts', '/repo/src/b.ts'],
      numFiles: 2,
      totalMatches: 2,
    });
  });
});
