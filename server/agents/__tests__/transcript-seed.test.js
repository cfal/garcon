import { describe, expect, test } from 'bun:test';
import { UserMessage } from '@garcon/common/chat-types';
import {
  renderTranscriptSeed,
  stripFirstUserSeed,
  stripTranscriptSeed,
} from '@garcon/common/transcript-seed';

describe('transcript seed contract', () => {
  test('strips the persisted seed format and preserves the real prompt', () => {
    const seed = renderTranscriptSeed([
      new UserMessage('2026-01-01T00:00:00.000Z', 'prior question'),
    ]);
    expect(stripTranscriptSeed(`${seed}\n\nnew prompt`)).toBe('new prompt');
    expect(stripFirstUserSeed([
      new UserMessage('2026-01-01T00:00:00.000Z', `${seed}\n\nnew prompt`),
    ])[0].content).toBe('new prompt');
  });

  test('does not strip unrelated delimiter text', () => {
    expect(stripTranscriptSeed(`keep this\n<carried-context>old</carried-context>`))
      .toContain('keep this');
  });
});
