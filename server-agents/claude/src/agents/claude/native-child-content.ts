import {
  AssistantMessage, CompactionMessage, ThinkingMessage, ToolResultMessage, UserMessage,
  type ChatMessage,
} from '@garcon/common/chat-types';
import { isRecord } from '@garcon/common/json';
import type { AgentProducedRow } from '@garcon/server-agent-interface';
import { extractCompactionSummary, parseCompactMetadata } from './compaction.js';
import { convertClaudeToolUse } from './tool-use-converter.js';
import { claudeToolResultContent } from './tool-result-converter.js';

// Observation retains provider-authored child inputs instead of applying root submission filters.
export function convertClaudeChildContent(frame: unknown, timestamp: string): AgentProducedRow[] {
  if (!isRecord(frame) || (frame.type !== 'user' && frame.type !== 'assistant')
    || !isRecord(frame.message)) throw new TypeError('Invalid Claude child content');
  const raw = frame.message.content;
  const blocks: unknown[] = typeof raw === 'string' ? [{ type: 'text', text: raw }] :
    Array.isArray(raw) ? raw : invalidContent();
  const messages: ChatMessage[] = [];
  for (const part of blocks) {
    if (!isRecord(part) || typeof part.type !== 'string') throw new TypeError('Invalid Claude child block');
    switch (part.type) {
      case 'text': {
        if (typeof part.text !== 'string') throw new TypeError('Invalid Claude child text');
        if (!part.text) break;
        if (frame.isCompactSummary === true) {
          const info = parseCompactMetadata(frame.compactMetadata ?? frame.compact_metadata);
          messages.push(new CompactionMessage(timestamp, info.trigger,
            extractCompactionSummary(part.text), info.preTokens, info.postTokens));
        } else {
          messages.push(frame.type === 'user'
            ? new UserMessage(timestamp, part.text) : new AssistantMessage(timestamp, part.text));
        }
        break;
      }
      case 'thinking':
        if (typeof part.thinking !== 'string') throw new TypeError('Invalid Claude child thinking');
        messages.push(new ThinkingMessage(timestamp, part.thinking));
        break;
      case 'tool_use':
        messages.push(convertClaudeToolUse(timestamp, part));
        break;
      case 'tool_result':
        if (typeof part.tool_use_id !== 'string') throw new TypeError('Invalid Claude child result');
        messages.push(new ToolResultMessage(timestamp, part.tool_use_id,
          claudeToolResultContent(part.content, frame.tool_use_result ?? frame.toolUseResult),
          part.is_error === true));
        break;
      case 'image': {
        const source = part.source;
        if (!isRecord(source) || source.type !== 'base64' || typeof source.data !== 'string'
          || typeof source.media_type !== 'string') throw new TypeError('Unsupported Claude child image');
        messages.push(new UserMessage(timestamp, '', [{
          data: source.data, mimeType: source.media_type, name: 'Child attachment',
        }]));
        break;
      }
      case 'redacted_thinking': break;
      default: break;
    }
  }
  return messages.map((message, withinSourceOrdinal) => ({
    message,
    ...(typeof frame.uuid === 'string' ? { providerMeta: { entryId: frame.uuid, withinSourceOrdinal } } : {}),
  }));
}

function invalidContent(): never {
  throw new TypeError('Invalid Claude child content');
}
