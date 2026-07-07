import { beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('../../config.js', () => ({
  getProjectBasePath: mock(() => '/workspace'),
  getPublicOrigin: mock(() => null),
  isTrustProxyEnabled: mock(() => false),
}));

import createBrowserNotificationRoutes from '../browser-notifications.js';

function remoteSettingsSource(overrides = {}) {
  return {
    version: 1,
    ui: {},
    paths: { pinnedProjectPaths: [], browseStartPath: '', recentProjectPaths: [] },
    pinnedChatIds: [],
    recentAgentSettings: [],
    executionDefaults: {
      global: {
        permissionMode: 'default',
        thinkingMode: 'none',
        claudeThinkingMode: 'auto',
        ampAgentMode: 'smart',
      },
      byAgent: {},
    },
    ...overrides,
  };
}

function makeRequest(method, body = undefined) {
  return new Request('https://garcon.example.test/api/v1/app/browser-notifications/subscription', {
    method,
    headers: {
      'content-type': 'application/json',
      'user-agent': 'Safari',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function createDeps() {
  const subscriptions = new Map();
  const deps = {
    settings: {
      getRemoteSettingsSnapshotSource: mock(() => remoteSettingsSource()),
      setUiSettings: mock(() => Promise.resolve({})),
    },
    agents: {
      getAgentAuthStatusMap: mock(() => Promise.resolve({})),
      getAgentReadinessMap: mock(() => Promise.resolve({})),
      getAgentCatalogEntries: mock(() => Promise.resolve([])),
      getModels: mock(() => Promise.resolve([])),
    },
    telegramSettings: {
      getPublicStatus: mock(() => ({
        botTokenAvailable: false,
        botUsername: null,
        botFirstName: null,
        recipientUsername: null,
        recipientDisplayName: null,
        recipientLinked: false,
        pendingLink: false,
        linkUrl: null,
      })),
    },
    browserPushSettings: {
      isConfigured: true,
      getPublicKey: mock(() => 'public-vapid-key'),
    },
    browserPushSubscriptions: {
      countEnabled: mock(() => subscriptions.size),
      listEnabled: mock(() => [...subscriptions.values()]),
      upsert: mock((input) => {
        const record = {
          endpoint: input.subscription.endpoint,
          endpointHash: 'endpoint-hash-1',
          expirationTime: null,
          keys: { ...input.subscription.keys },
          userAgent: input.userAgent,
          displayMode: input.displayMode,
          platform: input.platform,
          origin: input.origin,
          enabled: true,
          clientId: input.clientId,
          createdAt: '2026-07-07T00:00:00.000Z',
          lastSeenAt: '2026-07-07T00:00:00.000Z',
        };
        subscriptions.set(record.endpointHash, record);
        return Promise.resolve(record);
      }),
      removeByEndpointHash: mock((endpointHash) => {
        const removed = subscriptions.delete(endpointHash);
        return Promise.resolve(removed);
      }),
      removeByEndpoint: mock(() => Promise.resolve(false)),
    },
    browserPushNotifier: {
      send: mock(() => Promise.resolve({ success: true, expired: false, statusCode: 201 })),
    },
  };
  return { deps, subscriptions };
}

describe('browser notification routes', () => {
  let deps;
  let subscriptions;
  let routes;

  beforeEach(() => {
    ({ deps, subscriptions } = createDeps());
    routes = createBrowserNotificationRoutes(deps);
  });

  it('returns only the VAPID public key', async () => {
    const response = await routes['/api/v1/app/browser-notifications/vapid-public-key'].GET();
    const body = await response.json();

    expect(body).toEqual({ publicKey: 'public-vapid-key' });
  });

  it('upserts a browser push subscription and enables browser notifications', async () => {
    const response = await routes['/api/v1/app/browser-notifications/subscription'].PUT(
      makeRequest('PUT', {
        clientId: 'client-1',
        displayMode: 'standalone',
        platform: 'iPadOS',
        subscription: {
          endpoint: 'https://web.push.apple.com/token',
          expirationTime: null,
          keys: { p256dh: 'public-key', auth: 'auth-secret' },
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.endpointHash).toBe('endpoint-hash-1');
    expect(body.settings.browserNotifications.subscriptionCount).toBe(1);
    expect(deps.browserPushSubscriptions.upsert).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'client-1',
      displayMode: 'standalone',
      platform: 'iPadOS',
      origin: 'https://garcon.example.test',
      userAgent: 'Safari',
    }));
    expect(deps.settings.setUiSettings).toHaveBeenCalledWith({
      notifications: {
        browser: { enabled: true },
      },
    });
  });

  it('removes a browser push subscription and disables browser notifications for this browser', async () => {
    subscriptions.set('endpoint-hash-1', {
      endpointHash: 'endpoint-hash-1',
      origin: 'https://garcon.example.test',
      endpoint: 'https://web.push.apple.com/token',
      expirationTime: null,
      keys: { p256dh: 'public-key', auth: 'auth-secret' },
      enabled: true,
      clientId: 'client-1',
      userAgent: 'Safari',
      displayMode: 'standalone',
      platform: 'iPadOS',
      createdAt: '2026-07-07T00:00:00.000Z',
      lastSeenAt: '2026-07-07T00:00:00.000Z',
    });

    const response = await routes['/api/v1/app/browser-notifications/subscription'].DELETE(
      makeRequest('DELETE', { endpointHash: 'endpoint-hash-1' }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.settings.browserNotifications.subscriptionCount).toBe(0);
    expect(deps.browserPushSubscriptions.removeByEndpointHash).toHaveBeenCalledWith('endpoint-hash-1');
    expect(deps.settings.setUiSettings).toHaveBeenCalledWith({
      notifications: {
        browser: { enabled: false },
      },
    });
  });

  it('sends test notifications through the browser push notifier', async () => {
    subscriptions.set('endpoint-hash-1', {
      endpointHash: 'endpoint-hash-1',
      origin: 'https://garcon.example.test',
      endpoint: 'https://web.push.apple.com/token',
      expirationTime: null,
      keys: { p256dh: 'public-key', auth: 'auth-secret' },
      enabled: true,
      clientId: 'client-1',
      userAgent: 'Safari',
      displayMode: 'standalone',
      platform: 'iPadOS',
      createdAt: '2026-07-07T00:00:00.000Z',
      lastSeenAt: '2026-07-07T00:00:00.000Z',
    });

    const response = await routes['/api/v1/app/browser-notifications/test'].POST();
    const body = await response.json();

    expect(body).toEqual({ success: true, sent: 1, failed: 0 });
    expect(deps.browserPushNotifier.send).toHaveBeenCalledWith(
      expect.objectContaining({ endpointHash: 'endpoint-hash-1' }),
      expect.objectContaining({
        web_push: 8030,
        notification: expect.objectContaining({
          title: 'Garcon',
          navigate: 'https://garcon.example.test/chat/browser-notification-test',
        }),
      }),
    );
  });
});
