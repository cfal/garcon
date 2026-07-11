import { describe, it, expect } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { loadCodexChatMessages, loadCodexChatMessagePage } from '../history-loader.js';
import { getNativeMessageSource } from '../../shared/native-message-source.js';

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
	it('loads Exec calls and paired outputs from native history', async () => {
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

	  expect(messages.map((message) => message.type)).toEqual(['exec-tool-use', 'tool-result']);
	  expect(messages[0]).toMatchObject({
	    toolId: 'call_exec',
	    code,
	    language: 'javascript',
	  });
	  expect(messages[1]).toMatchObject({
	    toolId: 'call_exec',
	    content: { raw: 'Script completed' },
	    isError: false,
	  });
	});

	it('loads Wait calls and paired outputs from native history', async () => {
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

	  expect(messages.map((message) => message.type)).toEqual(['wait-tool-use', 'tool-result']);
	  expect(messages[0]).toMatchObject({
	    toolId: 'call_wait',
	    executionId: '46',
	    yieldTimeMs: 30000,
	    maxTokens: 12000,
	  });
	  expect(messages[1]).toMatchObject({
	    toolId: 'call_wait',
	    content: { raw: 'Script completed' },
	    isError: false,
	  });
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
    expect(getNativeMessageSource(messages[0])).toEqual({ lineNumber: 1 });
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
          name: 'exec_command',
          arguments: '{"cmd":"rg --files","workdir":"/project"}',
          call_id: 'call_abc',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: tsOutput,
        payload: {
          type: 'function_call_output',
          call_id: 'call_abc',
          output: 'file1.js\nfile2.js',
        },
      }),
    ];

    const messages = await withTempJsonl(lines, (filePath) => loadCodexChatMessages(filePath));

    expect(messages).toHaveLength(2);
    expect(messages[0].type).toBe('bash-tool-use');
    expect(messages[0].command).toBe('rg --files');
    expect(messages[1].type).toBe('tool-result');
    expect(messages[1].toolId).toBe('call_abc');
  });

  it('loads web_search_call entries as WebSearch tool-use/result', async () => {
    const ts = '2026-02-21T14:00:00.000Z';
    const lines = [
      JSON.stringify({
        type: 'response_item',
        timestamp: ts,
        payload: {
          type: 'web_search_call',
          status: 'completed',
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

  it('loads the initial page from tail canonical entries', async () => {
    const lines = Array.from({ length: 12 }, (_, index) => JSON.stringify({
      type: 'response_item',
      timestamp: `2026-02-21T10:00:${String(index).padStart(2, '0')}.000Z`,
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: `reply ${index}` }],
      },
    }));

    const page = await withTempJsonl(lines, (filePath) => loadCodexChatMessagePage(filePath, 3, 0));

    expect(page).toMatchObject({ hasMore: true, offset: 0, limit: 3 });
    expect(page.messages.map((message) => message.content)).toEqual(['reply 9', 'reply 10', 'reply 11']);
  });

  it('keeps synthetic web search IDs stable between tail pages and full loads', async () => {
    const fillerLines = Array.from({ length: 520 }, (_, index) => JSON.stringify({
      type: 'response_item',
      timestamp: `2026-02-21T16:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: `reply ${index}` }],
      },
    }));
    const webSearchLine = JSON.stringify({
      type: 'response_item',
      timestamp: '2026-02-21T17:00:00.000Z',
      payload: {
        type: 'web_search_call',
        status: 'completed',
        action: {
          type: 'search',
          query: 'Codex duplicate keyed each',
          queries: ['Codex duplicate keyed each'],
        },
      },
    });
    const lines = [...fillerLines, webSearchLine];

    await withTempJsonl(lines, async (filePath) => {
      const fullMessages = await loadCodexChatMessages(filePath);
      const page = await loadCodexChatMessagePage(filePath, 5, 0);
      expect(page).not.toBeNull();
      if (!page) throw new Error('expected tail page');

      const fullWebSearch = fullMessages.find((message) => message.type === 'web-search-tool-use');
      const pageWebSearch = page.messages.find((message) => message.type === 'web-search-tool-use');
      expect(fullWebSearch).toBeTruthy();
      expect(pageWebSearch).toBeTruthy();
      if (!fullWebSearch || !pageWebSearch) throw new Error('expected web search in full and tail loads');

      expect(page.hasMore).toBe(true);
      expect(pageWebSearch.toolId).toBe(fullWebSearch.toolId);
    });
  });

  it('returns null for older tail pages so callers use the full loader', async () => {
    const page = await loadCodexChatMessagePage('/tmp/missing.jsonl', 3, 2);

    expect(page).toBeNull();
  });
});
