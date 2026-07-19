import { describe, it, expect } from 'bun:test';
import { convertCodexFunctionCall, convertCodexCustomToolCall } from '../jsonl-tool-use-converter.js';
import {
  BashToolUseMessage,
  CodexSubagentToolUseMessage,
  EditToolUseMessage,
  ExecToolUseMessage,
  WaitToolUseMessage,
  WriteStdinToolUseMessage,
  UpdatePlanToolUseMessage,
  UnknownToolUseMessage,
} from '@garcon/common/chat-types';

const TS = '2026-03-01T00:00:00.000Z';

describe('convertCodexFunctionCall', () => {
  it('maps shell_command to BashToolUseMessage', () => {
    const msg = convertCodexFunctionCall(TS, {
      name: 'shell_command',
      arguments: '{"command":"ls -la"}',
      call_id: 'call-1',
    });
    expect(msg).toBeInstanceOf(BashToolUseMessage);
    expect(msg.command).toBe('ls -la');
    expect(msg.toolId).toBe('call-1');
  });

  it('maps exec_command to BashToolUseMessage using cmd field', () => {
    const msg = convertCodexFunctionCall(TS, {
      name: 'exec_command',
      arguments: '{"cmd":"rg --files"}',
      call_id: 'call-2',
    });
    expect(msg).toBeInstanceOf(BashToolUseMessage);
    expect(msg.command).toBe('rg --files');
  });

  it('falls back to Unknown when shell_command arguments are invalid JSON', () => {
    const msg = convertCodexFunctionCall(TS, {
      name: 'shell_command',
      arguments: 'not-json',
      call_id: 'call-3',
    });
    expect(msg).toBeInstanceOf(UnknownToolUseMessage);
  });

  it('falls back to Unknown when shell_command has no command field', () => {
    const msg = convertCodexFunctionCall(TS, {
      name: 'shell_command',
      arguments: '{"workdir":"/project"}',
      call_id: 'call-4',
    });
    expect(msg).toBeInstanceOf(UnknownToolUseMessage);
  });

  it('maps shell_command with object arguments to BashToolUseMessage', () => {
    const msg = convertCodexFunctionCall(TS, {
      name: 'shell_command',
      arguments: { command: 'cat file.js' },
      call_id: 'call-obj',
    });
    expect(msg).toBeInstanceOf(BashToolUseMessage);
    expect(msg.command).toBe('cat file.js');
  });

  it('maps exec_command with object arguments using cmd field', () => {
    const msg = convertCodexFunctionCall(TS, {
      name: 'exec_command',
      arguments: { cmd: 'echo hello' },
      call_id: 'call-obj-2',
    });
    expect(msg).toBeInstanceOf(BashToolUseMessage);
    expect(msg.command).toBe('echo hello');
  });

  it('maps write_stdin to WriteStdinToolUseMessage', () => {
    const msg = convertCodexFunctionCall(TS, {
      name: 'write_stdin',
      arguments: '{"text":"hello"}',
      call_id: 'call-5',
    });
    expect(msg).toBeInstanceOf(WriteStdinToolUseMessage);
  });

  it('maps wait to a provider-agnostic WaitToolUseMessage', () => {
    const msg = convertCodexFunctionCall(TS, {
      name: 'wait',
      arguments: '{"cell_id":"46","yield_time_ms":30000,"max_tokens":12000,"terminate":true}',
      call_id: 'call-wait',
    });

    expect(msg).toBeInstanceOf(WaitToolUseMessage);
    expect(msg).toEqual({
      type: 'wait-tool-use',
      timestamp: TS,
      toolId: 'call-wait',
      executionId: '46',
      yieldTimeMs: 30000,
      maxTokens: 12000,
      terminate: true,
    });
  });

  it('preserves malformed wait arguments through the unknown fallback', () => {
    const msg = convertCodexFunctionCall(TS, {
      name: 'wait',
      arguments: '{"yield_time_ms":30000}',
      call_id: 'call-wait-invalid',
    });

    expect(msg).toBeInstanceOf(UnknownToolUseMessage);
    expect(msg.rawName).toBe('wait');
  });

  it('maps update_plan to UpdatePlanToolUseMessage', () => {
    const msg = convertCodexFunctionCall(TS, {
      name: 'update_plan',
      arguments: '{"plan":[{"step":"step 1","status":"pending"},{"step":"step 2","status":"completed"}]}',
      call_id: 'call-6',
    });
    expect(msg).toBeInstanceOf(UpdatePlanToolUseMessage);
    expect(msg.todos).toEqual([
      { content: 'step 1', status: 'pending' },
      { content: 'step 2', status: 'completed' },
    ]);
  });

  it('maps spawn_agent to CodexSubagentToolUseMessage', () => {
    const msg = convertCodexFunctionCall(TS, {
      name: 'spawn_agent',
      arguments: '{"task_name":"review-auth","message":"Review auth boundaries","model":"gpt-5.5","fork_turns":"all"}',
      call_id: 'call-subagent',
    });
    expect(msg).toBeInstanceOf(CodexSubagentToolUseMessage);
    expect(msg.type).toBe('codex-subagent-tool-use');
    expect(msg.action).toBe('spawn_agent');
    expect(msg.details).toEqual({
      message: 'Review auth boundaries',
      taskName: 'review-auth',
      model: 'gpt-5.5',
      forkTurns: 'all',
    });
  });

  it('maps namespaced v1 subagent tools to CodexSubagentToolUseMessage', () => {
    const msg = convertCodexFunctionCall(TS, {
      name: 'multi_agent_v1.wait_agent',
      arguments: '{"target":"/root/review-auth","timeout_ms":5000}',
      call_id: 'call-subagent-v1',
    });
    expect(msg).toBeInstanceOf(CodexSubagentToolUseMessage);
    expect(msg.action).toBe('wait_agent');
    expect(msg.details).toEqual({
      target: '/root/review-auth',
      timeoutMs: 5000,
    });
  });

  it('does not treat unrelated dotted tool names as subagent tools', () => {
    const msg = convertCodexFunctionCall(TS, {
      name: 'external.spawn_agent',
      arguments: '{"task_name":"not-a-codex-subagent"}',
      call_id: 'call-external-spawn',
    });

    expect(msg).toBeInstanceOf(UnknownToolUseMessage);
    expect(msg.rawName).toBe('external.spawn_agent');
  });

  it('passes through unmapped function names as Unknown', () => {
    const msg = convertCodexFunctionCall(TS, {
      name: 'some_new_tool',
      arguments: '{"key":"val"}',
      call_id: 'call-7',
    });
    expect(msg).toBeInstanceOf(UnknownToolUseMessage);
    expect(msg.rawName).toBe('some_new_tool');
  });

  it('handles null payload', () => {
    const msg = convertCodexFunctionCall(TS, null);
    expect(msg).toBeInstanceOf(UnknownToolUseMessage);
  });

  it('handles non-string function name without leaking non-string rawName', () => {
    const msg = convertCodexFunctionCall(TS, {
      name: { bad: true },
      arguments: '{"key":"val"}',
      call_id: 'call-bad-name',
    });
    expect(msg).toBeInstanceOf(UnknownToolUseMessage);
    expect(msg.rawName).toBe('unknown');
  });
});

