import { describe, expect, it } from 'bun:test';
import { CommandOutputMessage, CommandResultMessage, UserMessage, parseChatMessage } from '../chat-types.ts';
import { extractGarconCommands } from '../garcon-commands.ts';
import { transcriptEntryCategoryForMessage } from '../transcript-entry-categories.ts';

const timestamp = '2026-01-01T00:00:00.000Z';
const context = { executorId: 'local', projectPath: '/workspace/project' };
const result = { outcome: 'failed', exitCode: 3, signal: null,
  cwd: { kind: 'reported', path: '/workspace/project' }, capture: 'complete' };

describe('retained command content', () => {
  for (const message of [
    new UserMessage(timestamp, '  echo test\n', undefined, { contentMode: 'literal' }),
    new CommandOutputMessage(timestamp, 'command-1', 'stdout', 'markdown', '<garcon-get-chat-id />', context),
    new CommandOutputMessage(timestamp, 'command-1', 'stderr', 'plain', 'failure\n', context),
    new CommandResultMessage(timestamp, 'command-1', result),
  ]) {
    it(`roundtrips ${message.type} without interpreting content`, () => {
      const parsed = parseChatMessage(JSON.parse(JSON.stringify(message)));
      expect(parsed).toEqual(message);
      expect(extractGarconCommands(parsed)).toBeNull();
      expect(transcriptEntryCategoryForMessage(parsed)).toBe('conversation');
    });
  }

  it('rejects malformed output instead of degrading to assistant text', () => {
    const output = new CommandOutputMessage(timestamp, 'command-1', 'stderr', 'plain', 'text', context);
    expect(parseChatMessage({ ...output, format: 'markdown' })).toBeNull();
    expect(parseChatMessage({ ...output, context: null })).toBeNull();
    expect(parseChatMessage({ ...output, commandId: '' })).toBeNull();
    expect(parseChatMessage({ ...output, channel: 'control' })).toBeNull();
  });

  it('validates outcomes and derives status text from facts', () => {
    const message = new CommandResultMessage(timestamp, 'command-1', result);
    expect(message.content).toBe('Exit 3');
    expect(parseChatMessage({ ...message, result: { ...result, outcome: 'invalid' } })).toBeNull();
    expect(parseChatMessage({ ...message, result: { ...result, exitCode: -1 } })).toBeNull();
    expect(parseChatMessage({ ...message, result: { ...result, cwd: { kind: 'reported', path: 'relative' } } })).toBeNull();
  });
});
