import { describe, expect, it } from 'bun:test';
import {
  BashToolUseMessage,
  ExecToolUseMessage,
  ToolResultMessage,
} from '@garcon/common/chat-types';
import { LegacyCodexProjection } from '../legacy-history-projection.js';

const TS = '2026-07-21T12:00:00.000Z';

function codeModeCall(callId, input) {
  return {
    type: 'response_item',
    timestamp: TS,
    payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input },
  };
}

function codeModeOutput(callId, output = 'aggregate output') {
  return {
    type: 'response_item',
    timestamp: TS,
    payload: { type: 'custom_tool_call_output', call_id: callId, output },
  };
}

function functionCall(callId, name = 'request_user_input') {
  return {
    type: 'response_item', timestamp: TS,
    payload: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify({
      questions: [{ id: 'mode', header: 'Mode', question: 'Which mode?', options: [{ label: 'Fast' }] }],
    }) },
  };
}

function functionOutput(callId, output) {
  return {
    type: 'response_item', timestamp: TS,
    payload: { type: 'function_call_output', call_id: callId, output },
  };
}

describe('LegacyCodexProjection questions', () => {
  it.each([
    'request_user_input is unavailable in Default mode',
    'request_user_input was cancelled before receiving a response',
    'failed to parse function arguments: missing field `header`',
    'failed to parse function arguments: EOF while parsing a value',
  ])('marks only the matching question result as failed: %s', (output) => {
    const projection = new LegacyCodexProjection();
    projection.project(functionCall('question'), {});
    projection.project(functionCall('ordinary', 'custom_tool'), {});
    expect(projection.project(functionOutput('ordinary', output), {}).canonical[0])
      .toMatchObject({ isError: false, content: { raw: output } });
    expect(projection.project(functionOutput('question', output), {}).canonical[0])
      .toMatchObject({ isError: true, content: { raw: output } });
    expect(projection.project(functionOutput('question', output), {}).canonical[0].isError).toBe(false);
  });

  it.each([
    {},
    { mode: { answers: ['request_user_input was cancelled'] } },
    { mode: { answers: ['option-0'] } },
  ])('projects matching native answers without interpreting text as an error: %j', (answers) => {
    const projection = new LegacyCodexProjection();
    projection.project(functionCall('question'), {});
    const result = projection.project(functionOutput('question', JSON.stringify({ answers })), {});
    expect(result.canonical[0]).toMatchObject({ isError: false, content: {
      toolUseResult: { answers: Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, answer.answers])) },
    } });
    expect(result.canonical[0].content.raw).toBeUndefined();
  });

  it('does not attach question metadata to unrelated answer-shaped output', () => {
    const projection = new LegacyCodexProjection();
    projection.project(functionCall('ordinary', 'custom_tool'), {});
    const result = projection.project(functionOutput('ordinary', '{"answers":{}}'), {});
    expect(result.canonical[0].content).toEqual({ answers: {} });
  });

  it('forgets a question when another function reuses its call ID', () => {
    const projection = new LegacyCodexProjection();
    projection.project(functionCall('reused'), {});
    projection.project(functionCall('reused', 'custom_tool'), {});
    const result = projection.project(functionOutput('reused', 'ordinary output'), {});
    expect(result.canonical[0]).toMatchObject({ isError: false, content: { raw: 'ordinary output' } });
  });

  it('bounds unfinished question tracking and preserves recent call pairing', () => {
    const projection = new LegacyCodexProjection();
    for (let index = 0; index <= 10_000; index += 1) projection.project(functionCall(`question-${index}`), {});
    expect(projection.project(functionOutput('question-0', 'failure'), {}).canonical[0].isError).toBe(false);
    expect(projection.project(functionOutput('question-10000', 'failure'), {}).canonical[0].isError).toBe(true);
  });
});

describe('LegacyCodexProjection Code Mode commands', () => {
  it('projects Bash commands and remaps the aggregate result to the final command', () => {
    const projection = new LegacyCodexProjection();
    const input = projection.project(codeModeCall('outer', `
      const results = await Promise.all([
        tools.exec_command({cmd: "git status"}),
        tools.exec_command({cmd: "git diff --stat"}),
      ]);
      results.forEach(result => text(result.output));
    `), {});
    const output = projection.project(codeModeOutput('outer'), {});

    expect(input.canonical).toHaveLength(2);
    expect(input.canonical.every((message) => message instanceof BashToolUseMessage)).toBe(true);
    expect(input.canonical).toMatchObject([
      { toolId: 'codex-code-mode:outer:0', command: 'git status' },
      { toolId: 'codex-code-mode:outer:1', command: 'git diff --stat' },
    ]);
    expect(output.canonical[0]).toBeInstanceOf(ToolResultMessage);
    expect(output.canonical[0]).toMatchObject({
      toolId: 'codex-code-mode:outer:1',
      content: { raw: 'aggregate output' },
      isError: false,
    });
  });

  it('keeps unsupported programs and their results on the outer Exec ID', () => {
    const projection = new LegacyCodexProjection();
    const code = 'const value = await tools.web__run({}); text(value);';
    const input = projection.project(codeModeCall('outer', code), {});
    const output = projection.project(codeModeOutput('outer'), {});

    expect(input.canonical[0]).toBeInstanceOf(ExecToolUseMessage);
    expect(input.canonical[0]).toMatchObject({
      toolId: 'outer',
      code,
      language: 'javascript',
    });
    expect(output.canonical[0]).toMatchObject({ toolId: 'outer' });
  });

  it('does not fabricate results for an unfinished projected call', () => {
    const projection = new LegacyCodexProjection();
    const input = projection.project(codeModeCall(
      'outer',
      'const result = await tools.exec_command({cmd: "pwd"}); text(result.output);',
    ), {});

    expect(input.canonical).toMatchObject([{
      type: 'bash-tool-use',
      toolId: 'codex-code-mode:outer:0',
      command: 'pwd',
    }]);
  });

  it('leaves unrelated outputs unchanged', () => {
    const output = new LegacyCodexProjection().project(codeModeOutput('untracked'), {});

    expect(output.canonical[0]).toMatchObject({
      type: 'tool-result',
      toolId: 'untracked',
    });
  });
});
