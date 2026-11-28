import { expect, test } from 'bun:test';
import type { ClaudeCLIMessage } from '../../../../server-agents/claude/src/agents/claude/cli-protocol.ts';
import { convertCliStreamFrame } from './cli-stream.ts';

const capturedInputs = await Bun.file(new URL('../inputs/cli-stream.jsonl', import.meta.url)).text();

test('projects the frames captured from the original converter tests', () => {
  for (const line of capturedInputs.trimEnd().split('\n')) {
    const { args: [frame] } = JSON.parse(line) as { args: [ClaudeCLIMessage] };
    expect(convertCliStreamFrame(frame)).toBeArray();
  }
});
