import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPathNativeSessionCodec } from '../path-native-session.js';
import { createJsonlNativeActivityProbe } from '../jsonl-activity.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('createJsonlNativeActivityProbe', () => {
  it('reads the newest relevant timestamp from a bounded tail', async () => {
    const nativePath = await fixture([
      { type: 'message', timestamp: '2026-08-12T00:00:01.000Z' },
      { type: 'housekeeping', timestamp: '2026-08-12T00:00:02.000Z' },
      { type: 'message', timestamp: '2026-08-12T00:00:03.000Z' },
    ]);
    const probe = createProbe(nativePath);

    await expect(probe.lastActivity(reference(nativePath), new AbortController().signal))
      .resolves.toEqual({
        kind: 'ready',
        value: { lastEntryAt: '2026-08-12T00:00:03.000Z' },
      });
  });

  it('returns unavailable when the bounded slice cannot prove the tail', async () => {
    const nativePath = await fixture([
      { type: 'message', timestamp: '2026-08-12T00:00:01.000Z' },
      { type: 'housekeeping', padding: 'x'.repeat(512) },
    ]);
    const probe = createProbe(nativePath, 64);

    await expect(probe.lastActivity(reference(nativePath), new AbortController().signal))
      .resolves.toEqual({ kind: 'unavailable' });
  });

  it('returns unavailable for a relevant entry without a valid creation timestamp', async () => {
    const nativePath = await fixture([{ type: 'message', timestamp: 'not-a-date' }]);
    const probe = createProbe(nativePath);

    await expect(probe.lastActivity(reference(nativePath), new AbortController().signal))
      .resolves.toEqual({ kind: 'unavailable' });
  });
});

function createProbe(nativePath: string, maxTailBytes?: number) {
  const nativeSessions = createPathNativeSessionCodec('test');
  return createJsonlNativeActivityProbe({
    nativeSessions,
    ...(maxTailBytes ? { maxTailBytes } : {}),
    activityTimestamp(entry) {
      const value = entry as { type?: unknown; timestamp?: unknown };
      if (value.type !== 'message') return undefined;
      return typeof value.timestamp === 'string' ? value.timestamp : null;
    },
  });
}

function reference(nativePath: string) {
  return createPathNativeSessionCodec('test').encode({
    path: nativePath,
    agentSessionId: 'session-1',
    modelEndpointId: null,
  })!;
}

async function fixture(entries: readonly unknown[]): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'garcon-jsonl-activity-'));
  directories.push(directory);
  const nativePath = path.join(directory, 'session.jsonl');
  await writeFile(nativePath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  return nativePath;
}
