import { describe, it, expect } from 'bun:test';
import { buildClaudeCLIArgs, buildClaudePermissionApprovalResponse, convertCLIMessageToChatMessages } from '../claude-cli.js';
import { getNativeMessageRevisionSource } from '@garcon/server-agent-common/shared/native-message-source';
import {
  ClaudeTurnState,
  claudeBackgroundTaskCount,
  claudeProviderSessionState,
  claudeResultFailureMessage,
} from '../cli-protocol.js';
import { convertClaudePermissionTool } from '../permission-tool-converter.js';
import { AskUserQuestionToolUseMessage, BashToolUseMessage, ExitPlanModeToolUseMessage } from '@garcon/common/chat-types';
import {
  CLAUDE_STEERING_PROMPT_PREFIX,
  buildClaudeInitialUserContent,
  buildClaudeSteeringUserContent,
  buildClaudeUserInputFrame,
  claudeSteeringInputsFromNativeContent,
} from '../user-input.js';
import { ClaudeTurnSteeringState } from '../steering.js';

describe('Claude SDK user input', () => {
  it('builds the existing stream-json user frame', () => {
    expect(JSON.parse(buildClaudeUserInputFrame({
      content: 'hello',
      sessionId: 'session-1',
      uuid: 'input-1',
    }))).toEqual({
      type: 'user',
      message: { role: 'user', content: 'hello' },
      parent_tool_use_id: null,
      session_id: 'session-1',
      uuid: 'input-1',
    });
  });

  it('keeps image, document, and text attachment content in canonical order', () => {
    const text = Buffer.from('notes').toString('base64');
    expect(buildClaudeInitialUserContent('prompt', [
      {
        kind: 'image',
        name: 'screen.png',
        mimeType: 'image/png',
        data: 'data:image/png;base64,aW1hZ2U=',
      },
      {
        kind: 'image',
        name: 'spec.pdf',
        mimeType: 'application/pdf',
        data: 'data:application/pdf;base64,cGRm',
      },
      {
        kind: 'image',
        name: 'notes.txt',
        mimeType: 'text/plain',
        data: `data:text/plain;base64,${text}`,
      },
    ])).toEqual([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' },
      },
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: 'cGRm' },
        title: 'spec.pdf',
      },
      {
        type: 'text',
        text: 'prompt\n\n<attached-file name="notes.txt" mime="text/plain">\nnotes\n\n</attached-file>',
      },
    ]);
  });

  it('preserves the content-block shape when a rich attachment has invalid data', () => {
    expect(buildClaudeInitialUserContent('prompt', [{
      kind: 'image',
      name: 'broken.png',
      mimeType: 'image/png',
      data: 'not-a-data-url',
    }])).toEqual([{ type: 'text', text: 'prompt' }]);
  });

  it('builds an explicit next-priority steering frame with literal slash input', () => {
    expect(JSON.parse(buildClaudeUserInputFrame({
      content: buildClaudeSteeringUserContent('/review the failing test'),
      sessionId: 'session-1',
      uuid: 'native-steer-1',
      priority: 'next',
    }))).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'text',
          text: `${CLAUDE_STEERING_PROMPT_PREFIX}/review the failing test`,
        }],
      },
      parent_tool_use_id: null,
      session_id: 'session-1',
      uuid: 'native-steer-1',
      priority: 'next',
    });
  });

  it('extracts only complete provider-owned steering block arrays', () => {
    const content = [
      { type: 'text', text: `${CLAUDE_STEERING_PROMPT_PREFIX}first` },
      { type: 'text', text: `${CLAUDE_STEERING_PROMPT_PREFIX}/second` },
    ];
    expect(claudeSteeringInputsFromNativeContent(content)).toEqual(['first', '/second']);
    expect(claudeSteeringInputsFromNativeContent('first')).toBeNull();
    expect(claudeSteeringInputsFromNativeContent([
      content[0],
      { type: 'text', text: 'ordinary' },
    ])).toBeNull();
  });
});

