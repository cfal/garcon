import { expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { createPiNativeActivityProbe } from '../native-activity.ts';

it('reports the newest rendered Pi session entry rather than the session header', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'garcon-pi-activity-'));
  const nativePath = path.join(directory, 'session.jsonl');
  await writeFile(nativePath, [
    JSON.stringify({ type: 'session', timestamp: '2026-08-12T00:00:02.000Z' }),
    JSON.stringify({
      type: 'message',
      timestamp: '2026-08-12T00:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    }),
  ].join('\n'));
  try {
    const nativeSessions = createPathNativeSessionCodec('pi');
    const probe = createPiNativeActivityProbe(nativeSessions);
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

it.each([
  ['aborted tool output', { role: 'toolResult', toolCallId: 'call-1', isError: true,
    content: [{ type: 'text', text: 'Operation aborted' }] }, true],
  ['partial aborted assistant output', { role: 'assistant', stopReason: 'aborted',
    content: [{ type: 'text', text: 'partial answer' }] }, true],
  ['empty aborted assistant output', { role: 'assistant', stopReason: 'aborted',
    content: [{ type: 'text', text: '' }] }, false],
])('preserves native drift evidence for %s', async (_label, message, rendered) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'garcon-pi-aborted-activity-'));
  const nativePath = path.join(directory, 'session.jsonl');
  const baselineAt = '2026-08-12T00:00:01.000Z';
  const abortedAt = '2026-08-12T00:00:02.000Z';
  try {
    await writeFile(nativePath, [
      JSON.stringify({ type: 'message', timestamp: baselineAt,
        message: { role: 'assistant', content: [{ type: 'text', text: 'baseline' }] } }),
      JSON.stringify({ type: 'message', timestamp: abortedAt, message }),
    ].join('\n'));
    const nativeSessions = createPathNativeSessionCodec('pi');
    const probe = createPiNativeActivityProbe(nativeSessions);
    const ref = nativeSessions.encode({ path: nativePath, agentSessionId: 'session-1', modelEndpointId: null });
    await expect(probe.lastActivity(ref, new AbortController().signal)).resolves.toEqual({
      kind: 'ready', value: { lastEntryAt: rendered ? abortedAt : baselineAt },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
