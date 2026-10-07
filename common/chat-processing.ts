import { CHAT_PROCESSING_PHASES, parseChatProcessingTiming, type ChatProcessingEntry } from './chat-types';

export function parseChatProcessingEntries(value: unknown[]): ChatProcessingEntry[] | null {
  const chats: ChatProcessingEntry[] = [];
  const seen = new Set<string>();
  for (const valueEntry of value) {
    if (!valueEntry || typeof valueEntry !== 'object' || Array.isArray(valueEntry)) return null;
    const entry = valueEntry as Record<string, unknown>;
    const chatId = typeof entry.chatId === 'string' ? entry.chatId.trim() || null : null;
    const phase = CHAT_PROCESSING_PHASES.find((valuePhase) => valuePhase === entry.phase);
    if (!chatId || !phase || seen.has(chatId)) return null;
    seen.add(chatId);
    const timing = entry.timing === undefined ? null : parseChatProcessingTiming(entry.timing);
    if (entry.timing !== undefined && !timing) return null;
    chats.push({ chatId, phase, ...(timing ? { timing } : {}) });
  }

  return chats;
}
