import { describe, it, expect } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { buildClaudeCLIArgs, buildClaudePermissionApprovalResponse, convertCLIMessageToChatMessages, createClaudeNativePath } from '../claude-cli.js';
import { convertClaudePermissionTool } from '../permission-tool-converter.js';
import { AskUserQuestionToolUseMessage, BashToolUseMessage, ExitPlanModeToolUseMessage } from '../../../../common/chat-types.js';

describe('createClaudeNativePath', () => {
  it('uses the canonical project path before encoding', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-native-path-'));
    const actualProjectPath = path.join(rootDir, 'workspace');
    const symlinkRoot = path.join(rootDir, 'alias-root');
    const symlinkProjectPath = path.join(symlinkRoot, 'workspace');

    await fs.mkdir(actualProjectPath, { recursive: true });
    await fs.symlink(rootDir, symlinkRoot);

    const nativePath = await createClaudeNativePath(symlinkProjectPath, 'session-1');
    const canonicalProjectPath = await fs.realpath(symlinkProjectPath);
    const encodedProjectPath = canonicalProjectPath.replace(/[\\/:\s~_]/g, '-');

    expect(nativePath).toBe(path.join(os.homedir(), '.claude', 'projects', encodedProjectPath, 'session-1.jsonl'));
    expect(nativePath).not.toContain('alias-root');
  });
});

describe('buildClaudeCLIArgs', () => {
  it('does not forward Claude thinking mode unless the CLI supports the legacy flag', () => {
    for (const claudeThinkingMode of ['auto', 'on', 'off']) {
      const args = buildClaudeCLIArgs({ claudeThinkingMode, prompt: 'hi' });

      expect(args).not.toContain('--thinking');
      expect(args).not.toContain('adaptive');
      expect(args).not.toContain('enabled');
      expect(args).not.toContain('disabled');
    }
  });

  it('maps Claude thinking modes to legacy --thinking values on old CLIs', () => {
    const legacy = (claudeThinkingMode) =>
      buildClaudeCLIArgs({ claudeThinkingMode, prompt: 'hi', supportsLegacyThinkingFlag: true });

    expect(legacy('auto')).toContain('--thinking');
    expect(legacy('auto')).toContain('adaptive');
    expect(legacy('on')).toContain('enabled');
    expect(legacy('off')).toContain('disabled');
  });

  it('includes stream-json session flags and effort for sessions', () => {
    expect(buildClaudeCLIArgs({
      model: 'sonnet',
      permissionMode: 'acceptEdits',
      thinkingMode: 'think-hard',
      claudeThinkingMode: 'off',
      sessionId: 'session-1',
      prompt: '',
      streamJson: true,
    })).toEqual([
      '--print',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--model', 'sonnet',
      '--permission-mode', 'acceptEdits',
      '--permission-prompt-tool', 'stdio',
      '--effort', 'medium',
      '--session-id', 'session-1',
      '-p', '',
    ]);
  });

  it('appends legacy --thinking to stream-json sessions on old CLIs', () => {
    expect(buildClaudeCLIArgs({
      model: 'sonnet',
      permissionMode: 'acceptEdits',
      thinkingMode: 'think-hard',
      claudeThinkingMode: 'off',
      sessionId: 'session-1',
      prompt: '',
      streamJson: true,
      supportsLegacyThinkingFlag: true,
    })).toEqual([
      '--print',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--model', 'sonnet',
      '--permission-mode', 'acceptEdits',
      '--permission-prompt-tool', 'stdio',
      '--effort', 'medium',
      '--thinking', 'disabled',
      '--session-id', 'session-1',
      '-p', '',
    ]);
  });

  it('starts manual bypass as normal Claude mode with stdio permission prompts', () => {
    const args = buildClaudeCLIArgs({
      permissionMode: 'manualBypass',
      prompt: '',
      streamJson: true,
    });

    expect(args).toContain('--permission-prompt-tool');
    expect(args).toContain('stdio');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('manualBypass');
  });

  it('keeps stdio permission prompts available in dangerous bypass for interactive tools', () => {
    const args = buildClaudeCLIArgs({
      permissionMode: 'bypassPermissions',
      prompt: '',
      streamJson: true,
    });

    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).toContain('--permission-prompt-tool');
    expect(args).toContain('stdio');
  });
});

