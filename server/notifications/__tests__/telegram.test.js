import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { TelegramNotifier } from '../../notifications/telegram.js';

describe('TelegramNotifier', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns false when botToken is empty', async () => {
    const notifier = new TelegramNotifier('');
    const result = await notifier.send('123', 'hello');
    expect(result).toBe(false);
  });

  it('returns false when chatId is empty', async () => {
    const notifier = new TelegramNotifier('bot-token');
    const result = await notifier.send('', 'hello');
    expect(result).toBe(false);
  });

  it('isConfigured returns false when no token', () => {
    const notifier = new TelegramNotifier('');
    expect(notifier.isConfigured).toBe(false);
  });

  it('isConfigured returns true when token is set', () => {
    const notifier = new TelegramNotifier('some-token');
    expect(notifier.isConfigured).toBe(true);
  });

  it('updates configured status when token changes', () => {
    const notifier = new TelegramNotifier('');
    notifier.setBotToken('some-token');
    expect(notifier.isConfigured).toBe(true);
    notifier.setBotToken('');
    expect(notifier.isConfigured).toBe(false);
  });

  it('returns true on successful send', async () => {
    globalThis.fetch = mock(() => Promise.resolve({ ok: true }));
    const notifier = new TelegramNotifier('bot-token');
    const result = await notifier.send('12345', 'test message');
    expect(result).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/botbot-token/sendMessage');
    expect(JSON.parse(opts.body)).toEqual({ chat_id: '12345', text: 'test message' });
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns false on HTTP error', async () => {
    globalThis.fetch = mock(() => Promise.resolve({
      ok: false,
      status: 400,
      text: () => Promise.resolve('Bad Request'),
    }));
    const notifier = new TelegramNotifier('bot-token');
    const result = await notifier.send('12345', 'test');
    expect(result).toBe(false);
  });

  it('returns false on network error', async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error('network down')));
    const notifier = new TelegramNotifier('bot-token');
    const result = await notifier.send('12345', 'test');
    expect(result).toBe(false);
  });

  it('gets bot identity from getMe', async () => {
    globalThis.fetch = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        result: { id: 123, username: 'Garcon_Bot', first_name: 'Garcon' },
      }),
    }));
    const notifier = new TelegramNotifier('bot-token');

    const identity = await notifier.getBotIdentity();

    expect(identity).toEqual({ id: 123, username: 'garcon_bot', firstName: 'Garcon' });
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/botbot-token/getMe');
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('resolves recipient link by matching /start code in a private chat without requiring a username', async () => {
    globalThis.fetch = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        result: [
          {
            update_id: 10,
            message: {
              text: '/start wrong',
              from: { username: 'alice', first_name: 'Alice' },
              chat: { id: 99999, type: 'private' },
            },
          },
          {
            update_id: 11,
            message: {
              text: '/start abc123',
              from: { username: 'Mallory', first_name: 'Mallory' },
              chat: { id: -1001, type: 'group', title: 'Group' },
            },
          },
          {
            update_id: 12,
            message: {
              text: '/start abc123',
              from: { first_name: 'Alice' },
              chat: { id: 99999, type: 'private' },
            },
          },
        ],
      }),
    }));
    const notifier = new TelegramNotifier('bot-token');

    const result = await notifier.resolveRecipientLink('abc123', null, 0);

    expect(result.nextOffset).toBe(13);
    expect(result.recipient).toEqual({
      chatId: '99999',
      username: null,
      displayName: 'Alice',
      nextOffset: 13,
    });
    const [, opts] = globalThis.fetch.mock.calls[0];
    expect(opts.signal).toBeUndefined();
  });
});
