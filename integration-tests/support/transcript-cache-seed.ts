import type { BrowserContext } from 'playwright';
import type { TranscriptPage } from '../../common/chat-view.js';

// Seeds a genuine raw recent window so combined-mode activation must top up its anchor demand.
export async function seedRecentTranscriptCache(context: BrowserContext, chatId: string, page: TranscriptPage): Promise<void> {
  await context.addInitScript(({ chatId, page }) => {
    if (location.hostname !== '127.0.0.1') return;
    const now = new Date().toISOString();
    localStorage.setItem(`chat_snapshot_${chatId}`, JSON.stringify({
      version: 6, chatId, savedAt: now, transcriptViewId: page.transcriptViewId,
      lastOrdinal: page.lastOrdinal, nextBeforeOrdinal: page.nextBeforeOrdinal, entries: page.messages,
    }));
    localStorage.setItem('chat_snapshot_index_v3', JSON.stringify({ version: 6, entries: [{
      chatId, lastAccessedAt: now, lastValidatedAt: now, schemaVersion: 6, stale: false,
    }] }));
  }, { chatId, page: JSON.parse(JSON.stringify(page)) as TranscriptPage });
}
