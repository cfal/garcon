// Path-based wrappers for Codex JSONL reading.
// Accepts absolute nativePath instead of scanning ~/.codex/sessions/.

import { promises as fs } from 'fs';
import fsSync from 'fs';
import readline from 'readline';
import { readJsonlTailLines } from './common.ts';
import { normalizeCodexJsonlEntry, extractTextContent } from './codex-history-normalizer.js';

// Reads a Codex JSONL file and returns ChatMessage[].
// Uses per-content-class dedup. event_msg user messages are treated as
// canonical transcript content, while response_item user messages are
// only included as fallback when event_msg user entries are missing.
export async function loadCodexChatMessages(nativePath) {
  if (!nativePath) return [];

  try {
    const canonical = [];
    const fallbackUser = [];
    const fallbackAssistant = [];
    const fallbackThinking = [];
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

    messages.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
    return messages;
  } catch (error) {
    console.error(`Error loading Codex ChatMessages from ${nativePath}:`, error);
    return [];
  }
}

const CODEX_HEAD_BYTES = 96 * 1024;

function extractLastTextBlock(content) {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed || null;
  }
  if (!Array.isArray(content)) return null;

  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (!block || typeof block !== 'object') continue;
    if (
      (block.type === 'text' || block.type === 'input_text' || block.type === 'output_text') &&
      typeof block.text === 'string'
    ) {
      const trimmed = block.text.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

function isCodexMessageEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.type === 'event_msg' && entry.payload?.type === 'user_message') return true;
  if (entry.type === 'response_item' && entry.payload?.type === 'message') return true;
  return false;
}

// Builds a preview (title, lastActivity, etc.) from an absolute JSONL path.
export async function getCodexPreviewFromNativePath(nativePath) {
  let fh;
  try {
    fh = await fs.open(nativePath, 'r');
    const stats = await fh.stat();
    if (stats.size === 0) return null;

    const headSize = Math.min(CODEX_HEAD_BYTES, stats.size);
    const headBuf = Buffer.alloc(headSize);
    await fh.read(headBuf, 0, headSize, 0);
    await fh.close();
    fh = null;

    let firstUserMessage = null;
    let firstMessageTimestamp = null;

    for (const line of headBuf.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'event_msg' && entry.payload?.type === 'user_message') {
          if (entry.payload.message) firstUserMessage = entry.payload.message;
        }
        if (!firstMessageTimestamp && isCodexMessageEntry(entry) && typeof entry.timestamp === 'string') {
          firstMessageTimestamp = entry.timestamp;
        }
      } catch { }
    }

    const { lines } = await readJsonlTailLines(nativePath, 64 * 1024, 500);
    let lastTimestamp = null;
    let lastMessage = null;

    for (const raw of lines) {
      try {
        const entry = JSON.parse(raw);
        if (entry.timestamp) lastTimestamp = entry.timestamp;
        if (entry.type === 'event_msg' && entry.payload?.type === 'user_message') {
          if (typeof entry.payload.message === 'string' && entry.payload.message.trim()) {
            lastMessage = entry.payload.message.trim();
          }
        }
        if (entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload.role === 'assistant') {
          const textContent =
            extractLastTextBlock(entry.payload.content) ||
            (typeof entry.payload.message === 'string' ? entry.payload.message.trim() : null);
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
