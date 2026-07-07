import type { BrowserNotificationPresenceRequest } from '../../common/ws-requests.js';

const DEFAULT_PRESENCE_TTL_MS = 75_000;

interface PresenceEntry {
  clientId: string;
  endpointHash: string | null;
  selectedChatId: string | null;
  visibility: 'visible' | 'hidden';
  hasFocus: boolean;
  lastSeenAt: number;
}

export class BrowserNotificationPresenceStore {
  #entries = new Map<string, PresenceEntry>();
  #ttlMs: number;

  constructor(options: { ttlMs?: number } = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_PRESENCE_TTL_MS;
  }

  update(input: BrowserNotificationPresenceRequest): void {
    this.#prune();
    this.#entries.set(input.clientId, {
      clientId: input.clientId,
      endpointHash: input.endpointHash,
      selectedChatId: input.selectedChatId,
      visibility: input.visibility,
      hasFocus: input.hasFocus,
      lastSeenAt: Date.now(),
    });
  }

  shouldSuppress(input: { endpointHash: string; chatId: string }): boolean {
    this.#prune();
    for (const entry of this.#entries.values()) {
      if (entry.endpointHash !== input.endpointHash) continue;
      if (entry.selectedChatId !== input.chatId) continue;
      if (entry.visibility !== 'visible' || !entry.hasFocus) continue;
      return true;
    }
    return false;
  }

  #prune(): void {
    const cutoff = Date.now() - this.#ttlMs;
    for (const [clientId, entry] of this.#entries) {
      if (entry.lastSeenAt < cutoff) this.#entries.delete(clientId);
    }
  }
}
