import { expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { createCodexNativeActivityProbe } from '../native-activity.ts';

it('reports the newest conversation entry while ignoring Codex turn bookkeeping', async () => {
  await withTranscript([
    {
      type: 'response_item',
      timestamp: '2026-08-12T00:00:01.000Z',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'answer' }],
      },
    },
    { type: 'turn_context', timestamp: '2026-08-12T00:00:02.000Z', payload: {} },
  ], async (nativePath) => {
    const nativeSessions = createPathNativeSessionCodec('codex');
    const probe = createCodexNativeActivityProbe(nativeSessions);
    const ref = nativeSessions.encode({
      path: nativePath,
      agentSessionId: 'session-1',
      modelEndpointId: null,
    });
    await expect(probe.lastActivity(ref, new AbortController().signal)).resolves.toEqual({
      kind: 'ready',
      value: { lastEntryAt: '2026-08-12T00:00:01.000Z' },
    });
  });
});

async function withTranscript(entries, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'garcon-codex-activity-'));
  const nativePath = path.join(directory, 'rollout.jsonl');
  await writeFile(nativePath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  try {
    await run(nativePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
