import { describe, expect, it } from 'bun:test';
import { CommandOutputMessage, CommandResultMessage, TranscriptNoticeMessage } from '../chat-types.js';
import { projectCommandOutput } from '../command-output-projection.js';

const context = { executorId: 'local', projectPath: '/workspace' };
const at = '2026-01-01T00:00:00.000Z';
const terminal = new CommandResultMessage(at, 'command-1', {
  outcome: 'finished', exitCode: 0, signal: null, capture: 'complete',
  cwd: { kind: 'reported', path: '/workspace' },
});
function stdout(content, offset = 0) {
  return new CommandOutputMessage(at, 'command-1', 'stdout', 'markdown', content, context, offset);
}

describe('shared command output projection', () => {
  it.each(['truncated', 'incomplete'])('renders %s capture literally even at offset zero', capture => {
    const result = new CommandResultMessage(at, 'command-1', { ...terminal.result, capture });
    expect(projectCommandOutput([stdout('# retained'), result]).get(0)?.format).toBe('plain');
  });
  it('does not promote a delivered prefix when a gap precedes the complete native result', () => {
    const gap = new TranscriptNoticeMessage(at, 'Reload native history.', { type: 'publication-gap' }, 'Output not delivered');
    expect(projectCommandOutput([stdout('```text\nprefix'), gap, terminal]).get(0)?.format).toBe('plain');
    expect(projectCommandOutput([gap, stdout('# complete'), terminal]).get(1)?.format).toBe('markdown');
    expect(projectCommandOutput([stdout('# complete'), terminal, gap]).get(0)?.format).toBe('markdown');
  });
  it('preserves complete stdout and separate stderr without copying unchanged records', () => {
    const output = stdout('# complete');
    const error = new CommandOutputMessage(at, 'command-1', 'stderr', 'plain', 'diagnostic', context);
    const result = projectCommandOutput([output, error, terminal]);
    expect([...result.keys()]).toEqual([0, 1]);
    expect(result.get(0)).toBe(output);
    expect(result.get(1)).toBe(error);
  });
  it('keeps duplicate stream records separate and literal without mutating their source', () => {
    const outputs = [stdout('```text\nprefix'), stdout('# suffix', 14)];
    const result = projectCommandOutput([...outputs, terminal]);
    expect([...result.keys()]).toEqual([0, 1]);
    for (const [index, projection] of result) {
      expect(projection).toEqual({ ...outputs[index], format: 'plain' });
      expect(outputs[index].format).toBe('markdown');
    }
  });
  it('requires a unique later result in the loaded window', () => {
    const output = stdout('# heading');
    for (const messages of [[output], [terminal, output], [output, terminal, terminal]]) {
      expect(projectCommandOutput(messages).get(messages.indexOf(output))?.format).toBe('plain');
    }
  });
  it('renders a partial paged tail literally even with a complete result', () => {
    for (const messages of [[stdout('# inside fence', 10)], [stdout('# inside fence', 10), terminal]]) {
      const result = projectCommandOutput(messages);
      for (const [index, projection] of result) {
        expect(projection.format).toBe('plain');
        expect(projection.content).toBe(messages[index].content);
      }
    }
  });
  it('uses capture completeness rather than successful exit', () => {
    const failed = new CommandResultMessage(at, 'command-1', { ...terminal.result, outcome: 'failed', exitCode: 7 });
    expect(projectCommandOutput([stdout('# complete'), failed]).get(0)?.format).toBe('markdown');
  });
  it('never promotes stderr to Markdown', () => {
    const error = new CommandOutputMessage(at, 'command-1', 'stderr', 'markdown', '# diagnostic', context);
    expect(projectCommandOutput([error, terminal]).get(0)?.format).toBe('plain');
  });
  it('correlates gaps and results by command without conflating separate commands', () => {
    const second = new CommandOutputMessage(at, 'command-2', 'stdout', 'markdown', '# second', context);
    const secondResult = new CommandResultMessage(at, 'command-2', terminal.result);
    const gap = new TranscriptNoticeMessage(at, 'Lost output', { type: 'publication-gap' });
    const result = projectCommandOutput([stdout('# first'), gap, second, secondResult, terminal]);
    expect(result.get(0)?.format).toBe('plain');
    expect(result.get(2)).toBe(second);
  });
});
