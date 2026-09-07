import { expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { createFactoryNativeActivityProbe } from '../native-activity.ts';

it('reports the newest visible Factory message and ignores hidden messages', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'garcon-factory-activity-'));
  const nativePath = path.join(directory, 'session.jsonl');
  await writeFile(nativePath, [
    JSON.stringify({
      type: 'message',
      timestamp: '2026-08-12T00:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    }),
    JSON.stringify({
      type: 'message',
      timestamp: '2026-08-12T00:00:02.000Z',
      visibility: 'llm_only',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hidden' }] },
    }),
  ].join('\n'));
  try {
    const nativeSessions = createPathNativeSessionCodec('factory');
    const probe = createFactoryNativeActivityProbe(nativeSessions);
    const ref = nativeSessions.encode({
      path: nativePath,
      agentSessionId: 'session-1',
      modelEndpointId: null,
    });
    await expect(probe.lastActivity(ref, new AbortController().signal)).resolves.toEqual({
      kind: 'ready',
      value: { lastEntryAt: '2026-08-12T00:00:01.000Z' },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
