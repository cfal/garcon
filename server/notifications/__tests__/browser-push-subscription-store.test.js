import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  BrowserPushSubscriptionStore,
  hashPushEndpoint,
} from '../browser-push-subscription-store.js';

let tempDir;

async function createStore() {
  const store = new BrowserPushSubscriptionStore(tempDir);
  await store.init();
  return store;
}

function subscription(endpoint = 'https://push.example.test/abc') {
  return {
    endpoint,
    expirationTime: null,
    keys: {
      p256dh: 'public-key',
      auth: 'auth-secret',
    },
  };
}

describe('BrowserPushSubscriptionStore', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-browser-push-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('upserts subscriptions without exposing duplicate endpoints', async () => {
    const store = await createStore();
    const first = await store.upsert({
      subscription: subscription(),
      clientId: 'client-1',
      userAgent: 'Safari',
      displayMode: 'standalone',
      platform: 'iOS',
      origin: 'https://garcon.example.test',
    });
    const second = await store.upsert({
      subscription: subscription(),
      clientId: 'client-1',
      userAgent: 'Safari 2',
      displayMode: 'browser',
      platform: 'iPadOS',
      origin: 'https://garcon.example.test/workspace',
    });

    expect(first.endpointHash).toBe(hashPushEndpoint(subscription().endpoint));
    expect(second.createdAt).toBe(first.createdAt);
    expect(store.countEnabled()).toBe(1);
    expect(store.listEnabled()[0]).toMatchObject({
      endpointHash: first.endpointHash,
      userAgent: 'Safari 2',
      displayMode: 'browser',
      platform: 'iPadOS',
      origin: 'https://garcon.example.test',
    });
  });

  it('removes subscriptions by endpoint hash', async () => {
    const store = await createStore();
    const record = await store.upsert({
      subscription: subscription(),
      clientId: 'client-1',
      userAgent: '',
      displayMode: 'standalone',
      platform: '',
      origin: 'https://garcon.example.test',
    });

    expect(await store.removeByEndpointHash(record.endpointHash)).toBe(true);
    expect(store.countEnabled()).toBe(0);
  });

  it('rejects invalid subscriptions', async () => {
    const store = await createStore();

    await expect(store.upsert({
      subscription: {
        endpoint: 'http://push.example.test/abc',
        keys: { p256dh: 'public-key', auth: 'auth-secret' },
      },
      clientId: 'client-1',
      userAgent: '',
      displayMode: 'browser',
      platform: '',
      origin: 'https://garcon.example.test',
    })).rejects.toThrow('https URL');

    await expect(store.upsert({
      subscription: subscription(),
      clientId: '',
      userAgent: '',
      displayMode: 'browser',
      platform: '',
      origin: 'https://garcon.example.test',
    })).rejects.toThrow('clientId is required');
  });
});