describe('ClaudeTurnSteeringState', () => {
  it('holds idempotent delivery reservations', () => {
    const steering = new ClaudeTurnSteeringState();
    const release = steering.reserveDelivery();
    expect(steering.blocksIdleSettlement).toBe(true);
    expect(steering.reservationCount).toBe(1);
    release();
    release();
    expect(steering.blocksIdleSettlement).toBe(false);
    expect(steering.reservationCount).toBe(0);
  });

  it('tracks queued, started, replay, and terminal lifecycle idempotently', () => {
    const steering = new ClaudeTurnSteeringState();
    steering.markSubmitted('steer-1');
    steering.rememberProviderIdle();
    expect(steering.observe({
      type: 'command_lifecycle',
      command_uuid: 'steer-1',
      state: 'queued',
    })).toEqual({ kind: 'queued', uuid: 'steer-1' });
    expect(steering.observe({
      type: 'command_lifecycle',
      command_uuid: 'steer-1',
      state: 'started',
    })).toMatchObject({ kind: 'started', uuid: 'steer-1', source: 'lifecycle' });
    expect(steering.hasDeferredIdle).toBe(true);
    expect(steering.activeCount).toBe(1);
    expect(steering.observe({
      type: 'user',
      uuid: 'steer-1',
      isReplay: true,
    })).toBeNull();
    expect(steering.observe({
      type: 'command_lifecycle',
      command_uuid: 'steer-1',
      state: 'completed',
    })).toEqual({
      kind: 'terminal',
      uuid: 'steer-1',
      phase: 'after-start',
      state: 'completed',
    });
    expect(steering.blocksIdleSettlement).toBe(false);
  });

  it('accepts queued replay as a start fallback', () => {
    const steering = new ClaudeTurnSteeringState();
    steering.markSubmitted('steer-1');
    steering.observe({
      type: 'command_lifecycle',
      command_uuid: 'steer-1',
      state: 'queued',
    });
    expect(steering.observe({
      type: 'user',
      uuid: 'steer-1',
      isReplay: true,
    })).toMatchObject({ kind: 'started', source: 'replay' });
    expect(steering.activeCount).toBe(1);
  });

  it('keeps deferred idle fenced when one of several native inputs starts', () => {
    const steering = new ClaudeTurnSteeringState();
    steering.markSubmitted('steer-1');
    steering.markSubmitted('steer-2');
    steering.rememberProviderIdle();
    steering.observe({
      type: 'command_lifecycle',
      command_uuid: 'steer-1',
      state: 'queued',
    });
    steering.observe({
      type: 'command_lifecycle',
      command_uuid: 'steer-1',
      state: 'started',
    });

    expect(steering.hasDeferredIdle).toBe(true);
    expect(steering.activeCount).toBe(1);
    expect(steering.submittedCount).toBe(1);
  });

  it('rejects replay without prior queue acceptance', () => {
    const steering = new ClaudeTurnSteeringState();
    steering.markSubmitted('steer-1');
    expect(steering.observe({
      type: 'user',
      uuid: 'steer-1',
      isReplay: true,
    })).toEqual({ kind: 'duplicate-replay', uuid: 'steer-1' });
    expect(steering.blocksIdleSettlement).toBe(false);
  });

  it('reports terminal lifecycle before start and keeps other inputs fenced', () => {
    const steering = new ClaudeTurnSteeringState();
    steering.markSubmitted('steer-1');
    steering.markSubmitted('steer-2');
    expect(steering.observe({
      type: 'command_lifecycle',
      command_uuid: 'steer-1',
      state: 'discarded',
    })).toEqual({
      kind: 'terminal',
      uuid: 'steer-1',
      phase: 'before-start',
      state: 'discarded',
    });
    expect(steering.submittedCount).toBe(1);
    expect(steering.blocksIdleSettlement).toBe(true);
  });

  it('intersects interrupt receipts with owned native UUIDs', () => {
    const steering = new ClaudeTurnSteeringState();
    steering.markSubmitted('cancelled');
    steering.markSubmitted('survivor');
    expect(steering.observeInterruptReceipt({
      cancelled: ['cancelled', 'provider-owned'],
      stillQueued: ['survivor'],
    })).toEqual({ cancelledCount: 1, stillQueuedCount: 1 });
    expect(steering.submittedCount).toBe(1);
  });

  it('bounds deferred idle only while native work remains', async () => {
    const steering = new ClaudeTurnSteeringState();
    let timedOut = 0;
    const release = steering.reserveDelivery();
    steering.deferIdle(() => timedOut += 1, 1);
    await Bun.sleep(5);
    expect(timedOut).toBe(0);

    steering.markSubmitted('steer-1');
    release();
    steering.deferIdle(() => timedOut += 1, 1);
    await Bun.sleep(5);
    expect(timedOut).toBe(1);
    steering.clear();
    expect(steering.blocksIdleSettlement).toBe(false);
  });
});

