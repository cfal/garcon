import {
  AssistantMessage,
  ThinkingMessage,
  ToolResultMessage,
  UserMessage,
  type ChatImage,
  type ChatMessage,
} from '../../../common/chat-types.js';
import { normalizeToolResultContent } from '../shared/normalize-util.js';
import { convertPiToolUse } from './pi-tool-use.js';
import { stripResolvedFileMentionContext } from '../../chats/file-mentions.ts';

interface PiTextContent {
  type: 'text';
  text?: string;
}

interface PiThinkingContent {
  type: 'thinking';
  thinking?: string;
}

interface PiImageContent {
  type: 'image';
  data?: string;
  mimeType?: string;
}

interface PiToolCall {
  type: 'toolCall';
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

type PiContent = PiTextContent | PiThinkingContent | PiImageContent | PiToolCall;

interface PiMessage {
  role?: string;
  content?: string | PiContent[];
  timestamp?: number | string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

interface ConvertPiMessageOptions {
  includeToolCalls?: boolean;
  includeToolResults?: boolean;
  includeUser?: boolean;
}

function toIsoString(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

function isContentPart(value: unknown): value is PiContent {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).type === 'string';
}

function contentParts(content: PiMessage['content']): PiContent[] {
  return Array.isArray(content) ? content.filter(isContentPart) : [];
}

function textFromContent(content: PiMessage['content']): string {
  if (typeof content === 'string') return content.trim();
  return contentParts(content)
    .filter((part): part is PiTextContent => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text!.trim())
    .filter(Boolean)
    .join('\n');
}

function imageDataUrl(part: PiImageContent): string | null {
  if (!part.data || !part.mimeType) return null;
  if (part.data.startsWith('data:')) return part.data;
  return `data:${part.mimeType};base64,${part.data}`;
}

function imagesFromContent(content: PiMessage['content']): ChatImage[] | undefined {
  const images = contentParts(content)
    .filter((part): part is PiImageContent => part.type === 'image')
    .map((part, index) => {
      const data = imageDataUrl(part);
      if (!data) return null;
      return { data, name: `image-${index + 1}` };
    })
    .filter((image): image is ChatImage => image !== null);
  return images.length > 0 ? images : undefined;
}

function convertAssistantMessage(
  timestamp: string,
  message: PiMessage,
  options: Required<ConvertPiMessageOptions>,
): ChatMessage[] {
  if (typeof message.content === 'string') {
    const text = message.content.trim();
    return text ? [new AssistantMessage(timestamp, text)] : [];
  }

  const messages: ChatMessage[] = [];
  for (const part of contentParts(message.content)) {
    if (part.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.trim()) {
      messages.push(new ThinkingMessage(timestamp, part.thinking));
    } else if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      messages.push(new AssistantMessage(timestamp, part.text));
    } else if (part.type === 'toolCall' && options.includeToolCalls) {
      messages.push(convertPiToolUse(timestamp, part.id || '', part.name || 'Unknown', part.arguments ?? {}));
    }
  }
  return messages;
}

export function convertPiMessage(
  raw: unknown,
  options: ConvertPiMessageOptions = {},
): ChatMessage[] {
  if (!raw || typeof raw !== 'object') return [];
  const message = raw as PiMessage;
  const timestamp = toIsoString(message.timestamp);
  const settings: Required<ConvertPiMessageOptions> = {
    includeToolCalls: options.includeToolCalls ?? true,
    includeToolResults: options.includeToolResults ?? true,
    includeUser: options.includeUser ?? true,
  };

  if (message.role === 'user') {
    if (!settings.includeUser) return [];
    const text = textFromContent(message.content);
    const images = imagesFromContent(message.content);
    if (!text && !images?.length) return [];
    return [new UserMessage(timestamp, stripResolvedFileMentionContext(text), images)];
  }

  if (message.role === 'assistant') {
    return convertAssistantMessage(timestamp, message, settings);
  }

  if (message.role === 'toolResult' && settings.includeToolResults) {
    return [
      new ToolResultMessage(
        timestamp,
        message.toolCallId || '',
        normalizeToolResultContent(message.content),
        Boolean(message.isError),
      ),
    ];
  }

  return [];
}
