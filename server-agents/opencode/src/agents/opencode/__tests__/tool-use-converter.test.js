import { describe, it, expect } from 'bun:test';
import {
  convertOpenCodeToolUse,
  OPENCODE_BUILTIN_TOOL_IDS,
} from '../tool-use-converter.js';
import {
  AskUserQuestionToolUseMessage,
  ApplyPatchToolUseMessage,
  BashToolUseMessage,
  ExecToolUseMessage,
  ExternalToolUseMessage,
  ReadToolUseMessage,
  EditToolUseMessage,
  WriteToolUseMessage,
  TaskToolUseMessage,
  TodoWriteToolUseMessage,
  EnterPlanModeToolUseMessage,
  ExitPlanModeToolUseMessage,
  UnknownToolUseMessage,
} from '@garcon/common/chat-types';

const TS = '2026-03-01T00:00:00.000Z';

describe('convertOpenCodeToolUse', () => {
  it('maps Bash with command from state.input', () => {
    const msg = convertOpenCodeToolUse(TS, {
      tool: 'Bash',
      callID: 'oc-1',
      state: { input: { command: 'ls -la' } },
    });
    expect(msg).toBeInstanceOf(BashToolUseMessage);
    expect(msg.command).toBe('ls -la');
    expect(msg.toolId).toBe('oc-1');
  });

  it('maps Read with file_path', () => {
    const msg = convertOpenCodeToolUse(TS, {
      tool: 'Read',
      callID: 'oc-2',
      state: { input: { file_path: '/tmp/test.ts', offset: 10 } },
    });
    expect(msg).toBeInstanceOf(ReadToolUseMessage);
    expect(msg.filePath).toBe('/tmp/test.ts');
    expect(msg.offset).toBe(10);
  });

  it('maps Edit with diff fields', () => {
    const msg = convertOpenCodeToolUse(TS, {
      tool: 'Edit',
      callID: 'oc-3',
      state: { input: { file_path: '/f.ts', old_string: 'a', new_string: 'b' } },
    });
    expect(msg).toBeInstanceOf(EditToolUseMessage);
    expect(msg.filePath).toBe('/f.ts');
  });

  it('maps Write with file_path', () => {
    const msg = convertOpenCodeToolUse(TS, {
      tool: 'Write',
      callID: 'oc-4',
      state: { input: { file_path: '/out.ts', content: 'data' } },
    });
    expect(msg).toBeInstanceOf(WriteToolUseMessage);
    expect(msg.filePath).toBe('/out.ts');
  });

  it('maps TodoWrite with todos', () => {
    const msg = convertOpenCodeToolUse(TS, {
      tool: 'TodoWrite',
      callID: 'oc-5',
      state: { input: { todos: [{ content: 'task' }] } },
    });
    expect(msg).toBeInstanceOf(TodoWriteToolUseMessage);
  });

  it('maps EnterPlanMode', () => {
    const msg = convertOpenCodeToolUse(TS, {
      tool: 'EnterPlanMode',
      callID: 'oc-6',
      state: { input: {} },
    });
    expect(msg).toBeInstanceOf(EnterPlanModeToolUseMessage);
  });

  it('maps ExitPlanMode with plan', () => {
    const msg = convertOpenCodeToolUse(TS, {
      tool: 'ExitPlanMode',
      callID: 'oc-7',
      state: { input: { plan: 'Do X', allowedPrompts: [] } },
    });
    expect(msg).toBeInstanceOf(ExitPlanModeToolUseMessage);
    expect(msg.plan).toBe('Do X');
  });

  it('maps question into the generic ask-user-question tool-use type', () => {
    const msg = convertOpenCodeToolUse(TS, {
      tool: 'question',
      callID: 'oc-question',
      state: {
        input: {
          questions: [{
            header: 'Mode',
            question: 'Which mode should the task use?',
            multiple: true,
            options: [
              { label: 'Fast', description: 'Complete the task quickly.' },
              { label: 'Careful', description: 'Check every boundary.' },
            ],
          }],
        },
      },
    });

    expect(msg).toBeInstanceOf(AskUserQuestionToolUseMessage);
    expect(msg).toEqual(new AskUserQuestionToolUseMessage(
      TS,
      'oc-question',
      undefined,
      [{
        id: 'question-1',
        prompt: 'Which mode should the task use?',
        header: 'Mode',
        allowMultiple: true,
        options: [
          {
            id: 'question-1-option-1',
            label: 'Fast',
            description: 'Complete the task quickly.',
          },
          {
            id: 'question-1-option-2',
            label: 'Careful',
            description: 'Check every boundary.',
          },
        ],
      }],
    ));
  });

  it('keeps repeated question prompts and option labels independently addressable', () => {
    const msg = convertOpenCodeToolUse(TS, {
      tool: 'question',
      callID: 'oc-question-repeated',
      state: {
        input: {
          questions: [1, 2].map(() => ({
            header: 'Mode',
            question: 'Choose a mode',
            options: [1, 2].map(() => ({
              label: 'Same label',
              description: 'A repeated provider label.',
            })),
          })),
        },
      },
    });

    expect(msg).toBeInstanceOf(AskUserQuestionToolUseMessage);
    expect(msg.questions.map((question) => question.id)).toEqual(['question-1', 'question-2']);
    expect(msg.questions.map((question) => question.options.map((option) => option.id))).toEqual([
      ['question-1-option-1', 'question-1-option-2'],
      ['question-2-option-1', 'question-2-option-2'],
    ]);
  });

  it('maps every pinned OpenCode built-in to an explicit shared tool type', () => {
    const cases = [
      ['invalid', { tool: 'missing_tool', error: 'Tool does not exist.' }, 'external-tool-use'],
      ['question', {
        questions: [{
          header: 'Mode',
          question: 'Which mode?',
          options: [{ label: 'Careful', description: 'Check boundaries.' }],
        }],
      }, 'ask-user-question-tool-use'],
      ['bash', { command: 'printf done' }, 'bash-tool-use'],
      ['read', { filePath: '/repo/input.ts' }, 'read-tool-use'],
      ['glob', { pattern: '**/*.ts', path: '/repo' }, 'glob-tool-use'],
      ['grep', { pattern: 'needle', path: '/repo' }, 'grep-tool-use'],
      ['edit', { filePath: '/repo/input.ts', oldString: 'a', newString: 'b' }, 'edit-tool-use'],
      ['write', { filePath: '/repo/output.ts', content: 'data' }, 'write-tool-use'],
      ['task', {
        subagent_type: 'reviewer',
        description: 'Review change',
        prompt: 'Review the implementation.',
      }, 'task-tool-use'],
      ['webfetch', { url: 'https://example.test' }, 'web-fetch-tool-use'],
      ['todowrite', { todos: [{ content: 'Verify behavior', status: 'pending' }] }, 'todo-write-tool-use'],
      ['websearch', { query: 'OpenCode tools' }, 'web-search-tool-use'],
      ['skill', { name: 'testing' }, 'external-tool-use'],
      ['apply_patch', { patchText: '*** Begin Patch\n*** End Patch' }, 'apply-patch-tool-use'],
      ['execute', { code: 'return tools.example({})' }, 'exec-tool-use'],
      ['lsp', { operation: 'hover', filePath: '/repo/input.ts', line: 1, character: 1 }, 'external-tool-use'],
      ['plan_exit', {}, 'exit-plan-mode-tool-use'],
    ];

    expect(cases.map(([tool]) => tool)).toEqual(OPENCODE_BUILTIN_TOOL_IDS);
    for (const [tool, input, expectedType] of cases) {
      const message = convertOpenCodeToolUse(TS, {
        tool,
        callID: `call-${tool}`,
        state: { input },
      });
      expect({ tool, type: message.type }).toEqual({ tool, type: expectedType });
      expect(message).not.toBeInstanceOf(UnknownToolUseMessage);
    }
  });

  it('preserves current OpenCode apply_patch, task resume, and execute inputs', () => {
    const patch = convertOpenCodeToolUse(TS, {
      tool: 'apply_patch',
      callID: 'call-patch',
      state: { input: { patchText: '*** Begin Patch\n*** End Patch' } },
    });
    expect(patch).toBeInstanceOf(ApplyPatchToolUseMessage);
    expect(patch.patch).toBe('*** Begin Patch\n*** End Patch');

    const task = convertOpenCodeToolUse(TS, {
      tool: 'task',
      callID: 'call-task',
      state: { input: { task_id: 'task-42' } },
    });
    expect(task).toBeInstanceOf(TaskToolUseMessage);
    expect(task.resume).toBe('task-42');

    const execute = convertOpenCodeToolUse(TS, {
      tool: 'execute',
      callID: 'call-execute',
      state: { input: { code: 'return tools.example({})' } },
    });
    expect(execute).toBeInstanceOf(ExecToolUseMessage);
    expect(execute.code).toBe('return tools.example({})');
    expect(execute.language).toBe('javascript');
  });

  it('falls back to Unknown for malformed question input', () => {
    const msg = convertOpenCodeToolUse(TS, {
      tool: 'question',
      callID: 'oc-question-malformed',
      state: { input: { questions: [{ header: 'Missing prompt', options: [] }] } },
    });

    expect(msg).toBeInstanceOf(UnknownToolUseMessage);
    expect(msg.rawName).toBe('question');
  });

  it('maps custom and plugin tools to the explicit external tool contract', () => {
    const msg = convertOpenCodeToolUse(TS, {
      tool: 'CustomTool',
      callID: 'oc-8',
      state: { input: { key: 'val' } },
    });
    expect(msg).toBeInstanceOf(ExternalToolUseMessage);
    expect(msg.name).toBe('CustomTool');
    expect(msg.namespace).toBe('opencode');
    expect(msg.input).toEqual({ key: 'val' });
  });

  it('uses fallback id from part.id when callID is missing', () => {
    const msg = convertOpenCodeToolUse(TS, {
      tool: 'Bash',
      id: 'fallback-id',
      state: { input: { command: 'ls' } },
    });
    expect(msg.toolId).toBe('fallback-id');
  });

  it('handles null part gracefully', () => {
    const msg = convertOpenCodeToolUse(TS, null);
    expect(msg).toBeInstanceOf(UnknownToolUseMessage);
  });

  it('handles missing state.input', () => {
    const msg = convertOpenCodeToolUse(TS, {
      tool: 'Bash',
      callID: 'oc-9',
      state: {},
    });
    expect(msg).toBeInstanceOf(UnknownToolUseMessage);
    expect(msg.rawName).toBe('Bash');
  });

  it('preserves non-object state.input as { raw: value }', () => {
    const msg = convertOpenCodeToolUse(TS, {
      tool: 'CustomTool',
      callID: 'oc-10',
      state: { input: 'some string payload' },
    });
    expect(msg).toBeInstanceOf(ExternalToolUseMessage);
    expect(msg.input).toEqual({ raw: 'some string payload' });
  });

  it('parses JSON-string state.input that resolves to object', () => {
    const msg = convertOpenCodeToolUse(TS, {
      tool: 'CustomTool',
      callID: 'oc-11',
      state: { input: '{"key":"val"}' },
    });
    expect(msg).toBeInstanceOf(ExternalToolUseMessage);
    expect(msg.input).toEqual({ key: 'val' });
  });

  it('handles non-string tool name without throwing', () => {
    const msg = convertOpenCodeToolUse(TS, {
      tool: { bad: true },
      callID: 'oc-12',
      state: { input: {} },
    });
    expect(msg).toBeInstanceOf(UnknownToolUseMessage);
    expect(msg.rawName).toBe('Unknown');
  });
});
