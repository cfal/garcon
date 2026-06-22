import { describe, expect, it, mock } from 'bun:test';
import { ChatNativeReloader } from '../chat-native-reload.js';
import { ChatViewStore } from '../chat-view-store.js';
import { AssistantMessage, ErrorMessage, UserMessage } from '../../../common/chat-types.js';

const TS = '2026-06-01T00:00:00.000Z';

function user(content) {
  return new UserMessage(TS, content);
}

function assistant(content) {
  return new AssistantMessage(TS, content);
}

function contents(page) {
  return page.messages.map((entry) => entry.message.content);
}

describe('ChatNativeReloader', () => {
  it('manual reload replaces the existing generation', async () => {
    const views = new ChatViewStore(() => false);
    const nativeSource = {
      loadNativeMessages: mock(async () => [user('native prompt'), assistant('native response')]),
    };
    const reloader = new ChatNativeReloader(views, nativeSource, () => false);
    const before = await views.appendAfterEnsuringGeneration('chat-1', async () => [], [user('old')]);

    const replacement = await reloader.reloadFromNative('chat-1', 'manual-reload');

    expect(replacement.generationId).not.toBe(before.generationId);
    expect(replacement.mode).toBe('manual-reload');
    expect(contents(replacement)).toEqual(['native prompt', 'native response']);
    expect(nativeSource.loadNativeMessages).toHaveBeenCalledWith('chat-1');
  });

  it('process-error reload appends a normal in-memory error row', async () => {
    const views = new ChatViewStore(() => false);
    const nativeSource = {
      loadNativeMessages: mock(async () => [user('native prompt'), assistant('native response')]),
    };
    const reloader = new ChatNativeReloader(views, nativeSource, () => false);

    const reload = await reloader.reloadFromNative('chat-1', 'process-error');
    const warmPage = views.readPage('chat-1', 20);

    expect(reload.mode).toBe('process-error');
    expect(contents(reload)).toEqual(['native prompt', 'native response', 'The process died.']);
    expect(warmPage.messages[2].message).toBeInstanceOf(ErrorMessage);
  });

  it('rejects manual reload for running chats', async () => {
    const nativeSource = { loadNativeMessages: mock(async () => [assistant('native')]) };
    const reloader = new ChatNativeReloader(new ChatViewStore(() => true), nativeSource, () => true);

    await expect(reloader.reloadFromNative('chat-1', 'manual-reload')).rejects.toThrow(/running/i);
    expect(nativeSource.loadNativeMessages).not.toHaveBeenCalled();
  });

  it('allows process-error reload for running chats', async () => {
    const nativeSource = { loadNativeMessages: mock(async () => [assistant('native')]) };
    const reloader = new ChatNativeReloader(new ChatViewStore(() => true), nativeSource, () => true);

    const reload = await reloader.reloadFromNative('chat-1', 'process-error');

    expect(reload.mode).toBe('process-error');
    expect(contents(reload)).toEqual(['native', 'The process died.']);
  });

  it('coalesces concurrent reloads for the same chat', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const nativeSource = {
      loadNativeMessages: mock(async () => {
        await gate;
        return [assistant('native')];
      }),
    };
    const reloader = new ChatNativeReloader(new ChatViewStore(() => false), nativeSource, () => false);

    const firstPromise = reloader.reloadFromNative('chat-1', 'manual-reload');
    const secondPromise = reloader.reloadFromNative('chat-1', 'manual-reload');
    release();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.generationId).toBe(second.generationId);
    expect(nativeSource.loadNativeMessages).toHaveBeenCalledTimes(1);
  });

  it('does not coalesce process-error reloads behind manual reloads', async () => {
    let releaseManual;
    const manualGate = new Promise((resolve) => {
      releaseManual = resolve;
    });
    let calls = 0;
    const nativeSource = {
      loadNativeMessages: mock(async () => {
        calls += 1;
        if (calls === 1) {
          await manualGate;
          return [assistant('manual native')];
        }
        return [assistant('process native')];
      }),
    };
    const reloader = new ChatNativeReloader(new ChatViewStore(() => false), nativeSource, () => false);

    const manualPromise = reloader.reloadFromNative('chat-1', 'manual-reload');
    const processPromise = reloader.reloadFromNative('chat-1', 'process-error');
    releaseManual();
    const [manual, process] = await Promise.all([manualPromise, processPromise]);

    expect(manual.mode).toBe('manual-reload');
    expect(process.mode).toBe('process-error');
    expect(manual.generationId).not.toBe(process.generationId);
    expect(contents(manual)).toEqual(['manual native']);
    expect(contents(process)).toEqual(['process native', 'The process died.']);
    expect(nativeSource.loadNativeMessages).toHaveBeenCalledTimes(2);
  });

  it('does not coalesce manual reloads behind process-error reloads', async () => {
    let releaseProcess;
    const processGate = new Promise((resolve) => {
      releaseProcess = resolve;
    });
    let calls = 0;
    const nativeSource = {
      loadNativeMessages: mock(async () => {
        calls += 1;
        if (calls === 1) {
          await processGate;
          return [assistant('process native')];
        }
        return [assistant('manual native')];
      }),
    };
    const reloader = new ChatNativeReloader(new ChatViewStore(() => false), nativeSource, () => false);

    const processPromise = reloader.reloadFromNative('chat-1', 'process-error');
    const manualPromise = reloader.reloadFromNative('chat-1', 'manual-reload');
    releaseProcess();
    const [process, manual] = await Promise.all([processPromise, manualPromise]);

    expect(process.mode).toBe('process-error');
    expect(manual.mode).toBe('manual-reload');
    expect(process.generationId).not.toBe(manual.generationId);
    expect(contents(process)).toEqual(['process native', 'The process died.']);
    expect(contents(manual)).toEqual(['manual native']);
    expect(nativeSource.loadNativeMessages).toHaveBeenCalledTimes(2);
  });
});
