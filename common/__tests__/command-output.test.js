import { describe, expect, it } from 'bun:test';
import { CommandOutputMessage, CommandResultMessage, TranscriptNoticeMessage, UserMessage, parseChatMessage } from '../chat-types.ts';
import { extractGarconCommands } from '../garcon-commands.ts';
import { transcriptEntryCategoryForMessage } from '../transcript-entry-categories.ts';
import { commandOutcomeText } from '../command-output.ts';

const timestamp = '2026-01-01T00:00:00.000Z';
const context = { executorId: 'local', projectPath: '/workspace/project' };
const result = { outcome: 'failed', exitCode: 3, signal: null,
  cwd: { kind: 'reported', path: '/workspace/project' }, capture: 'complete' };

describe('retained command content', () => {
  it('roundtrips structured publication gaps', () => {
    const notice = new TranscriptNoticeMessage(timestamp, 'Reload native history.', { type: 'publication-gap' }, 'Output not delivered');
    expect(parseChatMessage(JSON.parse(JSON.stringify(notice)))).toEqual(notice);
  });
  for (const message of [
    new UserMessage(timestamp, '  echo test\n', undefined, { contentMode: 'literal' }),
    new CommandOutputMessage(timestamp, 'command-1', 'stdout', 'markdown', '<garcon-get-chat-id />', context),
    new CommandOutputMessage(timestamp, 'command-1', 'stderr', 'plain', 'failure\n', context),
    new CommandResultMessage(timestamp, 'command-1', result),
    new CommandResultMessage(timestamp, 'command-truncated', { ...result, outcome: 'finished', exitCode: 0, capture: 'truncated' }),
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
    for (const offset of [-1, 0.5, '0', null, undefined]) {
      expect(parseChatMessage({ ...output, offset })).toBeNull();
    }
  });

  it('validates outcomes and derives status text from facts', () => {
    const message = new CommandResultMessage(timestamp, 'command-1', result);
    expect(message.content).toBe('Exit 3');
    expect(parseChatMessage({ ...message, result: { ...result, outcome: 'invalid' } })).toBeNull();
    expect(parseChatMessage({ ...message, result: { ...result, outcome: ['finished'] } })).toBeNull();
    expect(parseChatMessage({ ...message, result: { ...result, exitCode: -1 } })).toBeNull();
    expect(parseChatMessage({ ...message, result: { ...result, cwd: { kind: 'reported', path: 'relative' } } })).toBeNull();
  });

  it.each([
    ['finished', 0, 'Completed'],
    ['interrupted', null, 'Interrupted'],
    ['unknown', null, 'Outcome unknown'],
    ['failed', 3, 'Exit 3'],
    ['failed', 0, 'Exit 0'],
    ['failed', null, 'Command failed'],
  ])('preserves the %s status label for exit code %s', (outcome, exitCode, expected) => {
    expect(commandOutcomeText({ ...result, outcome, exitCode })).toBe(expected);
  });

  it('appends signal, capture and cwd diagnostics in their original order', () => {
    expect(commandOutcomeText({
      ...result,
      signal: 'SIGTERM',
      capture: 'incomplete',
      cwd: { kind: 'unavailable', reason: 'Synthetic missing report' },
    })).toBe('Exit 3\nSignal: SIGTERM\nOutput capture incomplete\nWorking directory not captured: Synthetic missing report');
  });

  it('distinguishes successful tail retention from capture failure', () => {
    expect(commandOutcomeText({ ...result, outcome: 'finished', exitCode: 0, capture: 'truncated' }))
      .toBe('Completed\nOutput truncated');
  });
});
