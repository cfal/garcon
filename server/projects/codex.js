// Codex session reading. Handles JSONL sessions under ~/.codex/sessions/.

import { promises as fs } from 'fs';
import fsSync from 'fs';
import path from 'path';
import readline from 'readline';
import os from 'os';
import { readJsonlTailLines } from './shared.js';

export const CODEX_SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');

const CODEX_TITLE_MAX_LENGTH = 50;
const CODEX_DEFAULT_TITLE = 'Codex Session';

function truncateTitle(text) {
  if (!text) return CODEX_DEFAULT_TITLE;
  if (text.length <= CODEX_TITLE_MAX_LENGTH) return text;
  return text.substring(0, CODEX_TITLE_MAX_LENGTH) + '...';
}

function extractLastTextBlock(content) {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed || null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (!block || typeof block !== 'object') {
      continue;
    }

    if (
      (block.type === 'text' || block.type === 'input_text' || block.type === 'output_text') &&
      typeof block.text === 'string'
    ) {
      const trimmed = block.text.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }

  return null;
}

function isCodexMessageEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;

  if (entry.type === 'event_msg' && entry.payload?.type === 'user_message') {
    return true;
  }

  if (entry.type === 'response_item' && entry.payload?.type === 'message') {
    return true;
  }

  return false;
}

async function readFirstCodexMessageTimestamp(filePath) {
  const fileStream = fsSync.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (!isCodexMessageEntry(entry)) continue;
        if (typeof entry.timestamp === 'string' && entry.timestamp.trim()) {
          return entry.timestamp;
        }
      } catch {
        // Skip malformed lines
      }
    }
  } finally {
    rl.close();
    fileStream.destroy();
  }

  return null;
}

// Resolves a Codex JSONL path from a provider session ID by matching the
// filename suffix. Codex names files as `rollout-{timestamp}-{sessionId}.jsonl`,
// so a recursive glob for `*${sessionId}.jsonl` avoids reading every file.
export async function findCodexSessionFileBySessionId(sessionId) {
  if (!sessionId) {
    return null;
  }

  const suffix = `${sessionId}.jsonl`;
  const match = await findFileWithSuffix(CODEX_SESSIONS_ROOT, suffix);
  return match || null;
}

async function findFileWithSuffix(dir, suffix) {
  if (!dir || !suffix) {
    return null;
  }

  if (typeof Bun !== 'undefined' && typeof Bun.Glob === 'function') {
    try {
      const escapedSuffix = suffix
        .replace(/\\/g, '\\\\')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/\*/g, '\\*')
        .replace(/\?/g, '\\?');
      const glob = new Bun.Glob(`**/*${escapedSuffix}`);
      for await (const filePath of glob.scan({
        cwd: dir,
        absolute: true,
        onlyFiles: true,
        followSymlinks: false,
      })) {
        return filePath;
      }
      return null;
    } catch {
      return null;
    }
  }

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const found = await findFileWithSuffix(fullPath, suffix);
      if (found) return found;
    } else if (entry.name.endsWith(suffix)) {
      return fullPath;
    }
  }
  return null;
}

// Lightweight Codex metadata reader. Reads only the first ~96KB for
// session_meta and scans the tail for lastActivity / title.
const CODEX_HEAD_BYTES = 96 * 1024;
export async function getCodexSessionMeta(filePath) {
  let fh;
  try {
    fh = await fs.open(filePath, 'r');
    const stats = await fh.stat();
    if (stats.size === 0) {
      return null;
    }

    const headSize = Math.min(CODEX_HEAD_BYTES, stats.size);
    const headBuf = Buffer.alloc(headSize);
    await fh.read(headBuf, 0, headSize, 0);
    await fh.close();
    fh = null;

    let sessionMeta = null;
    let firstMessageTimestamp = null;
    let firstUserMessage = null;
    for (const line of headBuf.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'session_meta' && entry.payload) {
          sessionMeta = {
            id: entry.payload.id,
            cwd: entry.payload.cwd,
            model: entry.payload.model || entry.payload.model_provider,
          };
        } else if (entry.type === 'event_msg' && entry.payload?.type === 'user_message') {
          if (entry.payload.message) firstUserMessage = entry.payload.message;
        }
        if (!firstMessageTimestamp && isCodexMessageEntry(entry) && typeof entry.timestamp === 'string') {
          firstMessageTimestamp = entry.timestamp;
        }
      } catch { }
    }
    if (!sessionMeta) return null;

    let createdAt = null;
    if (!firstMessageTimestamp) {
      firstMessageTimestamp = await readFirstCodexMessageTimestamp(filePath);
    }
    createdAt = firstMessageTimestamp || null;

    const { lines } = await readJsonlTailLines(filePath, 64 * 1024, 500);
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
          if (textContent) {
            lastMessage = textContent;
          }
        }
      } catch { }
    }

    const title = truncateTitle(firstUserMessage);

    return {
      id: sessionMeta.id,
      title,
      lastMessage: lastMessage || '',
      lastActivity: lastTimestamp || new Date().toISOString(),
      createdAt,
      cwd: sessionMeta.cwd || '',
      model: sessionMeta.model || null,
    };
  } catch (error) {
    console.error('Could not get codex session meta:', error);
    if (error.code !== 'ENOENT') {
      console.warn(`Could not read Codex session meta for ${filePath}:`, error.message);
    }
    return null;
  } finally {
    await fh?.close();
  }
}