describe('buildClaudeCLIArgs', () => {

  it('forwards explicit canonical effort exactly and omits Default', () => {
    for (const thinkingMode of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
      const args = buildClaudeCLIArgs({ thinkingMode, prompt: 'hi' });
      const effortIndex = args.indexOf('--effort');
      expect(effortIndex).toBeGreaterThanOrEqual(0);
      expect(args[effortIndex + 1]).toBe(thinkingMode);
    }
    expect(buildClaudeCLIArgs({ thinkingMode: 'none', prompt: 'hi' })).not.toContain('--effort');
  });

  it('does not forward the removed Claude thinking flag', () => {
    for (const claudeThinkingMode of ['auto', 'on', 'off']) {
      const args = buildClaudeCLIArgs({ claudeThinkingMode, prompt: 'hi' });

      expect(args).not.toContain('--thinking');
      expect(args).not.toContain('adaptive');
      expect(args).not.toContain('enabled');
      expect(args).not.toContain('disabled');
    }
  });

  it('includes stream-json session flags and effort for sessions', () => {
    expect(buildClaudeCLIArgs({
      model: 'sonnet',
      permissionMode: 'acceptEdits',
      thinkingMode: 'medium',
      claudeThinkingMode: 'off',
      sessionId: 'session-1',
      prompt: '',
      streamJson: true,
    })).toEqual([
      '--print',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--replay-user-messages',
      '--verbose',
      '--model', 'sonnet',
      '--permission-mode', 'acceptEdits',
      '--permission-prompt-tool', 'stdio',
      '--effort', 'medium',
      '--session-id=session-1',
      '-p', '',
    ]);
  });

  it('passes session identifiers with inline values', () => {
    const args = buildClaudeCLIArgs({
      resumeSessionId: 'session-1',
      prompt: '',
      streamJson: true,
    });

    expect(args).toContain('--resume=session-1');
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('session-1');
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

  it('attaches the record uuid and rendered ordinal as the native identity', () => {
    const result = convertCLIMessageToChatMessages({
      type: 'assistant',
      uuid: 'uuid-live-1',
      content: [
        { type: 'thinking', thinking: 'reason' },
        { type: 'text', text: 'answer' },
      ],
    });
    expect(result).toHaveLength(2);
    expect(getNativeMessageRevisionSource(result[0])).toEqual({ entryId: 'uuid-live-1', withinSourceOrdinal: 0 });
    expect(getNativeMessageRevisionSource(result[1])).toEqual({ entryId: 'uuid-live-1', withinSourceOrdinal: 1 });
    const withoutUuid = convertCLIMessageToChatMessages({
      type: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
    });
    expect(getNativeMessageRevisionSource(withoutUuid[0])).toBeNull();
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

  it('converts real CLI user-frame tool results without replaying user text', () => {
    const msg = {
      type: 'user',
      uuid: 'user-1',
      isReplay: true,
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'do not render this prompt again' },
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'command output',
            is_error: false,
          },
        ],
      },
      tool_use_result: {
        stdout: 'command output',
        stderr: '',
        interrupted: false,
      },
    };

    const result = convertCLIMessageToChatMessages(msg);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'tool-result',
      toolId: 'tool-1',
      isError: false,
      content: {
        raw: 'command output',
        toolUseResult: {
          stdout: 'command output',
          stderr: '',
          interrupted: false,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('do not render this prompt again');
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

describe('claudeResultFailureMessage', () => {
  it('does not expose Claude internal execution diagnostics', () => {
    expect(claudeResultFailureMessage({
      type: 'result',
      subtype: 'error_during_execution',
      terminal_reason: 'aborted_streaming',
      is_error: true,
      errors: [
        '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null',
      ],
    })).toBe('Claude CLI turn failed: error_during_execution');
  });
});

describe('Claude provider run boundaries', () => {
  it('decodes only recognized session state events', () => {
    expect(claudeProviderSessionState({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'running',
    })).toBe('running');
    expect(claudeProviderSessionState({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'idle',
    })).toBe('idle');
    expect(claudeProviderSessionState({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'future-state',
    })).toBeNull();
    expect(claudeProviderSessionState({
      type: 'assistant',
      subtype: 'session_state_changed',
      state: 'idle',
    })).toBeNull();
  });

  it('decodes background task snapshots as a level count', () => {
    expect(claudeBackgroundTaskCount({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'one' }, { task_id: 'two' }],
    })).toBe(2);
    expect(claudeBackgroundTaskCount({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [],
    })).toBe(0);
    expect(claudeBackgroundTaskCount({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: 'malformed',
    })).toBeNull();
  });

  it('treats later results as continuations of the accepted input', () => {
    const turn = new ClaudeTurnState('input-1');
    turn.observeInput({
      type: 'command_lifecycle',
      command_uuid: 'input-1',
      state: 'started',
    });
    expect(turn.correlateResult({
      type: 'result',
      user_message_uuid: 'another-input',
    })).toBe('mismatched');

    const inputResult = { type: 'result', user_message_uuid: 'input-1', is_error: false };
    expect(turn.correlateResult(inputResult)).toBe('input');
    turn.addOutputMessages(1, true);
    turn.recordAcceptedResult(inputResult);

    expect(turn.correlateResult({
      type: 'result',
      user_message_uuid: 'provider-owned-continuation',
    })).toBe('continuation');
  });

  it('keeps a background continuation fenced through its completion turn', () => {
    const turn = new ClaudeTurnState('input-1', 1);
    turn.observeInput({
      type: 'command_lifecycle',
      command_uuid: 'input-1',
      state: 'started',
    });
    turn.recordAcceptedResult({
      type: 'result',
      user_message_uuid: 'input-1',
      is_error: false,
    });
    expect(turn.backgroundContinuationPending).toBe(true);

    turn.observeBackgroundTaskCount(0);
    turn.recordAcceptedResult({ type: 'result', is_error: false });
    expect(turn.backgroundContinuationPending).toBe(false);
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
