import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { ChatNativeReloader } from '../chat-native-reload.js';
import { ChatEventLog } from '../chat-event-log.js';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.js';

let tmpDir;
let log;
let nativeSource;
let reloader;
let running;

function user(content) {
  return new UserMessage('2026-06-01T00:00:00.000Z', content);
}

function assistant(content) {
  return new AssistantMessage('2026-06-01T00:00:01.000Z', content);
}

describe('ChatNativeReloader', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-native-reload-test-'));
    running = false;
    log = new ChatEventLog(tmpDir, () => false);
    nativeSource = {
      loadNativeMessages: mock(async () => [user('native prompt'), assistant('native response')]),
    };
    reloader = new ChatNativeReloader(
      log,
      nativeSource,
      () => running,
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('cold-loads native messages when no event log exists', async () => {
    await reloader.ensureColdLoaded('chat-1');

    const page = await log.readPage('chat-1', 10);
    expect(page.events.map((event) => event.message.content)).toEqual([
      'native prompt',
      'native response',
    ]);
    expect(nativeSource.loadNativeMessages).toHaveBeenCalledTimes(1);
  });

  it('skips cold load when an event log already exists', async () => {
    await log.appendMessages('chat-1', [user('existing prompt')], 'submit');

    await reloader.ensureColdLoaded('chat-1');

    expect(nativeSource.loadNativeMessages).not.toHaveBeenCalled();
    const page = await log.readPage('chat-1', 10);
    expect(page.events.map((event) => event.message.content)).toEqual(['existing prompt']);
  });

  it('manual reload replaces the existing generation', async () => {
    const before = await log.appendMessages('chat-1', [user('old')], 'submit');
    const replacement = await reloader.reloadFromNative('chat-1', 'manual-reload');

    expect(replacement.logId).not.toBe(before.logId);
    expect(replacement.mode).toBe('manual-reload');
    expect(replacement.events.map((event) => event.message.content)).toEqual([
      'native prompt',
      'native response',
    ]);
  });

  it('process-error reload includes a non-persisted local notice', async () => {
    const reload = await reloader.reloadFromNative('chat-1', 'process-error');
    expect(reload.localNotice).toBe('The process died.');

    const freshLog = new ChatEventLog(tmpDir, () => false);
    const page = await freshLog.readPage('chat-1', 10);
    expect(page.events.map((event) => event.message.content)).toEqual([
      'native prompt',
      'native response',
    ]);
    expect(page.events.map((event) => event.message.content)).not.toContain('The process died.');
  });

  it('rejects manual reload for running chats', async () => {
    running = true;

    await expect(reloader.reloadFromNative('chat-1', 'manual-reload')).rejects.toThrow(/running/i);
    expect(nativeSource.loadNativeMessages).not.toHaveBeenCalled();
  });

  it('allows process-error reload for running chats', async () => {
    running = true;

    const reload = await reloader.reloadFromNative('chat-1', 'process-error');

    expect(reload.mode).toBe('process-error');
    expect(reload.events.map((event) => event.message.content)).toEqual([
      'native prompt',
      'native response',
    ]);
  });

  it('coalesces concurrent reloads for the same chat', async () => {
    const [first, second] = await Promise.all([
      reloader.reloadFromNative('chat-1', 'manual-reload'),
      reloader.reloadFromNative('chat-1', 'manual-reload'),
    ]);

    expect(first.logId).toBe(second.logId);
    expect(nativeSource.loadNativeMessages).toHaveBeenCalledTimes(1);
  });
});
