import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
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

  it('clears all Telegram settings with the bot token', async () => {
    const store = new TelegramSettingsStore(filePath);
    await store.init();
    let changes = 0;
    store.onChanged(() => { changes += 1; });

    await store.setBotToken('bot-token', { id: 123, username: 'garcon_bot', firstName: 'Garcon' });
    await store.beginRecipientLink();
    await store.completeRecipientLink({
      chatId: '99999',
      username: 'alice',
      displayName: 'Alice',
      nextOffset: 12,
    });
    await store.clearBotToken();

    expect(changes).toBe(4);
    expect(store.isConfigured).toBe(false);
    expect(store.getBotToken()).toBe('');
    expect(store.getRecipientChatId()).toBe('');
    expect(store.getPendingLinkCode()).toBe('');
    expect(store.getUpdateOffset()).toBe(null);
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

    await store.completeRecipientLink({
      chatId: '99999',
      username: 'alice',
      displayName: 'Alice A.',
      nextOffset: 45,
    });

    expect(store.getRecipientChatId()).toBe('99999');
    expect(store.getUpdateOffset()).toBe(45);
    expect(store.getPublicStatus()).toMatchObject({
      recipientUsername: 'alice',
      recipientDisplayName: 'Alice A.',
      recipientLinked: true,
      pendingLink: false,
      linkUrl: null,
    });
  });
});