describe('convertCodexCustomToolCall', () => {
  const mockParseApplyPatch = (input) => ({
    file_path: '/project/file.js',
    old_string: 'old line',
    new_string: 'new line',
  });

  it('converts apply_patch to EditToolUseMessage', () => {
    const msg = convertCodexCustomToolCall(TS, {
      name: 'apply_patch',
      input: 'patch data',
      call_id: 'call-patch',
    }, mockParseApplyPatch);
    expect(msg).toBeInstanceOf(EditToolUseMessage);
    expect(msg.filePath).toBe('/project/file.js');
    expect(msg.oldString).toBe('old line');
    expect(msg.newString).toBe('new line');
  });

  it('maps exec source to provider-agnostic ExecToolUseMessage', () => {
    const code = '// @exec: {"yield_time_ms": 1000}\nconst value = 1; text(value);';
    const msg = convertCodexCustomToolCall(TS, {
      name: 'exec',
      input: code,
      call_id: 'call-exec',
    }, mockParseApplyPatch);

    expect(msg).toBeInstanceOf(ExecToolUseMessage);
    expect(msg).toEqual({
      type: 'exec-tool-use',
      timestamp: TS,
      toolId: 'call-exec',
      code,
      language: 'javascript',
    });
  });

  it('preserves malformed exec input through the unknown fallback', () => {
    const msg = convertCodexCustomToolCall(TS, {
      name: 'exec',
      input: { code: 'text("ok")' },
      call_id: 'call-exec-invalid',
    }, mockParseApplyPatch);

    expect(msg).toBeInstanceOf(UnknownToolUseMessage);
    expect(msg.rawName).toBe('exec');
  });

  it('passes through non-apply_patch custom tools as Unknown', () => {
    const msg = convertCodexCustomToolCall(TS, {
      name: 'my_custom_tool',
      input: 'some input',
      call_id: 'call-custom',
    }, mockParseApplyPatch);
    expect(msg).toBeInstanceOf(UnknownToolUseMessage);
    expect(msg.rawName).toBe('my_custom_tool');
    expect(msg.input).toEqual({ raw: 'some input' });
  });

  it('handles null payload', () => {
    const msg = convertCodexCustomToolCall(TS, null, mockParseApplyPatch);
    expect(msg).toBeInstanceOf(UnknownToolUseMessage);
  });

  it('handles non-string custom tool name without leaking non-string rawName', () => {
    const msg = convertCodexCustomToolCall(TS, {
      name: { bad: true },
      input: 'some input',
      call_id: 'call-custom-bad-name',
    }, mockParseApplyPatch);
    expect(msg).toBeInstanceOf(UnknownToolUseMessage);
    expect(msg.rawName).toBe('custom_tool');
  });
});
