// Path-based wrappers for Codex JSONL reading.
// Accepts absolute nativePath instead of scanning ~/.codex/sessions/.

import { promises as fs } from 'fs';
import fsSync from 'fs';
import readline from 'readline';
import { readJsonlTailLines } from '../shared/history-loader-utils.ts';
import { normalizeCodexJsonlEntry, extractTextContent } from './history-normalizer.js';
import type { ChatMessage } from '../../../common/chat-types.js';
import type { AgentTranscriptPage } from '../types.js';
import { createLogger } from '../../lib/log.js';

const logger = createLogger('agents:codex:history-loader');

interface CodexMessageBuckets {
  canonical: ChatMessage[];
  fallbackUser: ChatMessage[];
  fallbackAssistant: ChatMessage[];
  fallbackThinking: ChatMessage[];
  hasCanonicalUser: boolean;
  hasCanonicalAssistant: boolean;
  hasCanonicalThinking: boolean;
}

function sortChatMessagesByTimestamp(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const left = new Date(a.message.timestamp || 0).getTime();
      const right = new Date(b.message.timestamp || 0).getTime();
      if (left > 0 && right > 0 && left !== right) return left - right;
      return a.index - b.index;
    })
    .map(({ message }) => message);
}

function createCodexMessageBuckets(): CodexMessageBuckets {
  return {
    canonical: [],
    fallbackUser: [],
    fallbackAssistant: [],
    fallbackThinking: [],
    hasCanonicalUser: false,
    hasCanonicalAssistant: false,
    hasCanonicalThinking: false,
  };
}

function addCodexJsonlLine(buckets: CodexMessageBuckets, line: string, sourceLineNumber?: number): void {
  if (!line.trim()) return;
  try {
    const entry = JSON.parse(line);
    const result = normalizeCodexJsonlEntry(entry, { sourceLineNumber });
    if (!result) return;

    buckets.canonical.push(...result.canonical);
    buckets.fallbackUser.push(...result.fallbackUser);
    buckets.fallbackAssistant.push(...result.fallbackAssistant);
    buckets.fallbackThinking.push(...result.fallbackThinking);
    if (result.isCanonicalUser) buckets.hasCanonicalUser = true;
    if (result.isCanonicalAssistant) buckets.hasCanonicalAssistant = true;
    if (result.isCanonicalThinking) buckets.hasCanonicalThinking = true;
  } catch { }
}

function finishCodexMessages(buckets: CodexMessageBuckets, includeFallback: boolean): ChatMessage[] {
  const messages = [...buckets.canonical];
  if (includeFallback && !buckets.hasCanonicalUser) messages.push(...buckets.fallbackUser);
  if (includeFallback && !buckets.hasCanonicalAssistant) messages.push(...buckets.fallbackAssistant);
  if (includeFallback && !buckets.hasCanonicalThinking) messages.push(...buckets.fallbackThinking);
  return sortChatMessagesByTimestamp(messages);
}

function collectCodexMessagesFromLines(lines: string[], includeFallback: boolean): ChatMessage[] {
  const buckets = createCodexMessageBuckets();
  for (let index = 0; index < lines.length; index += 1) {
    addCodexJsonlLine(buckets, lines[index], index + 1);
  }
  return finishCodexMessages(buckets, includeFallback);
}

// Reads a Codex JSONL file and returns ChatMessage[].
// Uses per-content-class dedup. event_msg user messages are treated as
// canonical transcript content, while response_item user messages are
// only included as fallback when event_msg user entries are missing.
export async function loadCodexChatMessages(nativePath: string | null | undefined): Promise<ChatMessage[]> {
  if (!nativePath) return [];

  try {
    const buckets = createCodexMessageBuckets();

    const fileStream = fsSync.createReadStream(nativePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let sourceLineNumber = 0;
    for await (const line of rl) {
      sourceLineNumber += 1;
      addCodexJsonlLine(buckets, line, sourceLineNumber);
    }

    return finishCodexMessages(buckets, true);
  } catch (error) {
    logger.error(`Error loading Codex ChatMessages from ${nativePath}:`, error);
    return [];
  }
}

export async function loadCodexChatMessagePage(
  nativePath: string | null | undefined,
  limit: number,
  offset: number,
): Promise<AgentTranscriptPage | null> {
  if (!nativePath || offset > 0 || limit <= 0) return null;

  try {
    let maxBytes = 256 * 1024;
    let maxLines = Math.max(500, limit * 40);
    while (true) {
      const { lines, fullyRead } = await readJsonlTailLines(nativePath, maxBytes, maxLines);
      const messages = collectCodexMessagesFromLines(lines, fullyRead);
      if (messages.length >= limit || fullyRead) {
        const pageMessages = messages.slice(Math.max(0, messages.length - limit));
        const hasMore = !fullyRead || messages.length > pageMessages.length;
        return {
          messages: pageMessages,
          total: fullyRead ? messages.length : pageMessages.length + 1,
          hasMore,
          offset,
          limit,
        };
      }
      maxBytes *= 2;
      maxLines *= 2;
    }
  } catch (error) {
    logger.warn(`codex: tail page load failed for ${nativePath}:`, error);
    return null;
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
    logger.warn(`Could not build Codex preview from ${nativePath}:`, err);
    return null;
  } finally {
    await fh?.close();
  }
}
