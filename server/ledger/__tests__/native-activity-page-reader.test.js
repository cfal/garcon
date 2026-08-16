import { describe, expect, it, mock } from 'bun:test';
import { NativeActivityPageReader } from '../native-activity-page-reader.ts';

describe('NativeActivityPageReader', () => {
  it('[TLV5-L09.03-CORE-UNIT-01] serves a newest page before scheduling its advisory native check', async () => {
    const page = deferred();
    const nativeActivity = { requestCheck: mock(() => new Promise(() => {})) };
    const reader = new NativeActivityPageReader({ page: () => page.promise }, nativeActivity);

    const opened = reader.page('chat-1', 20);
    expect(nativeActivity.requestCheck).not.toHaveBeenCalled();
    page.resolve({ transcriptViewId: 'view-1' });

    expect(await opened).toEqual({ transcriptViewId: 'view-1' });
    expect(nativeActivity.requestCheck).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(nativeActivity.requestCheck).toHaveBeenCalledWith('chat-1', 'open');
  });

  it('does not schedule open checks for earlier pages or failed opens', async () => {
    const nativeActivity = { requestCheck: mock(() => undefined) };
    const pages = {
      page: mock((_chatId, _limit, beforeOrdinal) => beforeOrdinal === undefined
        ? Promise.reject(new Error('open failed'))
        : Promise.resolve({ transcriptViewId: 'view-1' })),
    };
    const reader = new NativeActivityPageReader(pages, nativeActivity);

    await expect(reader.page('chat-1', 20, 10)).resolves.toEqual({
      transcriptViewId: 'view-1',
    });
    await expect(reader.page('chat-1', 20)).rejects.toThrow('open failed');
    await Promise.resolve();

    expect(nativeActivity.requestCheck).not.toHaveBeenCalled();
  });
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
