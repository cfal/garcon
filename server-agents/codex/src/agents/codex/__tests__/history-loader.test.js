import { describe, it, expect } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadCodexChatMessages } from '../history-loader.js';
import { getNativeMessageRevisionSource, getNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';

async function withTempJsonl(lines, fn) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-load-test-'));
  const filePath = path.join(tmpDir, 'session.jsonl');
  await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  try {
    return await fn(filePath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

describe('loadCodexChatMessages', () => {
  it('[TLV5-ADOPT.07-CODEX-UNIT-01] rejects incomplete records and recognized content payloads before retry', async () => {
    const invalidEntry = JSON.stringify({
      type: 'response_item',
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: { type: 'message', role: 'assistant' },
    });
    await withTempJsonl([invalidEntry], async (filePath) => {
      await expect(loadCodexChatMessages(filePath, undefined, {
        throwOnError: true,
      })).rejects.toThrow();

      const malformedPartShapes = [
        ['null part', null],
        ['primitive part', 17],
        ['array part', []],
        ['part type missing', {}],
        ['part type empty', { type: '' }],
        ['part type non-string', { type: 17 }],
      ];
      const invalidParts = [
        ...['user', 'developer', 'assistant'].flatMap((role) => malformedPartShapes.map(
          ([label, part]) => [`${role} ${label}`, role, part],
        )),
        ['user input_text missing', 'user', { type: 'input_text' }],
        ['user input_text non-string', 'user', { type: 'input_text', text: 17 }],
        ['developer input_text missing', 'developer', { type: 'input_text' }],
        ['developer input_text non-string', 'developer', { type: 'input_text', text: 17 }],
        ['output_text missing', 'assistant', { type: 'output_text' }],
        ['output_text non-string', 'assistant', { type: 'output_text', text: false }],
        ['text missing', 'assistant', { type: 'text' }],
        ['text non-string', 'assistant', { type: 'text', text: null }],
      ];
      const invalidContents = [
        ...invalidParts.map(([label, role, part]) => [label, role, [part]]),
        [
          'recognized part before malformed part',
          'assistant',
          [{ type: 'output_text', text: 'recognized assistant content' }, {}],
        ],
        [
          'malformed part before recognized part',
          'assistant',
          [{}, { type: 'output_text', text: 'recognized assistant content' }],
        ],
      ];
      const outcomes = [];
      for (const [label, role, content] of invalidContents) {
        await fs.writeFile(filePath, `${JSON.stringify({
          type: 'response_item',
          timestamp: '2026-01-01T00:00:00.000Z',
          payload: { type: 'message', role, content },
        })}\n`, 'utf8');
        try {
          await loadCodexChatMessages(filePath, undefined, { throwOnError: true });
          outcomes.push([label, 'fulfilled']);
        } catch {
          outcomes.push([label, 'rejected']);
        }
      }

      await fs.writeFile(filePath, [
        JSON.stringify({
          type: 'session_meta',
          timestamp: '2026-01-01T00:00:00.000Z',
          payload: { id: 'thread-1' },
        }),
        ...[
          ['user', { type: 'input_text', text: '' }],
          ['user', { type: 'future-housekeeping', payload: { retained: true } }],
          ['developer', { type: 'input_text', text: '' }],
          ['developer', { type: 'future-housekeeping', payload: { retained: true } }],
          ['assistant', { type: 'output_text', text: '' }],
          ['assistant', { type: 'text', text: '' }],
          ['assistant', { type: 'future-housekeeping', payload: { retained: true } }],
        ].map(([role, part], index) => JSON.stringify({
          type: 'response_item',
          timestamp: `2026-01-01T00:00:0${index + 1}.000Z`,
          payload: { type: 'message', role, content: [part] },
        })),
        ...['user', 'developer', 'assistant'].map((role, index) => JSON.stringify({
          type: 'response_item',
          timestamp: `2026-01-01T00:00:1${index}.000Z`,
          payload: { type: 'message', role, content: [] },
        })),
      ].join('\n') + '\n', 'utf8');
      await expect(loadCodexChatMessages(filePath, undefined, {
        throwOnError: true,
      })).resolves.toEqual([]);

      await fs.writeFile(filePath, '', 'utf8');
      await expect(loadCodexChatMessages(filePath, undefined, {
        throwOnError: true,
      })).resolves.toEqual([]);
      expect(outcomes).toEqual(invalidContents.map(([label]) => [label, 'rejected']));
    });
  });

  it('preserves literal entities in a captured Codex CLI user-message envelope', async () => {
    const fixturePath = fileURLToPath(new URL('./fixtures/codex-user-message-entities.jsonl', import.meta.url));
    const content = 'Fixture capture only. Preserve this marker as literal user input in the session transcript: &amp; &lt; &gt; &quot; &#39; <literal>. Reply only: acknowledged';

    const messages = await loadCodexChatMessages(fixturePath);

    expect(messages).toMatchObject([{ type: 'user-message', content }]);
  });

  it('decodes Code Mode Exec envelopes and paired outputs from native history', async () => {
    const code = '// @exec: {"yield_time_ms": 1000}\ntext("ok")';
    const lines = [
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-10T21:34:09.149Z',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_exec',
          input: code,
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-10T21:34:09.150Z',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call_exec',
          output: 'Script completed',
        },
      }),
    ];

    const messages = await withTempJsonl(lines, (filePath) => loadCodexChatMessages(filePath));

    expect(messages).toMatchObject([
      { type: 'exec-tool-use', toolId: 'call_exec', code, language: 'javascript' },
      { type: 'tool-result', toolId: 'call_exec' },
    ]);
  });

  it('projects shell-only Code Mode entries with per-command identity', async () => {
    const lines = [
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-10T21:34:09.149Z',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'outer',
          input: `
            const results = await Promise.all([
              tools.exec_command({cmd: "git status"}),
              tools.exec_command({cmd: "git diff --stat"}),
            ]);
            results.forEach(result => text(result.output));
          `,
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-10T21:34:09.150Z',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'outer',
          output: 'aggregate output',
        },
      }),
    ];

    await withTempJsonl(lines, async (filePath) => {
      const full = await loadCodexChatMessages(filePath);

      expect(full.map((message) => [message.type, message.toolId])).toEqual([
        ['bash-tool-use', 'codex-code-mode:outer:0'],
        ['bash-tool-use', 'codex-code-mode:outer:1'],
        ['tool-result', 'codex-code-mode:outer:1'],
      ]);
      expect(getNativeMessageRevisionSource(full[0])).toMatchObject({
        lineNumber: 1,
        withinSourceOrdinal: 0,
      });
      expect(getNativeMessageRevisionSource(full[1])).toMatchObject({
        lineNumber: 1,
        withinSourceOrdinal: 1,
      });
    });
  });

  it('hides Code Mode Wait envelopes and paired outputs from native history', async () => {
    const lines = [
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-11T00:27:03.417Z',
        payload: {
          type: 'function_call',
          name: 'wait',
          call_id: 'call_wait',
          arguments: '{"cell_id":"46","yield_time_ms":30000,"max_tokens":12000}',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-11T00:27:33.417Z',
        payload: {
          type: 'function_call_output',
          call_id: 'call_wait',
          output: 'Script completed',
        },
      }),
    ];

    const messages = await withTempJsonl(lines, (filePath) => loadCodexChatMessages(filePath));

    expect(messages).toEqual([]);
  });

  it('preserves Code Mode Exec envelopes and their nested commands', async () => {
    const lines = [
      JSON.stringify({
        type: 'response_item', timestamp: '2026-07-10T21:34:09.149Z',
        payload: { type: 'custom_tool_call', name: 'exec', call_id: 'outer', input: 'text("ok")' },
      }),
      JSON.stringify({
        type: 'response_item', timestamp: '2026-07-10T21:34:09.150Z',
        payload: {
          type: 'function_call', name: 'exec_command', call_id: 'inner',
          arguments: '{"cmd":"pwd","workdir":"/project"}',
        },
      }),
      JSON.stringify({
        type: 'response_item', timestamp: '2026-07-10T21:34:09.151Z',
        payload: { type: 'function_call_output', call_id: 'inner', output: '/project' },
      }),
      JSON.stringify({
        type: 'response_item', timestamp: '2026-07-10T21:34:09.152Z',
        payload: { type: 'custom_tool_call_output', call_id: 'outer', output: 'done' },
      }),
    ];

    await withTempJsonl(lines, async (filePath) => {
      const full = await loadCodexChatMessages(filePath);

      expect(full.map((message) => [message.type, message.toolId])).toEqual([
        ['exec-tool-use', 'outer'],
        ['bash-tool-use', 'inner'],
        ['tool-result', 'inner'],
        ['tool-result', 'outer'],
      ]);
    });
  });

  it('does not leak hidden call state between transcript loads', async () => {
    const hiddenCall = JSON.stringify({
      type: 'response_item', timestamp: '2026-07-10T21:34:09.149Z',
      payload: {
        type: 'function_call', name: 'wait', call_id: 'shared',
        arguments: '{"cell_id":"46","yield_time_ms":30000}',
      },
    });
    const visibleOutput = JSON.stringify({
      type: 'response_item', timestamp: '2026-07-10T21:34:09.150Z',
      payload: { type: 'function_call_output', call_id: 'shared', output: 'unmatched output' },
    });

    await withTempJsonl([hiddenCall], (filePath) => loadCodexChatMessages(filePath));
    const messages = await withTempJsonl([visibleOutput], (filePath) => loadCodexChatMessages(filePath));

    expect(messages.map((message) => message.type)).toEqual(['tool-result']);
  });

  it('loads only the first value from a concatenated physical line', async () => {
    const first = {
      type: 'event_msg',
      timestamp: '2026-02-21T09:00:00.000Z',
      payload: { type: 'user_message', message: 'recovered prompt' },
    };
    const discarded = {
      type: 'response_item',
      timestamp: '2026-02-21T09:00:01.000Z',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'discarded reply' }],
      },
    };
    const later = {
      type: 'response_item',
      timestamp: '2026-02-21T09:00:02.000Z',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'later reply' }],
      },
    };

    const messages = await withTempJsonl([
      `${JSON.stringify(first)}${JSON.stringify(discarded)}`,
      JSON.stringify(later),
    ], (filePath) => loadCodexChatMessages(filePath));

    expect(messages.map((message) => message.content)).toEqual(['recovered prompt', 'later reply']);
    expect(getNativeMessageSource(messages[0])).toEqual({ byteOffset: 0, lineNumber: 1 });
  });

  it('loads legacy user-message client ids as imported submission identity', async () => {
    const messages = await withTempJsonl([
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-02-21T09:00:00.000Z',
        payload: {
          type: 'user_message',
          message: 'steered prompt',
          client_id: 'message-steer-legacy',
        },
      }),
    ], (filePath) => loadCodexChatMessages(filePath));

    expect(messages).toEqual([{
      type: 'user-message',
      timestamp: '2026-02-21T09:00:00.000Z',
      content: 'steered prompt',
      images: undefined,
      metadata: { upstreamRequestId: 'message-steer-legacy' },
    }]);
  });

  it('preserves Codex turn and item identity on legacy response messages', async () => {
    const messages = await withTempJsonl([
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-02-21T09:00:01.000Z',
        payload: {
          type: 'message',
          id: 'message-1',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'persisted reply' }],
          internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
        },
      }),
    ], (filePath) => loadCodexChatMessages(filePath));

    expect(messages).toHaveLength(1);
    expect(getNativeMessageRevisionSource(messages[0])).toEqual({
      entryId: 'turn:turn-1:item:message-1',
      byteOffset: 0,
      lineNumber: 1,
      withinSourceOrdinal: 0,
    });
  });

  it('prefers response_item assistant content over duplicate event_msg wrappers', async () => {
    const tsUser = '2026-02-21T10:00:00.000Z';
    const tsAssistant = '2026-02-21T10:00:01.000Z';
    const tsThinking = '2026-02-21T10:00:02.000Z';
    const lines = [
      JSON.stringify({
        type: 'event_msg',
        timestamp: tsUser,
        payload: { type: 'user_message', message: 'hello' },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: tsAssistant,
        payload: { type: 'agent_message', message: 'assistant reply' },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: tsAssistant,
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'assistant reply' }],
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: tsThinking,
        payload: { type: 'agent_reasoning', message: 'thinking reply' },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: tsThinking,
        payload: {
          type: 'reasoning',
          summary: [{ text: 'thinking reply' }],
        },
      }),
    ];

    const messages = await withTempJsonl(lines, (filePath) => loadCodexChatMessages(filePath));

    expect(messages).toEqual([
      { type: 'user-message', timestamp: tsUser, content: 'hello' },
      { type: 'assistant-message', timestamp: tsAssistant, content: 'assistant reply' },
      { type: 'thinking', timestamp: tsThinking, content: 'thinking reply' },
    ]);
  });

  it('falls back to event_msg assistant content when response_item entries are missing', async () => {
    const tsAssistant = '2026-02-21T11:00:01.000Z';
    const tsThinking = '2026-02-21T11:00:02.000Z';
    const lines = [
      JSON.stringify({
        type: 'event_msg',
        timestamp: tsAssistant,
        payload: { type: 'agent_message', message: 'jsonl assistant reply' },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: tsThinking,
        payload: { type: 'agent_reasoning', message: 'jsonl thinking reply' },
      }),
    ];

    const messages = await withTempJsonl(lines, (filePath) => loadCodexChatMessages(filePath));

    expect(messages).toEqual([
      { type: 'assistant-message', timestamp: tsAssistant, content: 'jsonl assistant reply' },
      { type: 'thinking', timestamp: tsThinking, content: 'jsonl thinking reply' },
    ]);
  });

  it('prefers event_msg user content over duplicate response_item user wrappers', async () => {
    const ts = '2026-02-21T11:30:00.000Z';
    const lines = [
      JSON.stringify({
        type: 'response_item',
        timestamp: ts,
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '# AGENTS.md instructions for /garcon\n\n<INSTRUCTIONS>...' }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: ts,
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/garcon</cwd>\n</environment_context>' }],
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: ts,
        payload: { type: 'user_message', message: 'actual user prompt' },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: ts,
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'actual user prompt' }],
        },
      }),
    ];

    const messages = await withTempJsonl(lines, (filePath) => loadCodexChatMessages(filePath));

    expect(messages).toEqual([
      { type: 'user-message', timestamp: ts, content: 'actual user prompt' },
    ]);
  });

  it('falls back to response_item user content when event_msg user entries are missing', async () => {
    const ts = '2026-02-21T11:35:00.000Z';
    const lines = [
      JSON.stringify({
        type: 'response_item',
        timestamp: ts,
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'user prompt from response item' }],
        },
      }),
    ];

    const messages = await withTempJsonl(lines, (filePath) => loadCodexChatMessages(filePath));

    expect(messages).toEqual([
      { type: 'user-message', timestamp: ts, content: 'user prompt from response item' },
    ]);
  });

  it('per-content-class dedup: canonical assistant suppresses fallback assistant but keeps fallback thinking', async () => {
    const ts1 = '2026-02-21T12:00:00.000Z';
    const ts2 = '2026-02-21T12:00:01.000Z';
    const lines = [
      // Canonical assistant (response_item)
      JSON.stringify({
        type: 'response_item',
        timestamp: ts1,
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'canonical assistant' }],
        },
      }),
      // Fallback assistant (event_msg) -- should be suppressed
      JSON.stringify({
        type: 'event_msg',
        timestamp: ts1,
        payload: { type: 'agent_message', message: 'duplicate assistant' },
      }),
      // Fallback thinking (event_msg) -- should survive since no canonical thinking
      JSON.stringify({
        type: 'event_msg',
        timestamp: ts2,
        payload: { type: 'agent_reasoning', message: 'thinking without canonical' },
      }),
    ];

    const messages = await withTempJsonl(lines, (filePath) => loadCodexChatMessages(filePath));

    expect(messages).toEqual([
      { type: 'assistant-message', timestamp: ts1, content: 'canonical assistant' },
      { type: 'thinking', timestamp: ts2, content: 'thinking without canonical' },
    ]);
  });

  it('loads function_call entries with exec_command mapping', async () => {
    const ts = '2026-02-21T13:00:00.000Z';
    const tsOutput = '2026-02-21T13:00:01.000Z';
    const lines = [
      JSON.stringify({
        type: 'response_item',
        timestamp: ts,
        payload: {
          type: 'function_call',
          id: 'fc-generated-id',
          name: 'exec_command',
          arguments: '{"cmd":"rg --files","workdir":"/project"}',
          call_id: 'call_abc',
          internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: tsOutput,
        payload: {
          type: 'function_call_output',
          id: 'fco-generated-id',
          call_id: 'call_abc',
          output: 'file1.js\nfile2.js',
          internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
        },
      }),
    ];

    const messages = await withTempJsonl(lines, (filePath) => loadCodexChatMessages(filePath));

    expect(messages).toHaveLength(2);
    expect(messages[0].type).toBe('bash-tool-use');
    expect(messages[0].command).toBe('rg --files');
    expect(messages[1].type).toBe('tool-result');
    expect(messages[1].toolId).toBe('call_abc');
    expect(messages.map(getNativeMessageRevisionSource)).toEqual([
      {
        entryId: 'turn:turn-1:tool:call_abc',
        byteOffset: 0,
        lineNumber: 1,
        withinSourceOrdinal: 0,
      },
      {
        entryId: 'turn:turn-1:tool:call_abc',
        byteOffset: expect.any(Number),
        lineNumber: 2,
        withinSourceOrdinal: 1,
      },
    ]);
  });

  it('loads web_search_call entries as WebSearch tool-use/result', async () => {
    const ts = '2026-02-21T14:00:00.000Z';
    const lines = [
      JSON.stringify({
        type: 'response_item',
        timestamp: ts,
        payload: {
          type: 'web_search_call',
          id: 'web-search-1',
          status: 'completed',
          internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
          action: {
            type: 'search',
            query: 'React performance tips',
            queries: ['React performance tips'],
          },
        },
      }),
    ];

    const messages = await withTempJsonl(lines, (filePath) => loadCodexChatMessages(filePath));

    expect(messages).toHaveLength(2);
    expect(messages[0].type).toBe('web-search-tool-use');
    expect(messages[1].type).toBe('tool-result');
    expect(messages.map(getNativeMessageRevisionSource)).toEqual([
      {
        entryId: 'turn:turn-1:tool:web-search-1',
        byteOffset: 0,
        lineNumber: 1,
        withinSourceOrdinal: 0,
      },
      {
        entryId: 'turn:turn-1:tool:web-search-1',
        byteOffset: 0,
        lineNumber: 1,
        withinSourceOrdinal: 1,
      },
    ]);
  });

  it('assigns unique fallback IDs to repeated web_search_call entries without provider IDs', async () => {
    const ts = '2026-02-21T14:10:00.000Z';
    const webSearchEntry = {
      type: 'response_item',
      timestamp: ts,
      payload: {
        type: 'web_search_call',
        status: 'completed',
        action: {
          type: 'search',
          query: 'Svelte keyed each duplicate',
          queries: ['Svelte keyed each duplicate'],
        },
      },
    };
    const lines = [
      JSON.stringify(webSearchEntry),
      JSON.stringify(webSearchEntry),
    ];

    const messages = await withTempJsonl(lines, (filePath) => loadCodexChatMessages(filePath));

    expect(messages).toHaveLength(4);
    expect(messages.map((message) => message.type)).toEqual([
      'web-search-tool-use',
      'tool-result',
      'web-search-tool-use',
      'tool-result',
    ]);
    expect(messages[0].toolId).not.toBe(messages[2].toolId);
    expect(messages[1].toolId).toBe(messages[0].toolId);
    expect(messages[3].toolId).toBe(messages[2].toolId);
  });

  it('skips ghost_snapshot, developer messages, and operational events', async () => {
    const ts = '2026-02-21T15:00:00.000Z';
    const lines = [
      JSON.stringify({ type: 'session_meta', timestamp: ts }),
      JSON.stringify({ type: 'turn_context', timestamp: ts }),
      JSON.stringify({
        type: 'response_item', timestamp: ts,
        payload: { type: 'ghost_snapshot', ghost_commit: { id: 'abc' } },
      }),
      JSON.stringify({
        type: 'response_item', timestamp: ts,
        payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'system' }] },
      }),
      JSON.stringify({
        type: 'event_msg', timestamp: ts,
        payload: { type: 'task_started', turn_id: 't1' },
      }),
      JSON.stringify({
        type: 'event_msg', timestamp: ts,
        payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 500 } } },
      }),
    ];

    const messages = await withTempJsonl(lines, (filePath) => loadCodexChatMessages(filePath));
    expect(messages).toEqual([]);
  });

  it('handles mixed multi-type sessions end-to-end', async () => {
    const lines = [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-02-21T10:00:00.000Z' }),
      JSON.stringify({
        type: 'event_msg', timestamp: '2026-02-21T10:00:01.000Z',
        payload: { type: 'user_message', message: 'fix the bug' },
      }),
      JSON.stringify({
        type: 'response_item', timestamp: '2026-02-21T10:00:02.000Z',
        payload: { type: 'reasoning', summary: [{ text: 'analyzing the issue' }] },
      }),
      JSON.stringify({
        type: 'response_item', timestamp: '2026-02-21T10:00:03.000Z',
        payload: {
          type: 'message', role: 'assistant',
          content: [{ type: 'output_text', text: 'I found the bug' }],
        },
      }),
      JSON.stringify({
        type: 'response_item', timestamp: '2026-02-21T10:00:04.000Z',
        payload: {
          type: 'function_call', name: 'shell_command',
          arguments: '{"command":"cat file.js"}', call_id: 'c1',
        },
      }),
      JSON.stringify({
        type: 'response_item', timestamp: '2026-02-21T10:00:05.000Z',
        payload: { type: 'function_call_output', call_id: 'c1', output: 'file contents' },
      }),
      JSON.stringify({
        type: 'response_item', timestamp: '2026-02-21T10:00:06.000Z',
        payload: {
          type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2',
          input: '*** Begin Patch\n*** Update File: /project/file.js\n-buggy\n+fixed',
        },
      }),
      JSON.stringify({
        type: 'response_item', timestamp: '2026-02-21T10:00:07.000Z',
        payload: { type: 'custom_tool_call_output', call_id: 'c2', output: '{"output":"Success"}' },
      }),
    ];

    const messages = await withTempJsonl(lines, (filePath) => loadCodexChatMessages(filePath));

    expect(messages).toHaveLength(7);
    expect(messages.map(m => m.type)).toEqual([
      'user-message', 'thinking', 'assistant-message',
      'bash-tool-use', 'tool-result',
      'edit-tool-use', 'tool-result',
    ]);
  });

  it('returns empty array for null path', async () => {
    const result = await loadCodexChatMessages(null);
    expect(result).toEqual([]);
  });

  it('uses deterministic source timestamps when native timestamps are missing or non-string', async () => {
    const lines = [undefined, 123].map((timestamp, index) => JSON.stringify({
      type: 'response_item',
      ...(timestamp === undefined ? {} : { timestamp }),
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: `reply ${index}` }],
      },
    }));

    await withTempJsonl(lines, async (filePath) => {
      const first = await loadCodexChatMessages(filePath);
      const second = await loadCodexChatMessages(filePath);

      expect(second).toEqual(first);
      expect(first.map((message) => message.timestamp)).toEqual([
        '2000-01-01T00:00:00.001Z',
        '2000-01-01T00:00:00.002Z',
      ]);
    });
  });
it('keeps rollout order when message timestamps move backward', async () => {
    const lines = ['first', 'second', 'third'].map((label, index) => JSON.stringify({
      type: 'response_item',
      // Codex stamps a turn's rows from separate clocks, so a later row can carry
      // an earlier timestamp than the row it follows in the file.
      timestamp: `2026-07-10T21:34:0${3 - index}.000Z`,
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: label }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
        id: `item-${index}`,
      },
    }));

    const messages = await withTempJsonl(lines, (filePath) => loadCodexChatMessages(filePath));

    expect(messages.map((message) => message.content)).toEqual(['first', 'second', 'third']);
  });
});
