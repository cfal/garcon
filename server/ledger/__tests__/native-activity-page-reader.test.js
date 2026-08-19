import { describe, expect, it, mock } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { NativeActivityPageReader } from '../native-activity-page-reader.ts';

describe('NativeActivityPageReader', () => {
  it('[TLV5-L09.03-CORE-UNIT-01] serves a newest page before scheduling its advisory native check', async () => {
    const page = deferred();
    const nativeActivity = { requestCheck: mock(() => new Promise(() => {})) };
    const reader = new NativeActivityPageReader({ page: () => page.promise }, nativeActivity);

    const opened = reader.page('chat-1', 20, undefined, undefined, undefined, 'activation');
    expect(nativeActivity.requestCheck).not.toHaveBeenCalled();
    page.resolve({ transcriptViewId: 'view-1' });

    expect(await opened).toEqual({ transcriptViewId: 'view-1' });
    expect(nativeActivity.requestCheck).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(nativeActivity.requestCheck).toHaveBeenCalledWith('chat-1', 'activation');
  });

  it('[TLV5-L09.03-CORE-UNIT-02] excludes earlier, background, and failed history reads', async () => {
    const nativeActivity = { requestCheck: mock(() => undefined) };
    const pages = {
      page: mock((_chatId, _limit, beforeOrdinal) => beforeOrdinal === undefined
        ? Promise.reject(new Error('open failed'))
        : Promise.resolve({ transcriptViewId: 'view-1' })),
    };
    const reader = new NativeActivityPageReader(pages, nativeActivity);

    await expect(reader.page('chat-1', 20, 10, 'view-1', undefined, 'activation')).resolves.toEqual({
      transcriptViewId: 'view-1',
    });
    await expect(reader.page('chat-1', 20)).rejects.toThrow('open failed');
    await expect(reader.page('chat-1', 20, undefined, undefined, undefined, 'activation'))
      .rejects.toThrow('open failed');
    await Promise.resolve();

    expect(nativeActivity.requestCheck).not.toHaveBeenCalled();
  });

  it('[TLV5-L09.03-CORE-STATIC-01] keeps activation history as the sole production scheduler', async () => {
    const repositoryRoot = path.resolve(import.meta.dir, '../../..');
    const serverRoot = path.join(repositoryRoot, 'server');
    const files = (await readdir(serverRoot, { recursive: true }))
      .filter((file) => (
        file.endsWith('.ts')
        && !file.includes('__tests__')
        && !file.includes('node_modules')
      ))
      .sort();
    const requestCheckCallers = [];

    for (const file of files) {
      const source = await readFile(path.join(serverRoot, file), 'utf8');
      expect(source).not.toContain('pre-resume');
      if (source.includes('.requestCheck(')) requestCheckCallers.push(`server/${file}`);
    }

    expect(requestCheckCallers).toEqual(['server/ledger/native-activity-page-reader.ts']);
  });
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
