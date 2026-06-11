// Path-based wrappers for Codex JSONL reading.
// Accepts absolute nativePath instead of scanning ~/.codex/sessions/.

import { promises as fs } from 'fs';
import fsSync from 'fs';
import readline from 'readline';
import { readJsonlTailLines } from '../shared/history-loader-utils.ts';
import { normalizeCodexJsonlEntry, extractTextContent } from './history-normalizer.js';
import type { ChatMessage } from '../../../common/chat-types.js';

// Reads a Codex JSONL file and returns ChatMessage[].
// Uses per-content-class dedup. event_msg user messages are treated as
// canonical transcript content, while response_item user messages are
// only included as fallback when event_msg user entries are missing.
export async function loadCodexChatMessages(nativePath: string | null | undefined): Promise<ChatMessage[]> {
  if (!nativePath) return [];

  try {
    const canonical: ChatMessage[] = [];
    const fallbackUser: ChatMessage[] = [];
    const fallbackAssistant: ChatMessage[] = [];
    const fallbackThinking: ChatMessage[] = [];
    let hasCanonicalUser = false;
    let hasCanonicalAssistant = false;
    let hasCanonicalThinking = false;

    const fileStream = fsSync.createReadStream(nativePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const result = normalizeCodexJsonlEntry(entry);
        if (!result) continue;

        canonical.push(...result.canonical);
        fallbackUser.push(...result.fallbackUser);
        fallbackAssistant.push(...result.fallbackAssistant);
        fallbackThinking.push(...result.fallbackThinking);
        if (result.isCanonicalUser) hasCanonicalUser = true;
        if (result.isCanonicalAssistant) hasCanonicalAssistant = true;
        if (result.isCanonicalThinking) hasCanonicalThinking = true;
      } catch { }
    }

    const messages = [...canonical];
    if (!hasCanonicalUser) messages.push(...fallbackUser);
    if (!hasCanonicalAssistant) messages.push(...fallbackAssistant);
    if (!hasCanonicalThinking) messages.push(...fallbackThinking);

    messages.sort((a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime());
    return messages;
  } catch (error) {
    console.error(`Error loading Codex ChatMessages from ${nativePath}:`, error);
    return [];
  }
}

const CODEX_HEAD_BYTES = 96 * 1024;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function extractLastTextBlock(content: unknown): string | null {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed || null;
  }
  if (!Array.isArray(content)) return null;

  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (!block || typeof block !== 'object') continue;
    const rawBlock = asRecord(block);
    if (
      (rawBlock.type === 'text' || rawBlock.type === 'input_text' || rawBlock.type === 'output_text') &&
      typeof rawBlock.text === 'string'
    ) {
      const trimmed = rawBlock.text.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

function isCodexMessageEntry(entry: unknown): boolean {
  const rawEntry = asRecord(entry);
  const payload = asRecord(rawEntry.payload);
  if (rawEntry.type === 'event_msg' && payload.type === 'user_message') return true;
  if (rawEntry.type === 'response_item' && payload.type === 'message') return true;
  return false;
}

// Builds a preview (title, lastActivity, etc.) from an absolute JSONL path.
export async function getCodexPreviewFromNativePath(nativePath: string | null | undefined): Promise<{
  firstMessage: string;
  lastMessage: string;
  lastActivity: string;
  createdAt: string | null;
} | null> {
  if (!nativePath) return null;
  let fh: fs.FileHandle | null = null;
  try {
    fh = await fs.open(nativePath, 'r');
    const stats = await fh.stat();
    if (stats.size === 0) return null;

    const headSize = Math.min(CODEX_HEAD_BYTES, stats.size);
    const headBuf = Buffer.alloc(headSize);
    await fh.read(headBuf, 0, headSize, 0);
    await fh.close();
    fh = null;

    let firstUserMessage: string | null = null;
    let firstMessageTimestamp: string | null = null;

    for (const line of headBuf.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = asRecord(JSON.parse(line));
        const payload = asRecord(entry.payload);
        if (entry.type === 'event_msg' && payload.type === 'user_message') {
          if (typeof payload.message === 'string') firstUserMessage = payload.message;
        }
        if (!firstMessageTimestamp && isCodexMessageEntry(entry) && typeof entry.timestamp === 'string') {
          firstMessageTimestamp = entry.timestamp;
        }
      } catch { }
    }

    const { lines } = await readJsonlTailLines(nativePath, 64 * 1024, 500);
    let lastTimestamp: string | null = null;
    let lastMessage: string | null = null;

    for (const raw of lines) {
      try {
        const entry = asRecord(JSON.parse(raw));
        const payload = asRecord(entry.payload);
        if (typeof entry.timestamp === 'string') lastTimestamp = entry.timestamp;
        if (entry.type === 'event_msg' && payload.type === 'user_message') {
          if (typeof payload.message === 'string' && payload.message.trim()) {
            lastMessage = payload.message.trim();
          }
        }
        if (entry.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
          const textContent =
            extractLastTextBlock(payload.content) ||
            (typeof payload.message === 'string' ? payload.message.trim() : null);
          if (textContent) lastMessage = textContent;
        }
      } catch { }
    }

    return {
      firstMessage: firstUserMessage || 'Unknown Codex Session',
      lastMessage: lastMessage || '',
      lastActivity: lastTimestamp || new Date().toISOString(),
      createdAt: firstMessageTimestamp || null,
    };
  } catch (err) {
    console.warn(`Could not build Codex preview from ${nativePath}:`, err);
    return null;
  } finally {
    await fh?.close();
  }
}
