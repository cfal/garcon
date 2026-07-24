import { describe, expect, it } from 'bun:test';
import { createCodexForkTargetPath } from '../fork-target-path.ts';

describe('createCodexForkTargetPath', () => {
  it('creates a canonical UTC rollout filename beside the source', () => {
    expect(
      createCodexForkTargetPath({
        sourcePath: '/home/me/.codex/sessions/2026/07/23/rollout-source.jsonl',
        targetAgentSessionId: 'ec12a984-cbd3-4b3b-9203-9377c3ec665e',
        createdAt: new Date('2026-07-24T11:26:22.999Z'),
      }),
    ).toBe(
      '/home/me/.codex/sessions/2026/07/23/' +
        'rollout-2026-07-24T11-26-22-ec12a984-cbd3-4b3b-9203-9377c3ec665e.jsonl',
    );
  });

  it('rejects an invalid creation time', () => {
    expect(() =>
      createCodexForkTargetPath({
        sourcePath: '/tmp/source.jsonl',
        targetAgentSessionId: 'ec12a984-cbd3-4b3b-9203-9377c3ec665e',
        createdAt: new Date(Number.NaN),
      }),
    ).toThrow('valid date');
  });
});
