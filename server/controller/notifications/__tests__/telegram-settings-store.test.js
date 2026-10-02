import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { CorruptStateFileError, QUARANTINE_INFIX } from '../../../common/json-file-store.ts';
import { TelegramSettingsStore } from '../telegram-settings-store.ts';

describe('TelegramSettingsStore', () => {
  let tmpDir;
  let filePath;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `garcon-telegram-settings-${randomUUID()}`);
    filePath = path.join(tmpDir, 'notifications.json');
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('persists the bot token without exposing it through remote settings', async () => {
    const store = new TelegramSettingsStore(filePath);
    await store.init();

    expect(store.isConfigured).toBe(false);

    await store.setBotToken('  bot-token  ', { id: 123, username: 'Garcon_Bot', firstName: 'Garcon' });
    expect(store.isConfigured).toBe(true);
    expect(store.getBotToken()).toBe('bot-token');
    expect(store.getPublicStatus()).toEqual({
      botTokenAvailable: true,
      botUsername: 'garcon_bot',
      botFirstName: 'Garcon',
      recipientUsername: null,
      recipientDisplayName: null,
      recipientLinked: false,
      pendingLink: false,
      linkUrl: null,
    });

    const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(raw.telegram.botToken).toBe('bot-token');
    expect(raw.telegram.botUsername).toBe('garcon_bot');
  });

  it('does not publish Telegram mutations that fail to persist', async () => {
    const store = new TelegramSettingsStore(filePath);
    await store.init();
    const rename = spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk full'));

    try {
      await expect(store.setBotToken(
        'bot-token',
        { id: 123, username: 'garcon_bot', firstName: 'Garcon' },
      )).rejects.toThrow('disk full');
    } finally {
      rename.mockRestore();
    }

    expect(store.isConfigured).toBe(false);
    expect(store.getBotToken()).toBe('');
    expect(store.getPublicStatus().botTokenAvailable).toBe(false);
  });

  it('quarantines corrupt settings without overwriting the bot token', async () => {
    const corruptBytes = '{"version":2,"telegram":{"botToken":"bot-secret"}}';
    await fs.writeFile(filePath, corruptBytes, { mode: 0o600 });

    await expect(new TelegramSettingsStore(filePath).init()).rejects.toBeInstanceOf(CorruptStateFileError);

    const [quarantineName] = (await fs.readdir(tmpDir)).filter((entry) =>
      entry.startsWith(`notifications.json${QUARANTINE_INFIX}`));
    expect(await fs.readFile(path.join(tmpDir, quarantineName), 'utf8')).toBe(corruptBytes);
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('clears all Telegram settings with the bot token', async () => {
    const store = new TelegramSettingsStore(filePath);
    await store.init();
    let changes = 0;
    store.onChanged(() => { changes += 1; });

    await store.setBotToken('bot-token', { id: 123, username: 'garcon_bot', firstName: 'Garcon' });
    await store.beginRecipientLink();
    await store.applyRecipientLinkResult(store.getPendingRecipientLink(), { nextOffset: 12, recipient: {
      chatId: '99999',
      username: 'alice',
      displayName: 'Alice',
      nextOffset: 12,
    } });
    await store.clearBotToken();

    expect(changes).toBe(4);
    expect(store.isConfigured).toBe(false);
    expect(store.getBotToken()).toBe('');
    expect(store.getRecipientChatId()).toBe('');
    expect(store.getPendingRecipientLink()).toBeNull();
    expect(JSON.parse(await fs.readFile(filePath, 'utf8')).telegram.updateOffset).toBeNull();
    expect(store.getPublicStatus()).toEqual({
      botTokenAvailable: false,
      botUsername: null,
      botFirstName: null,
      recipientUsername: null,
      recipientDisplayName: null,
      recipientLinked: false,
      pendingLink: false,
      linkUrl: null,
    });
  });

  it('creates and completes a one-time recipient link', async () => {
    const store = new TelegramSettingsStore(filePath);
    await store.init();
    await store.setBotToken('bot-token', { id: 123, username: 'garcon_bot', firstName: 'Garcon' });

    const linkUrl = await store.beginRecipientLink();
    expect(linkUrl).toMatch(/^https:\/\/t\.me\/garcon_bot\?start=/);
    expect(store.getPublicStatus().pendingLink).toBe(true);

    await store.applyRecipientLinkResult(store.getPendingRecipientLink(), { nextOffset: 45, recipient: {
      chatId: '99999',
      username: 'alice',
      displayName: 'Alice A.',
      nextOffset: 45,
    } });

    expect(store.getRecipientChatId()).toBe('99999');
    expect(JSON.parse(await fs.readFile(filePath, 'utf8')).telegram.updateOffset).toBe(45);
    expect(store.getPublicStatus()).toMatchObject({
      recipientUsername: 'alice',
      recipientDisplayName: 'Alice A.',
      recipientLinked: true,
      pendingLink: false,
      linkUrl: null,
    });
  });

  it('applies offsets monotonically and publishes a recipient and offset in one durable write', async () => {
    const store = new TelegramSettingsStore(filePath);
    await store.init();
    await store.setBotToken('bot-token', { id: 123, username: 'garcon_bot', firstName: 'Garcon' });
    await store.beginRecipientLink();
    const expected = store.getPendingRecipientLink();
    expect(await store.applyRecipientLinkResult(expected, { nextOffset: 50, recipient: null })).toBe(true);
    expect(await store.applyRecipientLinkResult(expected, { nextOffset: 20, recipient: null })).toBe(true);
    expect(store.getPendingRecipientLink().offset).toBe(50);
    const result = { nextOffset: 30, recipient: { chatId: '123', username: 'user', displayName: 'User', nextOffset: 30 } };
    const rename = spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk full'));
    try {
      await expect(store.applyRecipientLinkResult(expected, result)).rejects.toThrow('disk full');
      expect(store.getPublicStatus().recipientLinked).toBe(false);
      expect(store.getPendingRecipientLink().offset).toBe(50);
    } finally {
      rename.mockRestore();
    }
    expect(await store.applyRecipientLinkResult(expected, result)).toBe(true);
    const raw = JSON.parse(await fs.readFile(filePath, 'utf8')).telegram;
    expect(raw).toMatchObject({ chatId: '123', updateOffset: 50, pendingLinkCode: '' });
    expect(await store.applyRecipientLinkResult(expected, result)).toBe(false);
  });

  it('rejects results after link expiry without changing persisted state', async () => {
    const store = new TelegramSettingsStore(filePath);
    await store.init();
    await store.setBotToken('bot-token', { id: 123, username: 'garcon_bot', firstName: 'Garcon' });
    await store.beginRecipientLink();
    const expected = store.getPendingRecipientLink();
    const before = await fs.readFile(filePath, 'utf8');
    const now = Date.now();
    const clock = spyOn(Date, 'now').mockReturnValue(now + 11 * 60 * 1000);
    try {
      expect(await store.applyRecipientLinkResult(expected, { nextOffset: 100, recipient: null })).toBe(false);
      expect(await fs.readFile(filePath, 'utf8')).toBe(before);
    } finally {
      clock.mockRestore();
    }
  });
});
