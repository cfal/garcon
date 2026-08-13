import { expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { createClaudeNativeActivityProbe } from '../native-activity.ts';

it('reports the newest conversation entry while ignoring Claude housekeeping', async () => {
  await withTranscript([
    {
      type: 'assistant',
      timestamp: '2026-08-12T00:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    },
    { type: 'queue-operation', timestamp: '2026-08-12T00:00:02.000Z' },
  ], async (nativePath) => {
    const { probe, ref } = fixture(nativePath);
    await expect(probe.lastActivity(ref, new AbortController().signal)).resolves.toEqual({
      kind: 'ready',
      value: { lastEntryAt: '2026-08-12T00:00:01.000Z' },
    });
  });
});

function fixture(nativePath) {
  const nativeSessions = createPathNativeSessionCodec('claude');
  return {
    probe: createClaudeNativeActivityProbe(nativeSessions),
    ref: nativeSessions.encode({
      path: nativePath,
      agentSessionId: 'session-1',
      modelEndpointId: null,
    }),
  };
}

async function withTranscript(entries, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'garcon-claude-activity-'));
  const nativePath = path.join(directory, 'session.jsonl');
  await writeFile(nativePath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  try {
    await run(nativePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
