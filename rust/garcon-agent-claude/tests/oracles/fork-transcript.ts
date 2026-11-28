import { createClaudeForkTranscriptTransformer } from '../../../../server-agents/claude/src/agents/claude/fork-transcript.ts';

const filename = process.argv[2];
let sequence = 0;
const transform = createClaudeForkTranscriptTransformer({
  randomUUID: () => `synthetic-target-${++sequence}`,
  now: () => '2026-07-21T14:00:30.000Z',
});
const result = await transform(await Bun.file(filename).json());
process.stdout.write(JSON.stringify(result));
