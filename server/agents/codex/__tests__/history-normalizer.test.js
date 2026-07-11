import { describe, it, expect } from 'bun:test';
import {
  normalizeCodexJsonlEntry,
  extractTextContent,
  parseApplyPatch,
} from '../history-normalizer.js';
import { BashToolUseMessage, EditToolUseMessage, ExecToolUseMessage, ToolResultMessage, UnknownToolUseMessage, WaitToolUseMessage } from '../../../../common/chat-types.js';

describe('extractTextContent', () => {
  it('returns string content directly', () => {
    expect(extractTextContent('hello')).toBe('hello');
  });

  it('returns empty string for non-string non-array input', () => {
    expect(extractTextContent(null)).toBe('');
    expect(extractTextContent(undefined)).toBe('');
    expect(extractTextContent(42)).toBe('');
  });

  it('extracts text from content arrays with various block types', () => {
    const content = [
      { type: 'output_text', text: 'first' },
      { type: 'input_text', text: 'second' },
      { type: 'text', text: 'third' },
      { type: 'unknown', text: 'ignored' },
    ];
    expect(extractTextContent(content)).toBe('first\nsecond\nthird');
  });

  it('filters out null/undefined text values', () => {
    const content = [
      { type: 'output_text', text: 'kept' },
      { type: 'output_text', text: null },
    ];
    expect(extractTextContent(content)).toBe('kept');
  });
});

describe('parseApplyPatch', () => {
  it('extracts file path and diff lines from an Update File patch', () => {
    const input = [
      '*** Begin Patch',
      '*** Update File: /home/user/test.js',
      '---',
      '-const old = true;',
      '+++',
      '+const updated = true;',
    ].join('\n');

    const result = parseApplyPatch(input);
    expect(result.file_path).toBe('/home/user/test.js');
    expect(result.old_string).toBe('const old = true;');
    expect(result.new_string).toBe('const updated = true;');
  });

  it('extracts file path and content from an Add File patch', () => {
    const input = '*** Begin Patch\n*** Add File: /new.js\n+content';
    const result = parseApplyPatch(input);
    expect(result.file_path).toBe('/new.js');
    expect(result.old_string).toBe('');
    expect(result.new_string).toBe('content');
  });

  it('extracts file path from a Delete File patch', () => {
    const input = '*** Begin Patch\n*** Delete File: /old.js\n*** End Patch\n';
    const result = parseApplyPatch(input);
    expect(result.file_path).toBe('/old.js');
    expect(result.old_string).toBe('');
    expect(result.new_string).toBe('');
  });

  it('returns "unknown" file_path when no supported file header is present', () => {
    const input = '*** Begin Patch\n*** Move to: /new.js\n+content';
    const result = parseApplyPatch(input);
    expect(result.file_path).toBe('unknown');
  });
});