describe('convertCLIMessageToChatMessages', () => {
  it('returns empty array for non-assistant messages', () => {
    expect(convertCLIMessageToChatMessages({ type: 'system', content: [] })).toEqual([]);
  });

  it('converts text to assistant-message', () => {
    const msg = {
      type: 'assistant',
      content: [{ type: 'text', text: 'Hello world' }],
    };
    const result = convertCLIMessageToChatMessages(msg);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('assistant-message');
    expect(result[0].content).toBe('Hello world');
  });

  it('converts thinking to thinking message', () => {
    const msg = {
      type: 'assistant',
      content: [{ type: 'thinking', thinking: 'Internal reasoning' }],
    };
    const result = convertCLIMessageToChatMessages(msg);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('thinking');
    expect(result[0].content).toBe('Internal reasoning');
  });

  it('converts tool_use to tool-use message', () => {
    const msg = {
      type: 'assistant',
      content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: '/tmp/foo' } }],
    };
    const result = convertCLIMessageToChatMessages(msg);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('read-tool-use');
    expect(result[0].toolId).toBe('tool-1');
  });

  it('converts tool_result to tool-result message', () => {
    const msg = {
      type: 'assistant',
      content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok', is_error: false }],
    };
    const result = convertCLIMessageToChatMessages(msg);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('tool-result');
    expect(result[0].toolId).toBe('tool-1');
    expect(result[0].isError).toBe(false);
  });

  it('converts all content types from a single assistant message', () => {
    const msg = {
      type: 'assistant',
      content: [
        { type: 'text', text: 'Some response text' },
        { type: 'thinking', thinking: 'Internal reasoning' },
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: '/tmp/foo' } },
      ],
    };
    const result = convertCLIMessageToChatMessages(msg);
    expect(result).toHaveLength(3);
    expect(result[0].type).toBe('assistant-message');
    expect(result[1].type).toBe('thinking');
    expect(result[2].type).toBe('read-tool-use');
  });

  it('reads content from message.content wrapper shape', () => {
    const msg = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } }],
      },
    };
    const result = convertCLIMessageToChatMessages(msg);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('bash-tool-use');
  });

  it('skips empty or whitespace-only text parts', () => {
    const msg = {
      type: 'assistant',
      content: [{ type: 'text', text: '   ' }],
    };
    const result = convertCLIMessageToChatMessages(msg);
    expect(result).toHaveLength(0);
  });

  it('passes EnterPlanMode as a regular tool-use', () => {
    const msg = {
      type: 'assistant',
      content: [{ type: 'tool_use', id: 'p1', name: 'EnterPlanMode', input: {} }],
    };
    const result = convertCLIMessageToChatMessages(msg);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('enter-plan-mode-tool-use');
    expect(result[0].toolId).toBe('p1');
  });

  it('passes ExitPlanMode as a regular tool-use with typed fields', () => {
    const msg = {
      type: 'assistant',
      content: [{ type: 'tool_use', id: 'p2', name: 'exit_plan_mode', input: { plan: 'Do X', allowedPrompts: [] } }],
    };
    const result = convertCLIMessageToChatMessages(msg);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('exit-plan-mode-tool-use');
    expect(result[0].plan).toBe('Do X');
  });

  it('passes AskUserQuestion as a generic ask-user-question tool-use', () => {
    const msg = {
      type: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'tool-question',
        name: 'AskUserQuestion',
        input: {
          questions: [{
            header: 'Mode',
            question: 'Which mode?',
            multiSelect: false,
            options: [{ label: 'Fast', description: 'Quick path.' }],
          }],
        },
      }],
    };
    const result = convertCLIMessageToChatMessages(msg);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(AskUserQuestionToolUseMessage);
    expect(result[0].type).toBe('ask-user-question-tool-use');
    expect(result[0].questions[0].prompt).toBe('Which mode?');
  });

  it('falls back to UnknownToolUseMessage for non-object tool input', () => {
    const msg = {
      type: 'assistant',
      content: [{ type: 'tool_use', id: 'p2', name: 'exit_plan_mode', input: 'not-a-map' }],
    };
    const result = convertCLIMessageToChatMessages(msg);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('unknown-tool-use');
    expect(result[0].rawName).toBe('exit_plan_mode');
    expect(result[0].plan).toBeUndefined();
  });

  it('preserves typed Edit fields from complex input', () => {
    const msg = {
      type: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'nested-1',
        name: 'Edit',
        input: {
          file_path: '/tmp/foo.js',
          old_string: 'const a = 1;',
          new_string: 'const a = 2;',
          nested: { deep: { value: [1, 2, 3] } },
        },
      }],
    };
    const result = convertCLIMessageToChatMessages(msg);
    expect(result[0].filePath).toBe('/tmp/foo.js');
    expect(result[0].oldString).toBe('const a = 1;');
    expect(result[0].newString).toBe('const a = 2;');
  });

  it('falls back to UnknownToolUseMessage for null tool input on Read', () => {
    const msg = {
      type: 'assistant',
      content: [{ type: 'tool_use', id: 'n1', name: 'Read', input: null }],
    };
    const result = convertCLIMessageToChatMessages(msg);
    expect(result[0].type).toBe('unknown-tool-use');
    expect(result[0].rawName).toBe('Read');
    expect(result[0].filePath).toBeUndefined();
  });

  it('falls back to UnknownToolUseMessage for array tool input on Read', () => {
    const msg = {
      type: 'assistant',
      content: [{ type: 'tool_use', id: 'a1', name: 'Read', input: [1, 2, 3] }],
    };
    const result = convertCLIMessageToChatMessages(msg);
    expect(result[0].type).toBe('unknown-tool-use');
    expect(result[0].rawName).toBe('Read');
    expect(result[0].filePath).toBeUndefined();
  });

  it('returns empty array when content is empty', () => {
    const msg = { type: 'assistant', content: [] };
    const result = convertCLIMessageToChatMessages(msg);
    expect(result).toHaveLength(0);
  });
});

