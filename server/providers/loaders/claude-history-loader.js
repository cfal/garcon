// Path-based wrappers for Claude JSONL reading.
// Accepts absolute nativePath instead of (projectName, providerSessionId).

import { promises as fs } from 'fs';
import path from 'path';
import { readJsonlTailLines } from './common.ts';
import { normalizeToolResultContent } from '../normalize-util.js';
import { UserMessage, AssistantMessage, ThinkingMessage, ToolResultMessage, ErrorMessage } from '../../../common/chat-types.js';
import { convertClaudeToolUse } from '../converters/claude-tool-use.js';

const HEAD_READ_BYTES = 32 * 1024;

function decodeHtmlEntities(text) {
  if (!text) return text;
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function getMessageText(content) {
  if (Array.isArray(content)) {
    const textParts = content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text.trim())
      .filter(Boolean);
    return textParts.join('\n');
  }
  if (typeof content === 'string') {
    return content.trim();
  }
  return '';
}

function isSystemUserMessage(text) {
  return (
    text.startsWith('<command-name>') ||
    text.startsWith('<command-message>') ||
    text.startsWith('<command-args>') ||
    text.startsWith('<local-command-stdout>') ||
    text.startsWith('<system-reminder>') ||
    text.startsWith('Caveat:') ||
    text.startsWith('This session is being continued from a previous') ||
    text.startsWith('Invalid API key') ||
    text.includes('{"subtasks":') ||
    text.includes('CRITICAL: You MUST respond with ONLY a JSON') ||
    text === 'Warmup'
  );
}

function isSystemAssistantMessage(text) {
  return (
    text.startsWith('Invalid API key') ||
    text.includes('{"subtasks":') ||
    text.includes('CRITICAL: You MUST respond with ONLY a JSON')
  );
}

// Reads a Claude JSONL file and returns ChatMessage[].
export async function loadClaudeChatMessages(nativePath) {
  if (!nativePath) return [];
  try {
    await fs.access(nativePath);
  } catch {
    return [];
  }

  try {
    const raw = await fs.readFile(nativePath, 'utf8');
    const entries = [];

    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.sessionId) entries.push(entry);
      } catch { }
    }

    entries.sort((a, b) =>
      new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime()
    );

    const messages = [];

    for (const entry of entries) {
      const ts = entry.timestamp || new Date().toISOString();

      // Skip non-message entry types
      if (entry.type === 'progress' || entry.type === 'queue-operation' ||
        entry.type === 'file-history-snapshot' || entry.type === 'summary') {
        continue;
      }

      // Skip system entries
      if (entry.type === 'system') continue;

      // Skip compact summary / meta entries
      if (entry.isCompactSummary || entry.isMeta) continue;

      // API error entries
      if (entry.isApiErrorMessage) {
        const errorText = entry.error
          ? (typeof entry.error === 'string' ? entry.error : JSON.stringify(entry.error))
          : getMessageText(entry.message?.content) || 'API error';
        messages.push(new ErrorMessage(ts, errorText));
        continue;
      }

      // User messages
      if (entry.message?.role === 'user') {
        const content = entry.message.content;

        // Emit tool-result messages from user entries
        if (Array.isArray(content)) {
          for (const part of content) {
            if (part.type === 'tool_result') {
              messages.push(new ToolResultMessage(ts, part.tool_use_id || '', normalizeToolResultContent(part.content), Boolean(part.is_error)));
            }
          }
        }

        // Extract text and check if it's a system message
        const text = getMessageText(content);
        if (text && !isSystemUserMessage(text)) {
          messages.push(new UserMessage(ts, decodeHtmlEntities(text)));
        }
        continue;
      }

      // Assistant messages
      if (entry.message?.role === 'assistant' && entry.message?.content) {
        const content = entry.message.content;

        if (Array.isArray(content)) {
          for (const part of content) {
            if (part.type === 'thinking' && part.thinking) {
              messages.push(new ThinkingMessage(ts, part.thinking));
            } else if (part.type === 'text' && part.text?.trim()) {
              if (!isSystemAssistantMessage(part.text)) {
                messages.push(new AssistantMessage(ts, part.text));
              }
            } else if (part.type === 'tool_use') {
              messages.push(convertClaudeToolUse(ts, part));
            }
          }
        } else if (typeof content === 'string' && content.trim()) {
          if (!isSystemAssistantMessage(content)) {
            messages.push(new AssistantMessage(ts, content));
          }
        }
        continue;
      }

      // Standalone thinking entries (type=thinking at the entry level)
      if (entry.type === 'thinking' && entry.message?.content) {
        const thinkContent = typeof entry.message.content === 'string'
          ? entry.message.content : '';
        if (thinkContent) {
          messages.push(new ThinkingMessage(ts, thinkContent));
        }
      }
    }

    return messages;
  } catch (error) {
    console.error(`claude: error loading chat messages from ${nativePath}:`, error);
    return [];
  }
}

