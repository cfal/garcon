import { AssistantMessage, ErrorMessage, ThinkingMessage, ToolResultMessage, UserMessage } from '../../../common/chat-types.js';
import { convertAmpToolUse } from '../converters/amp-tool-use.js';
import { normalizeToolResultContent } from '../normalize-util.js';

function toIsoString(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return null;
}

function getMessageTimestamp(message, fallbackTimestamp) {
  const directTimestamp =
    toIsoString(message?.meta?.sentAt) ||
    toIsoString(message?.usage?.timestamp) ||
    toIsoString(message?.createdAt);
  return directTimestamp || fallbackTimestamp;
}

function getTextParts(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text.trim())
    .filter(Boolean);
}

function getUserText(content) {
  return getTextParts(content).join('\n');
}

function getAssistantText(content) {
  return getTextParts(content).at(-1) || '';
}

function getToolResultPayload(part) {
  const status = typeof part?.run?.status === 'string' ? part.run.status : null;

  if (status && status !== 'done') {
    return {
      content: normalizeToolResultContent(part.run),
      isError: true,
    };
  }

  if (part?.run?.result !== undefined) {
    return {
      content: normalizeToolResultContent(part.run.result),
      isError: false,
    };
  }

  return {
    content: normalizeToolResultContent(part?.run ?? {}),
    isError: false,
  };
}

function getSortedMessages(threadExport) {
  const messages = Array.isArray(threadExport?.messages) ? [...threadExport.messages] : [];
  return messages.sort((a, b) => (a?.messageId ?? 0) - (b?.messageId ?? 0));
}

export function loadAmpChatMessages(threadExport) {
  if (!threadExport || typeof threadExport !== 'object') return [];

  const createdAt = toIsoString(threadExport.created) || new Date().toISOString();
  const messages = [];

  for (const message of getSortedMessages(threadExport)) {
    const timestamp = getMessageTimestamp(message, createdAt);
    const content = Array.isArray(message?.content) ? message.content : [];

    if (message?.role === 'user') {
      for (const part of content) {
        if (part?.type !== 'tool_result') continue;
        const { content: resultContent, isError } = getToolResultPayload(part);
        messages.push(new ToolResultMessage(timestamp, part.toolUseID || '', resultContent, isError));
      }

      const text = getUserText(content);
      if (text) {
        messages.push(new UserMessage(timestamp, text));
      }
      continue;
    }

    if (message?.role === 'assistant') {
      for (const part of content) {
        if (part?.type === 'thinking' && part.thinking) {
          messages.push(new ThinkingMessage(timestamp, part.thinking));
        } else if (part?.type === 'text' && part.text?.trim()) {
          messages.push(new AssistantMessage(timestamp, part.text));
        } else if (part?.type === 'tool_use') {
          messages.push(convertAmpToolUse(timestamp, part));
        }
      }
      continue;
    }

    if (message?.role === 'info') {
      const infoText = getUserText(content);
      if (infoText) {
        messages.push(new ErrorMessage(timestamp, infoText));
      }
    }
  }

  return messages;
}

export function getAmpPreview(threadExport) {
  if (!threadExport || typeof threadExport !== 'object') return null;

  const createdAt = toIsoString(threadExport.created);
  const messages = getSortedMessages(threadExport);

  let firstMessage = null;
  let lastMessage = '';
  let lastActivity = createdAt;

  for (const message of messages) {
    const timestamp = getMessageTimestamp(message, createdAt || new Date().toISOString());
    if (timestamp && (!lastActivity || timestamp > lastActivity)) {
      lastActivity = timestamp;
    }

    if (!firstMessage && message?.role === 'user') {
      const userText = getUserText(message.content);
      if (userText) firstMessage = userText;
    }

    if (message?.role === 'user') {
      const userText = getUserText(message.content);
      if (userText) lastMessage = '> ' + userText;
    } else if (message?.role === 'assistant') {
      const assistantText = getAssistantText(message.content);
      if (assistantText) lastMessage = assistantText;
    }
  }

  return {
    firstMessage: firstMessage || threadExport.title || 'Unknown Amp Session',
    lastMessage,
    lastActivity: lastActivity || null,
    createdAt: createdAt || null,
  };
}