describe('convertClaudePermissionTool', () => {
  it('converts bash permission requests into canonical requested tools', () => {
    const msg = convertClaudePermissionTool('2026-01-01T00:00:00.000Z', 'perm-tool-1', 'Bash', {
      command: 'ls -la',
    });

    expect(msg).toBeInstanceOf(BashToolUseMessage);
    expect(msg.command).toBe('ls -la');
  });

  it('converts exit_plan_mode permission requests into canonical requested tools', () => {
    const msg = convertClaudePermissionTool('2026-01-01T00:00:00.000Z', 'perm-tool-2', 'exit_plan_mode', {
      plan: 'Do X',
      allowedPrompts: [],
    });

    expect(msg).toBeInstanceOf(ExitPlanModeToolUseMessage);
    expect(msg.plan).toBe('Do X');
  });

  it('converts AskUserQuestion permission requests into generic question tools', () => {
    const msg = convertClaudePermissionTool('2026-01-01T00:00:00.000Z', 'tool-question', 'AskUserQuestion', {
      questions: [{
        question: 'Which mode?',
        header: 'Mode',
        options: [{ label: 'Fast', description: 'Quick path.' }],
        multiSelect: false,
      }],
    });

    expect(msg).toBeInstanceOf(AskUserQuestionToolUseMessage);
    expect(msg.toolId).toBe('tool-question');
    expect(msg.questions[0].header).toBe('Mode');
  });
});

describe('buildClaudePermissionApprovalResponse', () => {
  it('preserves the raw provider tool name when alwaysAllow adds a session rule', () => {
    const response = buildClaudePermissionApprovalResponse({
      providerToolName: 'exit_plan_mode',
      providerToolInput: { plan: 'Do X' },
    }, { allow: true, alwaysAllow: true });

    expect(response).toEqual({
      behavior: 'allow',
      updatedInput: { plan: 'Do X' },
      updatedPermissions: [{
        type: 'addRules',
        rules: [{ toolName: 'exit_plan_mode' }],
        behavior: 'allow',
        destination: 'session',
      }],
    });
  });

  it('omits updatedPermissions for allow-once decisions', () => {
    const response = buildClaudePermissionApprovalResponse({
      providerToolName: 'Bash',
      providerToolInput: { command: 'ls' },
    }, { allow: true, alwaysAllow: false });

    expect(response).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls' },
    });
  });

  it('translates generic AskUserQuestion answers into Claude updatedInput', () => {
    const response = buildClaudePermissionApprovalResponse({
      toolName: 'AskUserQuestion',
      toolUseId: 'tool-question',
      toolInput: {
        questions: [{
          question: 'Which mode?',
          header: 'Mode',
          options: [
            { label: 'Fast', description: 'Quick path.' },
            { label: 'Careful', description: 'Detailed path.', preview: '<pre>careful</pre>' },
          ],
          multiSelect: false,
        }],
      },
    }, {
      allow: true,
      alwaysAllow: false,
      response: {
        type: 'ask-user-question-response',
        outcome: 'answered',
        answers: [{ questionId: 'Which mode?', selectedOptionIds: ['Careful'] }],
      },
    });

    expect(response).toEqual({
      behavior: 'allow',
      toolUseID: 'tool-question',
      updatedInput: {
        questions: [{
          question: 'Which mode?',
          header: 'Mode',
          options: [
            { label: 'Fast', description: 'Quick path.' },
            { label: 'Careful', description: 'Detailed path.', preview: '<pre>careful</pre>' },
          ],
          multiSelect: false,
        }],
        answers: { 'Which mode?': 'Careful' },
        annotations: { 'Which mode?': { preview: '<pre>careful</pre>' } },
      },
    });
  });

  it('translates skipped AskUserQuestion responses into a Claude deny response', () => {
    const response = buildClaudePermissionApprovalResponse({
      toolName: 'AskUserQuestion',
      toolUseId: 'tool-question',
      toolInput: { questions: [] },
    }, {
      allow: false,
      alwaysAllow: false,
      response: {
        type: 'ask-user-question-response',
        outcome: 'skipped',
        reason: 'User skipped question',
      },
    });

    expect(response).toEqual({
      behavior: 'deny',
      message: 'User skipped question',
      toolUseID: 'tool-question',
    });
  });
});
