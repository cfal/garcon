import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { BrowserPushSettingsStore } from '../browser-push-settings-store.js';

let tempDir;
let filePath;
let oldSubject;

function decodeBase64Url(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  return Buffer.from((value + padding).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

describe('BrowserPushSettingsStore', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-vapid-'));
    filePath = path.join(tempDir, 'browser-push-vapid.json');
    oldSubject = process.env.GARCON_VAPID_SUBJECT;
    delete process.env.GARCON_VAPID_SUBJECT;
  });

  afterEach(async () => {
    if (oldSubject === undefined) {
      delete process.env.GARCON_VAPID_SUBJECT;
    } else {
      process.env.GARCON_VAPID_SUBJECT = oldSubject;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('generates stable VAPID keys once', async () => {
    const first = new BrowserPushSettingsStore(filePath);
    await first.init();
    const keys = first.getVapidKeys();
    expect(first.isConfigured).toBe(true);
    expect(keys.publicKey).toBeTruthy();
    expect(keys.privateKey).toBeTruthy();
    expect(keys.subject).toBe('mailto:notifications@garcon.local');
    expect(decodeBase64Url(keys.publicKey)).toHaveLength(65);
    expect(decodeBase64Url(keys.publicKey)[0]).toBe(4);
    expect(decodeBase64Url(keys.privateKey)).toHaveLength(32);

    const second = new BrowserPushSettingsStore(filePath);
    await second.init();
    expect(second.getVapidKeys()).toEqual(keys);
  });

  it('honors GARCON_VAPID_SUBJECT when creating keys', async () => {
    process.env.GARCON_VAPID_SUBJECT = 'mailto:ops@example.test';
    const store = new BrowserPushSettingsStore(filePath);
    await store.init();

    expect(store.getVapidKeys().subject).toBe('mailto:ops@example.test');
  });

  it('regenerates malformed persisted VAPID keys', async () => {
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        vapid: {
          publicKey: 'not-a-valid-key',
          privateKey: 'also-bad',
          subject: 'mailto:persisted@example.test',
        },
      }),
    );

    const store = new BrowserPushSettingsStore(filePath);
    await store.init();
    const keys = store.getVapidKeys();

    expect(keys.publicKey).not.toBe('not-a-valid-key');
    expect(keys.privateKey).not.toBe('also-bad');
    expect(keys.subject).toBe('mailto:persisted@example.test');
    expect(decodeBase64Url(keys.publicKey)).toHaveLength(65);
    expect(decodeBase64Url(keys.publicKey)[0]).toBe(4);
    expect(decodeBase64Url(keys.privateKey)).toHaveLength(32);
  });
});
