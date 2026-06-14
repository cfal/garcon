// Pure normalization functions for converting Codex JSONL entries into
// ChatMessage objects. Tool conversion is delegated to codex-tool-use.js.

import { normalizeToolResultContent } from '../shared/normalize-util.js';
import {
  UserMessage,
  AssistantMessage,
  ThinkingMessage,
  WebSearchToolUseMessage,
  ToolResultMessage,
  type ChatMessage,
} from '../../../common/chat-types.js';
import { convertCodexFunctionCall, convertCodexCustomToolCall } from './jsonl-tool-use-converter.js';
import { stripResolvedFileMentionContext } from '../shared/file-mention-context.ts';

export interface CodexJsonlNormalizationResult {
  canonical: ChatMessage[];
  fallbackUser: ChatMessage[];
  fallbackAssistant: ChatMessage[];
  fallbackThinking: ChatMessage[];
  isCanonicalUser: boolean;
  isCanonicalAssistant: boolean;
  isCanonicalThinking: boolean;
}

export interface ParsedApplyPatch {
  file_path: string;
  old_string: string;
  new_string: string;
}

export interface CodexJsonlNormalizationContext {
  sourceLineNumber?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function syntheticWebSearchToolId(
  ts: string,
  action: Record<string, unknown>,
  query: string,
  queries: string[],
  context: CodexJsonlNormalizationContext,
): string {
  const actionType = asString(action.type) || '';
  const lineNumber = context.sourceLineNumber == null ? '' : String(context.sourceLineNumber);
  const fingerprint = [ts, actionType, lineNumber, query, ...queries].join('\u001f');
  return `web-search-${stableHash(fingerprint)}`;
}

function createNormalizationResult(): CodexJsonlNormalizationResult {
  return {
    canonical: [],
    fallbackUser: [],
    fallbackAssistant: [],
    fallbackThinking: [],
    isCanonicalUser: false,
    isCanonicalAssistant: false,
    isCanonicalThinking: false,
  };
}

// Extracts plaintext from Codex content arrays or raw strings.
export function extractTextContent(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  return content
    .map((item) => asRecord(item))
    .filter((item) => item.type === 'input_text' || item.type === 'output_text' || item.type === 'text')
    .map((item) => item.text)
    .filter(Boolean)
    .join('\n');
}

// Converts an apply_patch input string into an Edit-compatible payload.
// Only handles "*** Update File:" blocks; other patch operations
// (Add File, Delete File) are not expanded.
export function parseApplyPatch(input: string): ParsedApplyPatch {
  const fileMatch = input.match(/\*\*\* Update File: (.+)/);
  const filePath = fileMatch ? fileMatch[1].trim() : 'unknown';
  const lines = input.split('\n');
  const oldLines: string[] = [];
  const newLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('-') && !line.startsWith('---')) {
      oldLines.push(line.substring(1));
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      newLines.push(line.substring(1));
    }
  }

  return {
    file_path: filePath,
    old_string: oldLines.join('\n'),
    new_string: newLines.join('\n'),
  };
}

// Normalizes a single parsed JSONL entry into zero or more ChatMessage
// objects. Returns an object describing the messages produced and whether
// they represent canonical or fallback content for dedup purposes.
//
// Return shape:
//   { canonical: ChatMessage[], fallbackUser: ChatMessage[],
//     fallbackAssistant: ChatMessage[], fallbackThinking: ChatMessage[],
//     isCanonicalUser: bool, isCanonicalAssistant: bool,
//     isCanonicalThinking: bool }
//   or null when the entry should be skipped entirely.
export function normalizeCodexJsonlEntry(
  entry: unknown,
  context: CodexJsonlNormalizationContext = {},
): CodexJsonlNormalizationResult | null {
  const rawEntry = asRecord(entry);
  if (Object.keys(rawEntry).length === 0) return null;

  const ts = typeof rawEntry.timestamp === 'string' ? rawEntry.timestamp : new Date().toISOString();

  if (rawEntry.type === 'event_msg') {
    return normalizeEventMsg(rawEntry.payload, ts);
  }

  if (rawEntry.type === 'response_item') {
    return normalizeResponseItem(rawEntry.payload, ts, context);
  }

  // session_meta, turn_context, compacted -- skip
  return null;
}

