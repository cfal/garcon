import {
  AssistantMessage,
  ErrorMessage,
  ThinkingMessage,
  ToolResultMessage,
  UserMessage,
  type ChatMessage,
} from '../../../common/chat-types.js';
import { convertAmpToolUse } from '../converters/amp-tool-use.js';
import { normalizeToolResultContent } from '../normalize-util.js';

export interface AmpContentPart {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  toolUseID?: string;
  run?: Record<string, unknown>;
}

export interface AmpThreadMessage {
  role?: string;
  messageId?: number;
  content?: AmpContentPart[];
  meta?: { sentAt?: number | string };
  usage?: { timestamp?: number | string };
  createdAt?: number | string;
}

export interface AmpThreadExport {
  created?: number | string;
  title?: string;
  messages?: AmpThreadMessage[];
}

export interface AmpPreview {
  firstMessage: string;
  lastMessage: string;
  lastActivity: string | null;
  createdAt: string | null;
}

function toIsoString(value: number | string | undefined): string | null {
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

function getMessageTimestamp(message: AmpThreadMessage, fallbackTimestamp: string): string {
  const directTimestamp =
    toIsoString(message.meta?.sentAt) ||
    toIsoString(message.usage?.timestamp) ||
    toIsoString(message.createdAt);
  return directTimestamp || fallbackTimestamp;
}

function getTextParts(content: AmpContentPart[]): string[] {
  return content
    .filter((part): part is AmpContentPart & { text: string } =>
      part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text.trim())
    .filter(Boolean);
}

function getUserText(content: AmpContentPart[]): string {
  return getTextParts(content).join('\n');
}

function getAssistantText(content: AmpContentPart[]): string {
  return getTextParts(content).at(-1) || '';
}

interface ToolResultPayload {
  content: Record<string, unknown>;
  isError: boolean;
}

function getToolResultPayload(part: AmpContentPart): ToolResultPayload {
  const status = typeof part.run?.status === 'string' ? part.run.status : null;

  if (status && status !== 'done') {
    return {
      content: normalizeToolResultContent(part.run),
      isError: true,
    };
  }

  if (part.run?.result !== undefined) {
    return {
      content: normalizeToolResultContent(part.run.result),
      isError: false,
    };
  }

  return {
    content: normalizeToolResultContent(part.run ?? {}),
    isError: false,
  };
}

function getSortedMessages(threadExport: AmpThreadExport): AmpThreadMessage[] {
  const messages = Array.isArray(threadExport.messages) ? [...threadExport.messages] : [];
  return messages.sort((a, b) => (a.messageId ?? 0) - (b.messageId ?? 0));
}

export function loadAmpChatMessages(threadExport: AmpThreadExport): ChatMessage[] {
  if (!threadExport || typeof threadExport !== 'object') return [];

  const createdAt = toIsoString(threadExport.created) || new Date().toISOString();
  const messages: ChatMessage[] = [];

  for (const message of getSortedMessages(threadExport)) {
    const timestamp = getMessageTimestamp(message, createdAt);
    const content: AmpContentPart[] = Array.isArray(message.content) ? message.content : [];

    if (message.role === 'user') {
      for (const part of content) {
        if (part.type !== 'tool_result') continue;
        const { content: resultContent, isError } = getToolResultPayload(part);
        messages.push(new ToolResultMessage(timestamp, part.toolUseID || '', resultContent, isError));
      }

      const text = getUserText(content);
      if (text) {
        messages.push(new UserMessage(timestamp, text));
      }
      continue;
    }

    if (message.role === 'assistant') {
      for (const part of content) {
        if (part.type === 'thinking' && part.thinking) {
          messages.push(new ThinkingMessage(timestamp, part.thinking));
        } else if (part.type === 'text' && part.text?.trim()) {
          messages.push(new AssistantMessage(timestamp, part.text));
        } else if (part.type === 'tool_use') {
          messages.push(convertAmpToolUse(timestamp, part));
        }
      }
      continue;
    }

    if (message.role === 'info') {
      const infoText = getUserText(content);
      if (infoText) {
        messages.push(new ErrorMessage(timestamp, infoText));
      }
    }
  }

  return messages;
}

export function getAmpPreview(threadExport: AmpThreadExport): AmpPreview | null {
  if (!threadExport || typeof threadExport !== 'object') return null;

  const createdAt = toIsoString(threadExport.created);
  const messages = getSortedMessages(threadExport);

  let firstMessage: string | null = null;
  let lastMessage = '';
  let lastActivity = createdAt;

  for (const message of messages) {
    const timestamp = getMessageTimestamp(message, createdAt || new Date().toISOString());
    if (timestamp && (!lastActivity || timestamp > lastActivity)) {
      lastActivity = timestamp;
    }

    const content: AmpContentPart[] = Array.isArray(message.content) ? message.content : [];

    if (!firstMessage && message.role === 'user') {
      const userText = getUserText(content);
      if (userText) firstMessage = userText;
    }

    if (message.role === 'user') {
      const userText = getUserText(content);
      if (userText) lastMessage = '> ' + userText;
    } else if (message.role === 'assistant') {
      const assistantText = getAssistantText(content);
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
