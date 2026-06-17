import { describe, expect, it } from 'bun:test';
import { CursorAcpEventConverter } from '../cursor/cursor-acp-event-converter.ts';

const TS = '2026-05-22T00:00:00.000Z';

function context(overrides = {}) {
  return {
    chatId: 'chat-1',
    sessionId: 'session-1',
    timestamp: TS,
    ...overrides,
  };
}

describe('CursorAcpEventConverter', () => {
  it('maps ACP execute tool calls with content-only payloads to bash tool-use', () => {
    const converter = new CursorAcpEventConverter();
    converter.beginTurn('session-1');

    const messages = converter.fromSessionUpdate({
      sessionId: 'remote-session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        kind: 'execute',
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text: 'ls -la /garcon',
            },
          },
        ],
      },
    }, context());

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('bash-tool-use');
    expect(messages[0].toolId).toBe('call-1');
    expect(messages[0].command).toBe('ls -la /garcon');
  });

  it('reuses prior tool-call details for id-only permission requests', () => {
    const converter = new CursorAcpEventConverter();
    converter.beginTurn('session-1');

    converter.fromSessionUpdate({
      sessionId: 'remote-session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-2',
        kind: 'read',
        rawInput: { path: '/garcon/README.md' },
      },
    }, context());

    const requestedTool = converter.permissionToolUse?.(
      { toolCallId: 'call-2' },
      context({ timestamp: '2026-05-22T00:00:01.000Z' }),
    );

    expect(requestedTool).not.toBeNull();
    expect(requestedTool?.type).toBe('read-tool-use');
    expect(requestedTool?.toolId).toBe('call-2');
    expect(requestedTool?.filePath).toBe('/garcon/README.md');
  });

  it('emits tool results when terminal update output arrives via content only', () => {
    const converter = new CursorAcpEventConverter();
    converter.beginTurn('session-1');

    converter.fromSessionUpdate({
      sessionId: 'remote-session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-3',
        kind: 'execute',
        title: 'Run tests',
      },
    }, context());

    const messages = converter.fromSessionUpdate({
      sessionId: 'remote-session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-3',
        status: 'completed',
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text: 'ok',
            },
          },
        ],
      },
    }, context({ timestamp: '2026-05-22T00:00:02.000Z' }));

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('tool-result');
    expect(messages[0].toolId).toBe('call-3');
    expect(messages[0].isError).toBe(false);
  });
});
