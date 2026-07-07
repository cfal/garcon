import type { BrowserNotificationPreviewMode } from '../../common/settings.js';
import type { AttentionNotification, AttentionSink } from './attention-events.js';
import { buildBrowserPushPayload } from './browser-push-payload.js';
import type { BrowserNotificationPresenceStore } from './browser-notification-presence.js';
import type { BrowserPushNotifier } from './browser-push.js';
import type { BrowserPushSubscriptionStore } from './browser-push-subscription-store.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('notifications:browser-push');

interface SettingsStoreDep {
  getUiSettings(): Record<string, unknown> | Promise<Record<string, unknown>>;
}

function browserConfigFromUi(ui: Record<string, unknown>): {
  enabled: boolean;
  previewMode: BrowserNotificationPreviewMode;
} {
  const notifications = (ui?.notifications ?? {}) as Record<string, unknown>;
  const browser = (notifications?.browser ?? {}) as Record<string, unknown>;
  return {
    enabled: browser.enabled === true,
    previewMode: browser.previewMode === 'message-preview' ? 'message-preview' : 'status-only',
  };
}

export class BrowserPushAttentionSink implements AttentionSink {
  #settings: SettingsStoreDep;
  #subscriptions: BrowserPushSubscriptionStore;
  #presence: BrowserNotificationPresenceStore;
  #notifier: BrowserPushNotifier;
  #getBadgeCount: () => number | null;

  constructor({
    settings,
    subscriptions,
    presence,
    notifier,
    getBadgeCount = () => null,
  }: {
    settings: SettingsStoreDep;
    subscriptions: BrowserPushSubscriptionStore;
    presence: BrowserNotificationPresenceStore;
    notifier: BrowserPushNotifier;
    getBadgeCount?: () => number | null;
  }) {
    this.#settings = settings;
    this.#subscriptions = subscriptions;
    this.#presence = presence;
    this.#notifier = notifier;
    this.#getBadgeCount = getBadgeCount;
  }

  async notify(event: AttentionNotification): Promise<void> {
    const config = browserConfigFromUi(await this.#settings.getUiSettings());
    if (!config.enabled) return;
    const subscriptions = this.#subscriptions.listEnabled();
    if (subscriptions.length === 0) return;

    let sent = 0;
    let failed = 0;
    for (const subscription of subscriptions) {
      if (this.#presence.shouldSuppress({
        endpointHash: subscription.endpointHash,
        chatId: event.chatId,
      })) {
        continue;
      }
      if (!subscription.origin) {
        failed += 1;
        continue;
      }
      const payload = buildBrowserPushPayload({
        event,
        origin: subscription.origin,
        previewMode: config.previewMode,
        badgeCount: this.#getBadgeCount(),
      });
      const result = await this.#notifier.send(subscription, payload);
      if (result.success) {
        sent += 1;
      } else {
        failed += 1;
        if (result.expired) {
          await this.#subscriptions.removeByEndpointHash(subscription.endpointHash);
        }
      }
    }
    logger.info(`browser-push: attention delivery for ${event.chatId} sent=${sent} failed=${failed}`);
  }
}
