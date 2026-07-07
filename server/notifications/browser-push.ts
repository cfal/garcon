import webpush from 'web-push';
import type { BrowserPushVapidKeys } from './browser-push-settings-store.js';
import type { BrowserPushPayload } from './browser-push-payload.js';
import type { BrowserPushSubscriptionRecord } from './browser-push-subscription-store.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('notifications:browser-push');
const EXPIRED_SUBSCRIPTION_STATUS = new Set([404, 410]);

export interface BrowserPushSendResult {
  success: boolean;
  expired: boolean;
  statusCode: number | null;
  error?: string;
}

function statusCodeFromError(error: unknown): number | null {
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' && Number.isInteger(statusCode) ? statusCode : null;
}

export class BrowserPushNotifier {
  #vapidKeys: BrowserPushVapidKeys;

  constructor(vapidKeys: BrowserPushVapidKeys) {
    this.#vapidKeys = vapidKeys;
  }

  setVapidKeys(vapidKeys: BrowserPushVapidKeys): void {
    this.#vapidKeys = vapidKeys;
  }

  async send(
    subscription: BrowserPushSubscriptionRecord,
    payload: BrowserPushPayload,
  ): Promise<BrowserPushSendResult> {
    try {
      const response = await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          expirationTime: subscription.expirationTime,
          keys: { ...subscription.keys },
        },
        JSON.stringify(payload),
        {
          TTL: 60 * 60 * 24,
          urgency: 'high',
          topic: `chat-${subscription.endpointHash.slice(0, 20)}`,
          vapidDetails: {
            subject: this.#vapidKeys.subject,
            publicKey: this.#vapidKeys.publicKey,
            privateKey: this.#vapidKeys.privateKey,
          },
        },
      );
      return {
        success: true,
        expired: false,
        statusCode: typeof response.statusCode === 'number' ? response.statusCode : null,
      };
    } catch (error: unknown) {
      const statusCode = statusCodeFromError(error);
      const expired = statusCode !== null && EXPIRED_SUBSCRIPTION_STATUS.has(statusCode);
      logger.warn(
        `browser-push: delivery failed for ${subscription.endpointHash}`,
        statusCode ?? '',
        (error as Error).message,
      );
      return {
        success: false,
        expired,
        statusCode,
        error: (error as Error).message,
      };
    }
  }
}