// Reads session messages from an absolute JSONL path.
export async function getClaudeSessionMessagesFromNativePath(nativePath, limit = null, offset = 0) {
  try {
    await fs.access(nativePath);
  } catch {
    return limit === null ? [] : { messages: [], total: 0, hasMore: false };
  }

  try {
    const raw = await fs.readFile(nativePath, 'utf8');
    const messages = [];

    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.sessionId) {
          messages.push(entry);
        }
      } catch { }
    }

    messages.sort((a, b) =>
      new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime()
    );

    const total = messages.length;

    if (limit === null) {
      return messages;
    }

    const startIndex = Math.max(0, total - offset - limit);
    const endIndex = total - offset;
    const paginatedMessages = messages.slice(startIndex, endIndex);

    return {
      messages: paginatedMessages,
      total,
      hasMore: startIndex > 0,
      offset,
      limit,
    };
  } catch (error) {
    console.error(`claude: error reading messages from ${nativePath}:`, error);
    return limit === null ? [] : { messages: [], total: 0, hasMore: false };
  }
}

// Reads the head of a JSONL file to find the first user message.
async function readFirstUserMessage(filePath) {
  let fh;
  let firstTimestamp = 0;
  let firstMessage = null;
  try {
    fh = await fs.open(filePath, 'r');
    const stats = await fh.stat();
    const readSize = Math.min(HEAD_READ_BYTES, stats.size);
    if (readSize === 0) return null;

    const buffer = Buffer.alloc(readSize);
    await fh.read(buffer, 0, readSize, 0);

    for (const line of buffer.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.timestamp && !firstTimestamp) {
        firstTimestamp = entry.timestamp;
      }
      if (entry.message?.role !== 'user') {
        continue;
      }
      const text = getMessageText(entry.message.content);
      if (text && !isSystemUserMessage(text)) {
        firstMessage = text;
      }
      if (firstMessage) {
        if (firstTimestamp) {
          break;
        }
        console.error(`claude: got first user message without timestamp: ${firstMessage}`);
      }
    }
  } catch { } finally {
    await fh?.close();
  }
  return { firstMessage, firstTimestamp };
}

// Builds a preview (title, lastActivity, etc.) from an absolute JSONL path.
export async function getClaudePreviewFromNativePath(nativePath) {
  const providerSessionId = path.basename(nativePath, '.jsonl');

  try {
    await fs.access(nativePath);
  } catch (err) {
    console.error(`claude: preview fetch failed for ${nativePath}:`, err);
    return null;
  }

  const { lines, fullyRead } = await readJsonlTailLines(nativePath);
  if (fullyRead) {
    console.warn(`claude: fully read ${nativePath}`);
  }

  let lastActivity = null;
  let lastMessage = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    if (!entry.sessionId) continue;
    if (entry.sessionId !== providerSessionId) {
      console.warn(`claude: skipping non-matching session ID in ${nativePath}, expected ${providerSessionId}: ${entry.sessionId}`);
      continue;
    }

    if (!lastActivity && entry.timestamp) {
      const timestamp = new Date(entry.timestamp);
      if (!Number.isNaN(timestamp.getTime())) {
        const currentTime = timestamp.toISOString();
        lastActivity = currentTime;
      }
    }

    if (!lastMessage) {
      const role = entry.message?.role;
      if (role === 'user') {
        const text = getMessageText(entry.message?.content);
        if (!text || isSystemUserMessage(text)) {
          continue;
        }
        lastMessage = '> ' + text;
      } else if (role === 'assistant' && entry.isApiErrorMessage !== true) {
        const text = getMessageText(entry.message?.content);
        if (!text || isSystemAssistantMessage(text)) {
          continue;
        }
        lastMessage = text;
      }
    }
    if (lastActivity && lastMessage) {
      break;
    }
  }

  // TODO: It's possible that the full file was already read if it's small enough (see `fullyRead`),
  // in which case we could have handled it in the loop above.
  const { firstMessage, firstTimestamp } = await readFirstUserMessage(nativePath);
  if (!firstMessage || !firstTimestamp) {
    console.warn(`claude: failed to read first user message from ${nativePath}`);
  }

  return {
    firstMessage: firstMessage || 'Unknown Claude Session',
    lastMessage: lastMessage || '',
    lastActivity: lastActivity,
    createdAt: firstTimestamp || null,
  };
}
