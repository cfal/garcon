// File-based loaders for Amp thread JSON files.
// Native path format is either "amp:<sessionId>" or a direct JSON file path.

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { normalizeToolResultContent } from '../../chats/normalize.js';
import { UserMessage, AssistantMessage, ThinkingMessage, ToolResultMessage } from '../../../common/chat-types.js';
import { convertClaudeToolUse } from '../converters/claude-tool-use.js';

function resolveSessionId(input) {
  if (!input || typeof input !== 'string') return null;
  if (input.startsWith('amp:')) return input.slice('amp:'.length) || null;
  const base = path.basename(input);
  if (base.startsWith('T-') && base.endsWith('.json')) {
    return base.slice(0, -'.json'.length);
  }
  if (input.startsWith('T-')) return input;
  return null;
}

function ampThreadPathFromSessionId(sessionId) {
  return path.join(os.homedir(), '.local', 'share', 'amp', 'threads', `${sessionId}.json`);
}

function resolveAmpThreadPath(nativePathOrSessionId) {
  const sessionId = resolveSessionId(nativePathOrSessionId);
  if (sessionId) return ampThreadPathFromSessionId(sessionId);
  return typeof nativePathOrSessionId === 'string' ? nativePathOrSessionId : null;
}

function messageTimestamp(msg, threadCreatedMs) {
  const usageTs = msg?.usage?.timestamp;
  if (typeof usageTs === 'string' && usageTs.trim()) return usageTs;

  const sentAt = msg?.meta?.sentAt;
  if (typeof sentAt === 'number' && Number.isFinite(sentAt)) {
    return new Date(sentAt).toISOString();
  }
  if (typeof sentAt === 'string' && sentAt.trim()) {
    const d = new Date(sentAt);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }

  if (typeof threadCreatedMs === 'number' && Number.isFinite(threadCreatedMs)) {
    return new Date(threadCreatedMs).toISOString();
  }

  return new Date().toISOString();
}

function extractToolResultId(part) {
  return part?.tool_use_id || part?.toolUseID || part?.toolUseId || '';
}

function extractToolResultPayload(part) {
  if (part?.run && typeof part.run === 'object') {
    if (part.run.result !== undefined) return part.run.result;
    if (part.run.error !== undefined) return part.run.error;
    return part.run;
  }
  return part?.content;
}

function isToolResultError(part) {
  if (typeof part?.is_error === 'boolean') return part.is_error;
  if (typeof part?.isError === 'boolean') return part.isError;
  if (part?.run?.status) return String(part.run.status).toLowerCase() !== 'done';
  return false;
}

function messageText(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function convertAmpThreadMessageToChatMessages(msg, ts) {
  const out = [];
  const role = msg?.role;
  const parts = Array.isArray(msg?.content) ? msg.content : [];

  if (role === 'user') {
    for (const part of parts) {
      if (part?.type !== 'tool_result') continue;
      out.push(new ToolResultMessage(
        ts,
        extractToolResultId(part),
        normalizeToolResultContent(extractToolResultPayload(part)),
        isToolResultError(part),
      ));
    }

    const text = messageText(parts);
    if (text) out.push(new UserMessage(ts, text));
    return out;
  }

  if (role === 'assistant') {
    for (const part of parts) {
      if (part?.type === 'thinking' && part.thinking) {
        out.push(new ThinkingMessage(ts, part.thinking));
      } else if (part?.type === 'text' && part.text?.trim()) {
        out.push(new AssistantMessage(ts, part.text));
      } else if (part?.type === 'tool_use') {
        out.push(convertClaudeToolUse(ts, part));
      } else if (part?.type === 'tool_result') {
        out.push(new ToolResultMessage(
          ts,
          extractToolResultId(part),
          normalizeToolResultContent(extractToolResultPayload(part)),
          isToolResultError(part),
        ));
      }
    }
  }

  return out;
}

async function readThread(nativePathOrSessionId) {
  const filePath = resolveAmpThreadPath(nativePathOrSessionId);
  if (!filePath) return null;

  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const thread = JSON.parse(raw);
    if (!thread || typeof thread !== 'object') return null;
    return thread;
  } catch {
    return null;
  }
}

// Reads an Amp thread JSON file and returns ChatMessage[].
export async function loadAmpChatMessages(nativePathOrSessionId) {
  const thread = await readThread(nativePathOrSessionId);
  if (!thread) return [];

  const messages = [];
  const rawMessages = Array.isArray(thread.messages) ? thread.messages : [];
  const createdMs = typeof thread.created === 'number' ? thread.created : null;

  for (const msg of rawMessages) {
    const ts = messageTimestamp(msg, createdMs);
    messages.push(...convertAmpThreadMessageToChatMessages(msg, ts));
  }

  return messages;
}

// Builds a preview (title, first/last message, timestamps) from an Amp thread.
export async function getAmpPreviewFromSessionId(sessionId) {
  const thread = await readThread(sessionId);
  if (!thread) return null;

  const rawMessages = Array.isArray(thread.messages) ? thread.messages : [];
  const createdMs = typeof thread.created === 'number' ? thread.created : null;

  let firstUserMessage = '';
  let lastMessage = '';
  let lastActivity = null;
  let createdAt = createdMs ? new Date(createdMs).toISOString() : null;

  for (const msg of rawMessages) {
    const ts = messageTimestamp(msg, createdMs);
    if (!createdAt) createdAt = ts;
    lastActivity = ts;

    if (msg?.role === 'user') {
      const text = messageText(msg.content);
      if (text && !firstUserMessage) firstUserMessage = text;
      if (text) lastMessage = '> ' + text;
      continue;
    }

    if (msg?.role === 'assistant') {
      const text = messageText(msg.content);
      if (text) lastMessage = text;
    }
  }

  return {
    firstMessage: firstUserMessage || thread.title || 'Unknown Amp Session',
    lastMessage: lastMessage || '',
    lastActivity,
    createdAt,
  };
}

export { resolveAmpThreadPath, ampThreadPathFromSessionId };

