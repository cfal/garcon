import { describe, it, expect } from 'bun:test';
import { convertClaudeToolUse } from '../converters/claude-tool-use.js';
import {
  BashToolUseMessage,
  ReadToolUseMessage,
  EditToolUseMessage,
  WriteToolUseMessage,
  ApplyPatchToolUseMessage,
  GrepToolUseMessage,
  GlobToolUseMessage,
  WebSearchToolUseMessage,
  WebFetchToolUseMessage,
  TodoWriteToolUseMessage,
  TodoReadToolUseMessage,
  TaskToolUseMessage,
  UpdatePlanToolUseMessage,
  WriteStdinToolUseMessage,
  EnterPlanModeToolUseMessage,
  ExitPlanModeToolUseMessage,
  UnknownToolUseMessage,
} from '../../../common/chat-types.js';

const TS = '2026-03-01T00:00:00.000Z';

describe('convertClaudeToolUse', () => {
  describe('Bash', () => {
    it('maps Bash with command', () => {
      const msg = convertClaudeToolUse(TS, { id: 't1', name: 'Bash', input: { command: 'ls -la' } });
      expect(msg).toBeInstanceOf(BashToolUseMessage);
      expect(msg.command).toBe('ls -la');
      expect(msg.toolId).toBe('t1');
    });

    it('includes description when present', () => {
      const msg = convertClaudeToolUse(TS, { id: 't1', name: 'Bash', input: { command: 'ls', description: 'List files' } });
      expect(msg.description).toBe('List files');
    });

    it('falls back to Unknown when command is missing', () => {
      const msg = convertClaudeToolUse(TS, { id: 't1', name: 'Bash', input: { description: 'no cmd' } });
      expect(msg).toBeInstanceOf(UnknownToolUseMessage);
      expect(msg.rawName).toBe('Bash');
    });
  });

  describe('Read', () => {
    it('maps Read with file_path', () => {
      const msg = convertClaudeToolUse(TS, { id: 't2', name: 'Read', input: { file_path: '/tmp/test.ts' } });
      expect(msg).toBeInstanceOf(ReadToolUseMessage);
      expect(msg.filePath).toBe('/tmp/test.ts');
    });

    it('accepts filePath alias', () => {
      const msg = convertClaudeToolUse(TS, { id: 't2', name: 'read', input: { filePath: '/x.ts' } });
      expect(msg).toBeInstanceOf(ReadToolUseMessage);
      expect(msg.filePath).toBe('/x.ts');
    });

    it('parses numeric fields from strings', () => {
      const msg = convertClaudeToolUse(TS, { id: 't2', name: 'Read', input: { file_path: '/x.ts', offset: '10', limit: '50' } });
      expect(msg.offset).toBe(10);
      expect(msg.limit).toBe(50);
    });

    it('falls back to Unknown when file_path is missing', () => {
      const msg = convertClaudeToolUse(TS, { id: 't2', name: 'Read', input: { offset: 10 } });
      expect(msg).toBeInstanceOf(UnknownToolUseMessage);
    });
  });

  describe('Edit', () => {
    it('maps Edit with diff fields', () => {
      const msg = convertClaudeToolUse(TS, { id: 't3', name: 'Edit', input: { file_path: '/f.ts', old_string: 'a', new_string: 'b' } });
      expect(msg).toBeInstanceOf(EditToolUseMessage);
      expect(msg.filePath).toBe('/f.ts');
      expect(msg.oldString).toBe('a');
      expect(msg.newString).toBe('b');
    });

    it('accepts all-optional fields', () => {
      const msg = convertClaudeToolUse(TS, { id: 't3', name: 'Edit', input: {} });
      expect(msg).toBeInstanceOf(EditToolUseMessage);
    });

    it('preserves changes array', () => {
      const changes = [{ path: '/a.ts', kind: 'update' }];
      const msg = convertClaudeToolUse(TS, { id: 't3', name: 'Edit', input: { changes } });
      expect(msg.changes).toEqual(changes);
    });
  });

  describe('Write', () => {
    it('maps Write with file_path', () => {
      const msg = convertClaudeToolUse(TS, { id: 't4', name: 'Write', input: { file_path: '/out.ts', content: 'data' } });
      expect(msg).toBeInstanceOf(WriteToolUseMessage);
      expect(msg.filePath).toBe('/out.ts');
      expect(msg.content).toBe('data');
    });

    it('falls back to Unknown when file_path is missing', () => {
      const msg = convertClaudeToolUse(TS, { id: 't4', name: 'Write', input: { content: 'data' } });
      expect(msg).toBeInstanceOf(UnknownToolUseMessage);
    });
  });

  describe('ApplyPatch', () => {
    it('maps ApplyPatch', () => {
      const msg = convertClaudeToolUse(TS, { id: 't5', name: 'ApplyPatch', input: { file_path: '/p.ts', old_string: 'a', new_string: 'b' } });
      expect(msg).toBeInstanceOf(ApplyPatchToolUseMessage);
    });
  });

  describe('Grep / Glob', () => {
    it('maps Grep', () => {
      const msg = convertClaudeToolUse(TS, { id: 't6', name: 'Grep', input: { pattern: 'TODO', path: '/src' } });
      expect(msg).toBeInstanceOf(GrepToolUseMessage);
      expect(msg.pattern).toBe('TODO');
    });

    it('maps Glob', () => {
      const msg = convertClaudeToolUse(TS, { id: 't7', name: 'Glob', input: { pattern: '**/*.ts' } });
      expect(msg).toBeInstanceOf(GlobToolUseMessage);
    });
  });

  describe('WebSearch / WebFetch', () => {
    it('maps WebSearch', () => {
      const msg = convertClaudeToolUse(TS, { id: 't8', name: 'WebSearch', input: { query: 'svelte 5' } });
      expect(msg).toBeInstanceOf(WebSearchToolUseMessage);
      expect(msg.query).toBe('svelte 5');
    });

    it('maps WebFetch', () => {
      const msg = convertClaudeToolUse(TS, { id: 't9', name: 'WebFetch', input: { url: 'https://x.com', prompt: 'summarize' } });
      expect(msg).toBeInstanceOf(WebFetchToolUseMessage);
      expect(msg.url).toBe('https://x.com');
    });

    it('WebSearch falls back without query', () => {
      const msg = convertClaudeToolUse(TS, { id: 't8', name: 'WebSearch', input: {} });
      expect(msg).toBeInstanceOf(UnknownToolUseMessage);
    });

    it('WebFetch falls back without url', () => {
      const msg = convertClaudeToolUse(TS, { id: 't9', name: 'WebFetch', input: { prompt: 'x' } });
      expect(msg).toBeInstanceOf(UnknownToolUseMessage);
    });
  });

  describe('TodoWrite / TodoRead', () => {
    it('maps TodoWrite', () => {
      const todos = [{ content: 'task 1', status: 'pending' }];
      const msg = convertClaudeToolUse(TS, { id: 't10', name: 'TodoWrite', input: { todos } });
      expect(msg).toBeInstanceOf(TodoWriteToolUseMessage);
      expect(msg.todos).toEqual(todos);
    });

    it('maps TodoRead', () => {
      const msg = convertClaudeToolUse(TS, { id: 't11', name: 'TodoRead', input: {} });
      expect(msg).toBeInstanceOf(TodoReadToolUseMessage);
    });
  });

  describe('Task', () => {
    it('maps Task with all fields', () => {
      const msg = convertClaudeToolUse(TS, { id: 't12', name: 'Task', input: { subagent_type: 'Explore', description: 'Find files', prompt: 'search', model: 'sonnet' } });
      expect(msg).toBeInstanceOf(TaskToolUseMessage);
      expect(msg.subagentType).toBe('Explore');
    });
  });

  describe('UpdatePlan / WriteStdin', () => {
    it('maps UpdatePlan', () => {
      const msg = convertClaudeToolUse(TS, { id: 't13', name: 'UpdatePlan', input: { todos: ['step 1'] } });
      expect(msg).toBeInstanceOf(UpdatePlanToolUseMessage);
    });

    it('maps WriteStdin', () => {
      const msg = convertClaudeToolUse(TS, { id: 't14', name: 'WriteStdin', input: { session_id: 42 } });
      expect(msg).toBeInstanceOf(WriteStdinToolUseMessage);
    });
  });

  describe('Plan mode', () => {
    it('maps EnterPlanMode', () => {
      const msg = convertClaudeToolUse(TS, { id: 'p1', name: 'EnterPlanMode', input: {} });
      expect(msg).toBeInstanceOf(EnterPlanModeToolUseMessage);
    });

    it('maps enter_plan_mode (snake_case)', () => {
      const msg = convertClaudeToolUse(TS, { id: 'p1', name: 'enter_plan_mode', input: {} });
      expect(msg).toBeInstanceOf(EnterPlanModeToolUseMessage);
    });

    it('maps ExitPlanMode with plan', () => {
      const msg = convertClaudeToolUse(TS, { id: 'p2', name: 'ExitPlanMode', input: { plan: 'Do X', allowedPrompts: [] } });
      expect(msg).toBeInstanceOf(ExitPlanModeToolUseMessage);
      expect(msg.plan).toBe('Do X');
    });

    it('maps exit_plan_mode (snake_case)', () => {
      const msg = convertClaudeToolUse(TS, { id: 'p2', name: 'exit_plan_mode', input: { plan: 'Do Y' } });
      expect(msg).toBeInstanceOf(ExitPlanModeToolUseMessage);
      expect(msg.plan).toBe('Do Y');
    });

    it('ExitPlanMode without plan falls back to Unknown', () => {
      const msg = convertClaudeToolUse(TS, { id: 'p2', name: 'ExitPlanMode', input: {} });
      expect(msg).toBeInstanceOf(UnknownToolUseMessage);
    });
  });

  describe('fallback', () => {
    it('returns UnknownToolUseMessage for unrecognized tools', () => {
      const msg = convertClaudeToolUse(TS, { id: 'u1', name: 'SomeFutureTool', input: { key: 'val' } });
      expect(msg).toBeInstanceOf(UnknownToolUseMessage);
      expect(msg.rawName).toBe('SomeFutureTool');
      expect(msg.input).toEqual({ key: 'val' });
    });

    it('handles malformed payload (non-object input)', () => {
      const msg = convertClaudeToolUse(TS, { id: 't2', name: 'Read', input: 'bad' });
      expect(msg).toBeInstanceOf(UnknownToolUseMessage);
      expect(msg.input).toEqual({ raw: 'bad' });
    });

    it('preserves JSON-string input that parses to object', () => {
      const msg = convertClaudeToolUse(TS, { id: 't2', name: 'FutureTool', input: '{"key":"val"}' });
      expect(msg).toBeInstanceOf(UnknownToolUseMessage);
      expect(msg.input).toEqual({ key: 'val' });
    });

    it('handles null part gracefully', () => {
      const msg = convertClaudeToolUse(TS, null);
      expect(msg).toBeInstanceOf(UnknownToolUseMessage);
    });

    it('handles missing name', () => {
      const msg = convertClaudeToolUse(TS, { id: 'x', input: {} });
      expect(msg).toBeInstanceOf(UnknownToolUseMessage);
      expect(msg.rawName).toBe('Unknown');
    });

    it('handles non-string name without throwing', () => {
      const msg = convertClaudeToolUse(TS, { id: 'x', name: { bad: true }, input: {} });
      expect(msg).toBeInstanceOf(UnknownToolUseMessage);
      expect(msg.rawName).toBe('Unknown');
    });
  });
});
