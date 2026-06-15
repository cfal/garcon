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
});
