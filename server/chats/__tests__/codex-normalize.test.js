import { describe, it, expect } from 'bun:test';
import {
  normalizeCodexJsonlEntry,
  extractTextContent,
  parseApplyPatch,
} from '../../providers/loaders/codex-history-normalizer.js';
import { BashToolUseMessage, EditToolUseMessage, UnknownToolUseMessage } from '../../../common/chat-types.js';

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

  it('returns "unknown" file_path when Update File header is absent', () => {
    const input = '*** Begin Patch\n*** Add File: /new.js\n+content';
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
    for (const payloadType of ['token_count', 'task_started', 'task_complete', 'turn_aborted', 'context_compacted']) {
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
    it('produces canonical user-message', () => {
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
      expect(result.canonical).toEqual([
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
      expect(msg.type).toBe('tool-use');
      expect(msg.rawName).toBe('exec_command');
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
      expect(msg.rawName).toBe('shell_command');
      expect(msg.command).toBe('ls -la');
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
      expect(msg.rawName).toBe('apply_patch');
      expect(msg.filePath).toBe('/project/file.js');
      expect(msg.oldString).toBe('old line');
      expect(msg.newString).toBe('new line');
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
      expect(toolUse.type).toBe('tool-use');
      expect(toolUse.rawName).toBe('web_search_call');
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
      expect(result.canonical[0].query).toBe('q1, q2');
    });
  });
});
