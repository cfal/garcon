import { getPublicOrigin, isTrustProxyEnabled } from '../config.js';
import { withJsonBody } from '../lib/json-route.js';
import type { RouteMap } from '../lib/http-route-types.js';
import type { SettingsStore } from '../settings/store.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import type { TelegramSettingsStore } from '../notifications/telegram-settings-store.js';
import type { BrowserPushSettingsStore } from '../notifications/browser-push-settings-store.js';
import type {
  BrowserPushSubscriptionRecord,
  BrowserPushSubscriptionStore,
} from '../notifications/browser-push-subscription-store.js';
import type { BrowserPushNotifier } from '../notifications/browser-push.js';
import { buildBrowserPushPayload } from '../notifications/browser-push-payload.js';
import type { AttentionNotification } from '../notifications/attention-events.js';
import { asJsonBody, errorMessage, type JsonBody } from './route-helpers.js';
import { buildRemoteSettingsSnapshot } from './workspace.js';
import type { BrowserNotificationDisplayMode } from '../../common/ws-requests.js';

interface BrowserNotificationRouteDeps {
  settings: SettingsStore;
  agents: AgentRegistryServiceContract;
  telegramSettings: TelegramSettingsStore;
  browserPushSettings: BrowserPushSettingsStore;
  browserPushSubscriptions: BrowserPushSubscriptionStore;
  browserPushNotifier: BrowserPushNotifier;
}

function displayMode(value: unknown): BrowserNotificationDisplayMode {
  return value === 'browser' || value === 'standalone' ? value : 'unknown';
}

function forwardedHeaderFirst(value: string | null): string {
  return value?.split(',')[0]?.trim() ?? '';
}

function originFromRequest(request: Request): string {
  const configured = getPublicOrigin();
  if (configured) return configured;

  if (isTrustProxyEnabled()) {
    const proto = forwardedHeaderFirst(request.headers.get('x-forwarded-proto'));
    const host = forwardedHeaderFirst(request.headers.get('x-forwarded-host'))
      || forwardedHeaderFirst(request.headers.get('host'));
    if ((proto === 'http' || proto === 'https') && host) {
      return new URL(`${proto}://${host}`).origin;
    }
  }

  return new URL(request.url).origin;
}

function platformFromBody(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 120) : '';
}

function browserSettingsPatch(enabled: boolean): Record<string, unknown> {
  return {
    notifications: {
      browser: { enabled },
    },
  };
}

async function settingsSnapshot({
  settings,
  agents,
  telegramSettings,
  browserPushSettings,
  browserPushSubscriptions,
}: BrowserNotificationRouteDeps) {
  return buildRemoteSettingsSnapshot({
    settings,
    agents,
    telegramSettings,
    browserPushSettings,
    browserPushSubscriptions,
  });
}

function createTestAttention(record: BrowserPushSubscriptionRecord): AttentionNotification {
  const now = new Date().toISOString();
  return {
    id: `browser-test:${record.endpointHash}:${Date.now()}`,
    chatId: 'browser-notification-test',
    reason: 'completed',
    title: 'Garcon',
    body: 'Browser notifications are working.',
    status: 'Browser notifications are working.',
    userMessage: null,
    assistantMessage: null,
    createdAt: now,
    meta: {
      title: 'Garcon',
      hasGeneratedTitle: true,
      agentId: 'garcon',
      projectPath: '',
    },
  };
}

export default function createBrowserNotificationRoutes(
  deps: BrowserNotificationRouteDeps,
): RouteMap {
  async function getVapidPublicKey(): Promise<Response> {
    return Response.json({
      publicKey: deps.browserPushSettings.getPublicKey(),
    });
  }

  async function putSubscription(body: JsonBody, request: Request): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const record = await deps.browserPushSubscriptions.upsert({
        subscription: input.subscription,
        clientId: typeof input.clientId === 'string' ? input.clientId : '',
        displayMode: displayMode(input.displayMode),
        platform: platformFromBody(input.platform),
        userAgent: request.headers.get('user-agent') ?? '',
        origin: originFromRequest(request),
      });
      await deps.settings.setUiSettings(browserSettingsPatch(true));
      const snapshot = await settingsSnapshot(deps);
      return Response.json({
        success: true,
        endpointHash: record.endpointHash,
        settings: snapshot,
      });
    } catch (error) {
      return Response.json({ success: false, error: errorMessage(error) }, { status: 400 });
    }
  }

  async function deleteSubscription(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const endpointHash = typeof input.endpointHash === 'string' ? input.endpointHash.trim() : '';
      const endpoint = typeof input.endpoint === 'string' ? input.endpoint.trim() : '';
      if (endpointHash) {
        await deps.browserPushSubscriptions.removeByEndpointHash(endpointHash);
      } else if (endpoint) {
        await deps.browserPushSubscriptions.removeByEndpoint(endpoint);
      }
      await deps.settings.setUiSettings(browserSettingsPatch(false));
      const snapshot = await settingsSnapshot(deps);
      return Response.json({ success: true, settings: snapshot });
    } catch (error) {
      return Response.json({ success: false, error: errorMessage(error) }, { status: 400 });
    }
  }

  async function postTest(): Promise<Response> {
    const subscriptions = deps.browserPushSubscriptions.listEnabled();
    let sent = 0;
    let failed = 0;
    for (const subscription of subscriptions) {
      if (!subscription.origin) {
        failed += 1;
        continue;
      }
      const payload = buildBrowserPushPayload({
        event: createTestAttention(subscription),
        origin: subscription.origin,
        previewMode: 'status-only',
        badgeCount: null,
      });
      const result = await deps.browserPushNotifier.send(subscription, payload);
      if (result.success) {
        sent += 1;
      } else {
        failed += 1;
        if (result.expired) {
          await deps.browserPushSubscriptions.removeByEndpointHash(subscription.endpointHash);
        }
      }
    }
    return Response.json({ success: failed === 0, sent, failed });
  }

  return {
    '/api/v1/app/browser-notifications/vapid-public-key': { GET: getVapidPublicKey },
    '/api/v1/app/browser-notifications/subscription': {
      PUT: withJsonBody(putSubscription),
      DELETE: withJsonBody(deleteSubscription),
    },
    '/api/v1/app/browser-notifications/test': { POST: postTest },
  };
}