function normalizeEventMsg(payload: unknown, ts: string): CodexJsonlNormalizationResult | null {
  const rawPayload = asRecord(payload);
  if (Object.keys(rawPayload).length === 0) return null;
  const result = createNormalizationResult();

  switch (rawPayload.type) {
    case 'user_message': {
      const text = asString(rawPayload.message);
      if (text?.trim()) {
        result.isCanonicalUser = true;
        result.canonical.push(new UserMessage(ts, stripResolvedFileMentionContext(text)));
      }
      return result;
    }

    case 'agent_message': {
      const text = asString(rawPayload.message);
      if (text?.trim()) {
        result.fallbackAssistant.push(new AssistantMessage(ts, text));
      }
      return result;
    }

    case 'agent_reasoning': {
      // Reasoning text lives in payload.message (sometimes payload.text).
      const text = asString(rawPayload.message) || asString(rawPayload.text);
      if (text?.trim()) {
        result.fallbackThinking.push(new ThinkingMessage(ts, text));
      }
      return result;
    }

    // Operational events -- skip from chat transcript
    case 'token_count':
    case 'task_started':
    case 'task_complete':
    case 'turn_aborted':
    case 'context_compacted':
      return null;

    default:
      return null;
  }
}

function normalizeResponseItem(
  payload: unknown,
  ts: string,
  context: CodexJsonlNormalizationContext,
): CodexJsonlNormalizationResult | null {
  const rawPayload = asRecord(payload);
  if (Object.keys(rawPayload).length === 0) return null;
  const result = createNormalizationResult();

  switch (rawPayload.type) {
    case 'message': {
      if (rawPayload.role === 'developer') return null;

      if (rawPayload.role === 'assistant') {
        const textContent = extractTextContent(rawPayload.content);
        if (textContent?.trim()) {
          result.isCanonicalAssistant = true;
          result.canonical.push(new AssistantMessage(ts, textContent));
        }
        return result;
      }

      if (rawPayload.role === 'user') {
        const textContent = extractTextContent(rawPayload.content);
        if (textContent?.trim()) {
          result.fallbackUser.push(new UserMessage(ts, stripResolvedFileMentionContext(textContent)));
        }
        return result;
      }

      return result;
    }

    case 'reasoning': {
      const summary = Array.isArray(rawPayload.summary) ? rawPayload.summary : [];
      const summaryText = summary
        .map((item) => asString(asRecord(item).text))
        .filter(Boolean)
        .join('\n');
      if (summaryText?.trim()) {
        result.isCanonicalThinking = true;
        result.canonical.push(new ThinkingMessage(ts, summaryText));
      }
      // Entries with only encrypted_content and no summary produce nothing.
      return result;
    }

    case 'function_call': {
      result.canonical.push(convertCodexFunctionCall(ts, rawPayload));
      return result;
    }

    case 'function_call_output': {
      result.canonical.push(new ToolResultMessage(ts, asString(rawPayload.call_id) || '', normalizeToolResultContent(rawPayload.output), false));
      return result;
    }

    case 'custom_tool_call': {
      result.canonical.push(convertCodexCustomToolCall(ts, rawPayload, parseApplyPatch));
      return result;
    }

    case 'custom_tool_call_output': {
      result.canonical.push(new ToolResultMessage(ts, asString(rawPayload.call_id) || '', normalizeToolResultContent(rawPayload.output), false));
      return result;
    }

    case 'web_search_call': {
      const action = asRecord(rawPayload.action);
      const queries = Array.isArray(action.queries) ? action.queries.filter((value): value is string => typeof value === 'string') : [];
      const query = asString(action.query)
        || queries.join(', ')
        || '';
      const toolId = asString(rawPayload.id) || syntheticWebSearchToolId(ts, action, query, queries, context);
      result.canonical.push(new WebSearchToolUseMessage(ts, toolId, query));
      // Synthetic tool-result summarizing status
      if (rawPayload.status === 'completed' || rawPayload.status === 'searching') {
        result.canonical.push(new ToolResultMessage(ts, toolId, normalizeToolResultContent(query ? `Searched: ${query}` : 'Web search completed'), false));
      }
      return result;
    }

    // Internal metadata -- not rendered in chat transcript
    case 'ghost_snapshot':
      return null;

    default:
      return null;
  }
}