describe('normalizeCodexJsonlEntry', () => {
  const ts = '2026-02-16T13:25:05.981Z';

  describe('skipped entry types', () => {
    it('returns null for session_meta', () => {
      expect(normalizeCodexJsonlEntry({ type: 'session_meta', timestamp: ts })).toBeNull();
    });

    it('returns null for turn_context', () => {
      expect(normalizeCodexJsonlEntry({ type: 'turn_context', timestamp: ts })).toBeNull();
    });

    it('returns null for compacted', () => {
      expect(normalizeCodexJsonlEntry({ type: 'compacted', timestamp: ts })).toBeNull();
    });

    it('returns null for null/undefined input', () => {
      expect(normalizeCodexJsonlEntry(null)).toBeNull();
      expect(normalizeCodexJsonlEntry(undefined)).toBeNull();
    });

    it('surfaces a context_compacted event as a compaction message', () => {
      const result = normalizeCodexJsonlEntry({
        type: 'event_msg',
        timestamp: ts,
        payload: { type: 'context_compacted' },
      });
      expect(result?.canonical).toHaveLength(1);
      expect(result.canonical[0].type).toBe('compaction');
      expect(result.canonical[0].trigger).toBe('manual');
    });

    it('returns null for ghost_snapshot', () => {
      const entry = {
        type: 'response_item',
        timestamp: ts,
        payload: {
          type: 'ghost_snapshot',
          ghost_commit: { id: 'abc123', parent: 'def456' },
        },
      };
      expect(normalizeCodexJsonlEntry(entry)).toBeNull();
    });

    it('returns null for developer messages', () => {
      const entry = {
        type: 'response_item',
        timestamp: ts,
        payload: {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'system prompt' }],
        },
      };
      expect(normalizeCodexJsonlEntry(entry)).toBeNull();
    });
  });

  describe('event_msg skipped operational types', () => {
    for (const payloadType of ['token_count', 'task_started', 'task_complete', 'turn_aborted']) {
      it(`returns null for ${payloadType}`, () => {
        expect(normalizeCodexJsonlEntry({
          type: 'event_msg',
          timestamp: ts,
          payload: { type: payloadType },
        })).toBeNull();
      });
    }
  });

  describe('event_msg user_message', () => {
    it('produces a user-message in canonical bucket', () => {
      const entry = {
        type: 'event_msg',
        timestamp: ts,
        payload: { type: 'user_message', message: 'hello world' },
      };
      const result = normalizeCodexJsonlEntry(entry);
      expect(result.canonical).toEqual([
        { type: 'user-message', timestamp: ts, content: 'hello world' },
      ]);
      expect(result.isCanonicalUser).toBe(true);
      expect(result.fallbackUser).toEqual([]);
      expect(result.fallbackAssistant).toEqual([]);
      expect(result.fallbackThinking).toEqual([]);
    });

    it('skips empty user messages', () => {
      const entry = {
        type: 'event_msg',
        timestamp: ts,
        payload: { type: 'user_message', message: '   ' },
      };
      const result = normalizeCodexJsonlEntry(entry);
      expect(result.canonical).toEqual([]);
    });
  });

  describe('event_msg agent_message (fallback)', () => {
    it('places assistant text in fallbackAssistant bucket', () => {
      const entry = {
        type: 'event_msg',
        timestamp: ts,
        payload: { type: 'agent_message', message: 'assistant reply' },
      };
      const result = normalizeCodexJsonlEntry(entry);
      expect(result.canonical).toEqual([]);
      expect(result.fallbackAssistant).toEqual([
        { type: 'assistant-message', timestamp: ts, content: 'assistant reply' },
      ]);
      expect(result.isCanonicalAssistant).toBe(false);
    });
  });

  describe('event_msg agent_reasoning (fallback)', () => {
    it('places thinking text in fallbackThinking bucket from payload.text', () => {
      const entry = {
        type: 'event_msg',
        timestamp: ts,
        payload: { type: 'agent_reasoning', text: 'thinking about it' },
      };
      const result = normalizeCodexJsonlEntry(entry);
      expect(result.fallbackThinking).toEqual([
        { type: 'thinking', timestamp: ts, content: 'thinking about it' },
      ]);
      expect(result.isCanonicalThinking).toBe(false);
    });

    it('falls back to payload.message when payload.text is absent', () => {
      const entry = {
        type: 'event_msg',
        timestamp: ts,
        payload: { type: 'agent_reasoning', message: 'thinking via message field' },
      };
      const result = normalizeCodexJsonlEntry(entry);
      expect(result.fallbackThinking).toHaveLength(1);
      expect(result.fallbackThinking[0].content).toBe('thinking via message field');
    });
  });

  describe('response_item message role=assistant', () => {
    it('produces canonical assistant-message from content array', () => {
      const entry = {
        type: 'response_item',
        timestamp: ts,
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'I will help you.' }],
          phase: 'commentary',
        },
      };
      const result = normalizeCodexJsonlEntry(entry);
      expect(result.isCanonicalAssistant).toBe(true);
      expect(result.canonical).toEqual([
        { type: 'assistant-message', timestamp: ts, content: 'I will help you.' },
      ]);
    });
  });

  describe('response_item message role=user', () => {
    it('produces fallback user-message', () => {
      const entry = {
        type: 'response_item',
        timestamp: ts,
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'user instruction' }],
        },
      };
      const result = normalizeCodexJsonlEntry(entry);
      expect(result.isCanonicalUser).toBe(false);
      expect(result.canonical).toEqual([]);
      expect(result.fallbackUser).toEqual([
        { type: 'user-message', timestamp: ts, content: 'user instruction' },
      ]);
    });
  });

  describe('response_item reasoning', () => {
    it('produces canonical thinking from summary text', () => {
      const entry = {
        type: 'response_item',
        timestamp: ts,
        payload: {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'Planning approach' }],
          content: null,
          encrypted_content: 'gAAAA...',
        },
      };
      const result = normalizeCodexJsonlEntry(entry);
      expect(result.isCanonicalThinking).toBe(true);
      expect(result.canonical).toEqual([
        { type: 'thinking', timestamp: ts, content: 'Planning approach' },
      ]);
    });

    it('skips encrypted-only reasoning with empty summary', () => {
      const entry = {
        type: 'response_item',
        timestamp: ts,
        payload: {
          type: 'reasoning',
          summary: [],
          content: null,
          encrypted_content: 'gAAAA...',
        },
      };
      const result = normalizeCodexJsonlEntry(entry);
      expect(result.isCanonicalThinking).toBe(false);
      expect(result.canonical).toEqual([]);
    });
  });

  describe('response_item function_call', () => {
    it('maps exec_command to BashToolUseMessage and extracts cmd', () => {
      const entry = {
        type: 'response_item',
        timestamp: ts,
        payload: {
          type: 'function_call',
          name: 'exec_command',
          arguments: '{"cmd":"rg --files","workdir":"/project"}',
          call_id: 'call_abc',
        },
      };
      const result = normalizeCodexJsonlEntry(entry);
      expect(result.canonical).toHaveLength(1);
      const msg = result.canonical[0];
      expect(msg).toBeInstanceOf(BashToolUseMessage);
      expect(msg.type).toBe('bash-tool-use');
      expect(msg.toolId).toBe('call_abc');
      expect(msg.command).toBe('rg --files');
    });

    it('maps shell_command to BashToolUseMessage', () => {
      const entry = {
        type: 'response_item',
        timestamp: ts,
        payload: {
          type: 'function_call',
          name: 'shell_command',
          arguments: '{"command":"ls -la"}',
          call_id: 'call_def',
        },
      };
      const result = normalizeCodexJsonlEntry(entry);
      const msg = result.canonical[0];
      expect(msg).toBeInstanceOf(BashToolUseMessage);
      expect(msg.command).toBe('ls -la');
    });

    it('maps wait to WaitToolUseMessage', () => {
      const entry = {
        type: 'response_item',
        timestamp: ts,
        payload: {
          type: 'function_call',
          name: 'wait',
          arguments: '{"cell_id":"46","yield_time_ms":30000,"max_tokens":12000}',
          call_id: 'call_wait',
        },
      };
      const result = normalizeCodexJsonlEntry(entry);
      const msg = result.canonical[0];
      expect(msg).toBeInstanceOf(WaitToolUseMessage);
      expect(msg).toMatchObject({
        toolId: 'call_wait',
        executionId: '46',
        yieldTimeMs: 30000,
        maxTokens: 12000,
      });
    });

    it('passes through unmapped function names as UnknownToolUseMessage', () => {
      const entry = {
        type: 'response_item',
        timestamp: ts,
        payload: {
          type: 'function_call',
          name: 'some_new_tool',
          arguments: '{"key":"val"}',
          call_id: 'call_xyz',
        },
      };
      const result = normalizeCodexJsonlEntry(entry);
      expect(result.canonical[0]).toBeInstanceOf(UnknownToolUseMessage);
      expect(result.canonical[0].rawName).toBe('some_new_tool');
    });
  });

  describe('response_item function_call_output', () => {
    it('produces tool-result with call_id pairing', () => {
      const entry = {
        type: 'response_item',
        timestamp: ts,
        payload: {
          type: 'function_call_output',
          call_id: 'call_abc',
          output: 'command output here',
        },
      };
      const result = normalizeCodexJsonlEntry(entry);
      expect(result.canonical).toEqual([{
        type: 'tool-result',
        timestamp: ts,
        toolId: 'call_abc',
        content: { raw: 'command output here' },
        isError: false,
      }]);
    });
  });

  describe('response_item custom_tool_call', () => {
	  it('pairs Exec input and output through the shared tool contracts', () => {
	    const code = '// @exec: {"yield_time_ms": 1000}\ntext("ok")';
	    const input = normalizeCodexJsonlEntry({
	      type: 'response_item',
	      timestamp: ts,
	      payload: {
	        type: 'custom_tool_call',
	        name: 'exec',
	        call_id: 'call_exec',
	        input: code,
	      },
	    });
	    const output = normalizeCodexJsonlEntry({
	      type: 'response_item',
	      timestamp: ts,
	      payload: {
	        type: 'custom_tool_call_output',
	        call_id: 'call_exec',
	        output: [{ type: 'input_text', text: 'ok' }],
	      },
	    });

	    expect(input.canonical[0]).toBeInstanceOf(ExecToolUseMessage);
	    expect(input.canonical[0]).toMatchObject({
	      toolId: 'call_exec',
	      code,
	      language: 'javascript',
	    });
	    expect(output.canonical[0]).toBeInstanceOf(ToolResultMessage);
	    expect(output.canonical[0]).toMatchObject({
	      toolId: 'call_exec',
	      content: { items: [{ type: 'input_text', text: 'ok' }] },
	      isError: false,
	    });
	  });

    it('normalizes apply_patch to EditToolUseMessage with parsed diff', () => {
      const patchInput = [
        '*** Begin Patch',
        '*** Update File: /project/file.js',
        '---',
        '-old line',
        '+++',
        '+new line',
      ].join('\n');

      const entry = {
        type: 'response_item',
        timestamp: ts,
        payload: {
          type: 'custom_tool_call',
          name: 'apply_patch',
          input: patchInput,
          call_id: 'call_patch',
          status: 'completed',
        },
      };
      const result = normalizeCodexJsonlEntry(entry);
      const msg = result.canonical[0];
      expect(msg).toBeInstanceOf(EditToolUseMessage);
      expect(msg.filePath).toBe('/project/file.js');
      expect(msg.oldString).toBe('old line');
      expect(msg.newString).toBe('new line');
    });

    it('normalizes Add File apply_patch to EditToolUseMessage with the created path', () => {
      const patchInput = [
        '*** Begin Patch',
        '*** Add File: /project/new-file.js',
        '+export const created = true;',
        '*** End Patch',
      ].join('\n');

      const entry = {
        type: 'response_item',
        timestamp: ts,
        payload: {
          type: 'custom_tool_call',
          name: 'apply_patch',
          input: patchInput,
          call_id: 'call_add_patch',
          status: 'completed',
        },
      };
      const result = normalizeCodexJsonlEntry(entry);
      const msg = result.canonical[0];
      expect(msg).toBeInstanceOf(EditToolUseMessage);
      expect(msg.filePath).toBe('/project/new-file.js');
      expect(msg.oldString).toBe('');
      expect(msg.newString).toBe('export const created = true;');
    });

    it('normalizes Delete File apply_patch to EditToolUseMessage with the deleted path', () => {
      const patchInput = [
        '*** Begin Patch',
        '*** Delete File: /project/removed-file.js',
        '*** End Patch',
      ].join('\n');

      const entry = {
        type: 'response_item',
        timestamp: ts,
        payload: {
          type: 'custom_tool_call',
          name: 'apply_patch',
          input: patchInput,
          call_id: 'call_delete_patch',
          status: 'completed',
        },
      };
      const result = normalizeCodexJsonlEntry(entry);
      const msg = result.canonical[0];
      expect(msg).toBeInstanceOf(EditToolUseMessage);
      expect(msg.filePath).toBe('/project/removed-file.js');
      expect(msg.oldString).toBe('');
      expect(msg.newString).toBe('');
    });

    it('passes through non-apply_patch custom tools as UnknownToolUseMessage', () => {
      const entry = {
        type: 'response_item',
        timestamp: ts,
        payload: {
          type: 'custom_tool_call',
          name: 'my_custom_tool',
          input: 'some input',
          call_id: 'call_custom',
        },
      };
      const result = normalizeCodexJsonlEntry(entry);
      expect(result.canonical[0]).toBeInstanceOf(UnknownToolUseMessage);
      expect(result.canonical[0].rawName).toBe('my_custom_tool');
      expect(result.canonical[0].input).toEqual({ raw: 'some input' });
    });
  });

  describe('response_item custom_tool_call_output', () => {
    it('produces tool-result', () => {
      const entry = {
        type: 'response_item',
        timestamp: ts,
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call_patch',
          output: '{"output":"Success","metadata":{"exit_code":0}}',
        },
      };
      const result = normalizeCodexJsonlEntry(entry);
      expect(result.canonical[0].type).toBe('tool-result');
      expect(result.canonical[0].toolId).toBe('call_patch');
    });
  });

  describe('response_item web_search_call', () => {
    it('produces tool-use WebSearch and synthetic tool-result', () => {
      const entry = {
        type: 'response_item',
        timestamp: ts,
        payload: {
          type: 'web_search_call',
          status: 'completed',
          action: {
            type: 'search',
            query: 'React lazy Suspense issues',
            queries: ['React lazy Suspense issues'],
          },
        },
      };
      const result = normalizeCodexJsonlEntry(entry);
      expect(result.canonical).toHaveLength(2);

      const toolUse = result.canonical[0];
      expect(toolUse.type).toBe('web-search-tool-use');
      expect(toolUse.query).toBe('React lazy Suspense issues');

      const toolResult = result.canonical[1];
      expect(toolResult.type).toBe('tool-result');
      expect(toolResult.content.raw).toContain('React lazy Suspense issues');
      expect(toolResult.isError).toBe(false);
    });

    it('falls back to queries array when query is absent', () => {
      const entry = {
        type: 'response_item',
        timestamp: ts,
        payload: {
          type: 'web_search_call',
          status: 'completed',
          action: { type: 'search', queries: ['q1', 'q2'] },
        },
      };
      const result = normalizeCodexJsonlEntry(entry);
      expect(result.canonical[0].query).toBe('q1');
    });

    it('does not render web search calls without displayable action details', () => {
      const entries = [
        {
          type: 'response_item',
          timestamp: ts,
          payload: {
            type: 'web_search_call',
            status: 'completed',
          },
        },
        {
          type: 'response_item',
          timestamp: ts,
          payload: {
            type: 'web_search_call',
            status: 'completed',
            action: { type: 'other' },
          },
        },
        {
          type: 'response_item',
          timestamp: ts,
          payload: {
            type: 'web_search_call',
            status: 'completed',
            action: { type: 'search', query: '', queries: [] },
          },
        },
      ];

      for (const entry of entries) {
        expect(normalizeCodexJsonlEntry(entry).canonical).toEqual([]);
      }
    });

    it('uses deterministic distinct fallback tool IDs when provider IDs are absent', () => {
      const firstEntry = {
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
      const secondEntry = {
        type: 'response_item',
        timestamp: ts,
        payload: {
          type: 'web_search_call',
          status: 'completed',
          action: {
            type: 'search',
            query: 'Svelte 5 runes best practices',
            queries: ['Svelte 5 runes best practices'],
          },
        },
      };

      const firstResult = normalizeCodexJsonlEntry(firstEntry);
      const repeatedFirstResult = normalizeCodexJsonlEntry(firstEntry);
      const secondResult = normalizeCodexJsonlEntry(secondEntry);
      const firstLineResult = normalizeCodexJsonlEntry(firstEntry, { sourceLineNumber: 10 });
      const secondLineResult = normalizeCodexJsonlEntry(firstEntry, { sourceLineNumber: 11 });
      const firstByteResult = normalizeCodexJsonlEntry(firstEntry, {
        sourceByteOffset: 1000,
        sourceLineNumber: 10,
      });
      const repeatedByteResult = normalizeCodexJsonlEntry(firstEntry, {
        sourceByteOffset: 1000,
        sourceLineNumber: 11,
      });

      expect(firstResult.canonical[0].toolId).toBe(repeatedFirstResult.canonical[0].toolId);
      expect(firstResult.canonical[0].toolId).not.toBe(secondResult.canonical[0].toolId);
      expect(firstLineResult.canonical[0].toolId).not.toBe(secondLineResult.canonical[0].toolId);
      expect(firstByteResult.canonical[0].toolId).toBe(repeatedByteResult.canonical[0].toolId);
      expect(firstResult.canonical[1].toolId).toBe(firstResult.canonical[0].toolId);
      expect(secondResult.canonical[1].toolId).toBe(secondResult.canonical[0].toolId);
      expect(firstLineResult.canonical[1].toolId).toBe(firstLineResult.canonical[0].toolId);
      expect(secondLineResult.canonical[1].toolId).toBe(secondLineResult.canonical[0].toolId);
      expect(firstByteResult.canonical[1].toolId).toBe(firstByteResult.canonical[0].toolId);
    });
  });
});
