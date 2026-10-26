import { describe, expect, test } from 'bun:test';
import { ClaudeMonitorToolUseMessage, ClaudeToolSearchToolUseMessage, CommandOutputMessage, CommandResultMessage, PiToolSearchToolUseMessage, UserMessage } from '@garcon/common/chat-types';
import { projectSearchMessage } from '../message-projector.js';
import { SEARCH_TIMESTAMP_MAX_BYTES } from '../schema.js';
import type { CommandOutcome } from '@garcon/common/command-output';

const complete: CommandOutcome = {
  outcome: 'finished', exitCode: 0, signal: null, capture: 'complete',
  cwd: { kind: 'reported', path: '/synthetic/project' },
};

describe('transcript search message projector', () => {
  test('omits only clean command completion without filtering authored content', () => {
    expect(projectSearchMessage(new CommandResultMessage('', 'command', complete))).toBeNull();
    expect(projectSearchMessage(new UserMessage('', 'Completed'))).toMatchObject({ body: 'Completed' });
    expect(projectSearchMessage(new CommandOutputMessage('', 'command', 'stdout', 'plain', 'Completed',
      { executorId: 'local', projectPath: '/synthetic/project' }))).toMatchObject({ body: 'Completed' });
    const diagnostics: Partial<CommandOutcome>[] = [
      { outcome: 'failed', exitCode: 7 }, { outcome: 'interrupted' }, { outcome: 'unknown' },
      { signal: 'SIGTERM' }, { exitCode: null }, { exitCode: 1 },
      { capture: 'incomplete' }, { capture: 'truncated' },
      { cwd: { kind: 'unavailable', reason: 'Synthetic cwd failure' } },
    ];
    for (const diagnostic of diagnostics) {
      const result = new CommandResultMessage('', 'command', { ...complete, ...diagnostic });
      expect(projectSearchMessage(result)).toMatchObject({ role: 'system', body: result.content.replaceAll('\n', ' ') });
    }
  });

  test('indexes retained command streams and outcomes with their semantic roles', () => {
    for (const channel of ['stdout', 'stderr'] as const) {
      const output = new CommandOutputMessage('', 'command', channel, 'plain', '<garcon-get-chat-id />',
        { executorId: 'local', projectPath: '/synthetic/project' });
      expect(projectSearchMessage(output)).toMatchObject({
        role: channel === 'stdout' ? 'assistant' : 'system', body: '<garcon-get-chat-id />',
      });
    }
    const result = new CommandResultMessage('', 'command', {
      outcome: 'failed', exitCode: 7, signal: null, capture: 'incomplete',
      cwd: { kind: 'reported', path: '/synthetic/project' },
    });
    expect(projectSearchMessage(result)).toMatchObject({ role: 'system', body: 'Exit 7 Output capture incomplete' });
  });

  test('indexes Pi tool discovery queries', () => {
    expect(projectSearchMessage(new PiToolSearchToolUseMessage('', 'search', 'issue tools', 3)))
      .toMatchObject({ role: 'tool', body: 'issue tools' });
  });

  test('indexes typed Claude discovery and Monitor parameters', () => {
    expect(projectSearchMessage(new ClaudeToolSearchToolUseMessage('', 'search', 'select:Monitor', 1)))
      .toMatchObject({ role: 'tool', body: 'select:Monitor' });
    const projection = projectSearchMessage(new ClaudeMonitorToolUseMessage('', 'monitor', 'Synthetic watch', 300_000,
      'printf synthetic', 'ws://synthetic.invalid/events', ['synthetic-events']));
    expect(projection?.body).toContain('Synthetic watch');
    expect(projection?.body).toContain('printf synthetic');
    expect(projection?.body).toContain('ws://synthetic.invalid/events');
    expect(projection?.body).toContain('synthetic-events');
  });

  test('[TLV5-SEARCH.07-PROJECT-01] bounds provider timestamps without dropping content', () => {
    const boundary = 'é'.repeat(SEARCH_TIMESTAMP_MAX_BYTES / 2);
    expect(projectSearchMessage(new UserMessage(boundary, 'synthetic body')))
      .toMatchObject({ timestamp: boundary, body: 'synthetic body' });
    expect(projectSearchMessage(new UserMessage(`${boundary}x`, 'synthetic body')))
      .toMatchObject({ timestamp: null, body: 'synthetic body' });
  });
});
