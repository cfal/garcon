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

  it('returns true on successful send', async () => {
    globalThis.fetch = mock(() => Promise.resolve({ ok: true }));
    const notifier = new TelegramNotifier('bot-token');
    const result = await notifier.send('12345', 'test message');
    expect(result).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/botbot-token/sendMessage');
    expect(JSON.parse(opts.body)).toEqual({ chat_id: '12345', text: 'test message' });
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
});
