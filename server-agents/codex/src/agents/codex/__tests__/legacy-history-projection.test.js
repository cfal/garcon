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
