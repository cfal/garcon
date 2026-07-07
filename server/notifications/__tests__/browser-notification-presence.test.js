import { describe, expect, it } from 'bun:test';
import { BrowserNotificationPresenceRequest } from '../../../common/ws-requests.js';
import { BrowserNotificationPresenceStore } from '../browser-notification-presence.js';

describe('BrowserNotificationPresenceStore', () => {
  it('suppresses notifications for the focused client viewing the chat', () => {
    const presence = new BrowserNotificationPresenceStore();
    presence.update(new BrowserNotificationPresenceRequest(
      'client-1',
      'endpoint-hash-1',
      'chat-1',
      'visible',
      true,
      'standalone',
      Date.now(),
    ));

    expect(presence.shouldSuppress({ endpointHash: 'endpoint-hash-1', chatId: 'chat-1' })).toBe(true);
    expect(presence.shouldSuppress({ endpointHash: 'endpoint-hash-2', chatId: 'chat-1' })).toBe(false);
    expect(presence.shouldSuppress({ endpointHash: 'endpoint-hash-1', chatId: 'chat-2' })).toBe(false);
  });

  it('does not suppress hidden or unfocused clients', () => {
    const presence = new BrowserNotificationPresenceStore();
    presence.update(new BrowserNotificationPresenceRequest(
      'client-1',
      'endpoint-hash-1',
      'chat-1',
      'hidden',
      true,
      'browser',
      Date.now(),
    ));
    presence.update(new BrowserNotificationPresenceRequest(
      'client-2',
      'endpoint-hash-2',
      'chat-1',
      'visible',
      false,
      'browser',
      Date.now(),
    ));

    expect(presence.shouldSuppress({ endpointHash: 'endpoint-hash-1', chatId: 'chat-1' })).toBe(false);
    expect(presence.shouldSuppress({ endpointHash: 'endpoint-hash-2', chatId: 'chat-1' })).toBe(false);
  });

  it('expires stale presence', async () => {
    const presence = new BrowserNotificationPresenceStore({ ttlMs: 1 });
    presence.update(new BrowserNotificationPresenceRequest(
      'client-1',
      'endpoint-hash-1',
      'chat-1',
      'visible',
      true,
      'browser',
      Date.now(),
    ));

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(presence.shouldSuppress({ endpointHash: 'endpoint-hash-1', chatId: 'chat-1' })).toBe(false);
  });
});
