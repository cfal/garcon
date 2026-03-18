// Pure normalization functions for converting Codex JSONL entries into
// ChatMessage objects. Tool conversion is delegated to codex-tool-use.js.

import { normalizeToolResultContent } from '../normalize-util.js';
import { UserMessage, AssistantMessage, ThinkingMessage, WebSearchToolUseMessage, ToolResultMessage } from '../../../common/chat-types.js';
import { convertCodexFunctionCall, convertCodexCustomToolCall } from '../converters/codex-tool-use.js';

// Extracts plaintext from Codex content arrays or raw strings.
export function extractTextContent(content) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  return content
    .filter(item => item.type === 'input_text' || item.type === 'output_text' || item.type === 'text')
    .map(item => item.text)
    .filter(Boolean)
    .join('\n');
}

// Converts an apply_patch input string into an Edit-compatible payload.
// Only handles "*** Update File:" blocks; other patch operations
// (Add File, Delete File) are not expanded.
export function parseApplyPatch(input) {
  const fileMatch = input.match(/\*\*\* Update File: (.+)/);
  const filePath = fileMatch ? fileMatch[1].trim() : 'unknown';
  const lines = input.split('\n');
  const oldLines = [];
  const newLines = [];

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
// they represent canonical (response_item) or fallback (event_msg)
// content for dedup purposes.
//
// Return shape:
//   { canonical: ChatMessage[], fallbackAssistant: ChatMessage[],
//     fallbackThinking: ChatMessage[], isCanonicalAssistant: bool,
//     isCanonicalThinking: bool }
//   or null when the entry should be skipped entirely.
export function normalizeCodexJsonlEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;

  const ts = entry.timestamp || new Date().toISOString();

  if (entry.type === 'event_msg') {
    return normalizeEventMsg(entry.payload, ts);
  }

  if (entry.type === 'response_item') {
    return normalizeResponseItem(entry.payload, ts);
  }

  // session_meta, turn_context, compacted -- skip
  return null;
}

function normalizeEventMsg(payload, ts) {
  if (!payload) return null;
  const result = {
    canonical: [],
    fallbackAssistant: [],
    fallbackThinking: [],
    isCanonicalAssistant: false,
    isCanonicalThinking: false,
  };

  switch (payload.type) {
    case 'user_message': {
      const text = payload.message;
      if (text?.trim()) {
        result.canonical.push(new UserMessage(ts, text));
      }
      return result;
    }

    case 'agent_message': {
      const text = payload.message;
      if (text?.trim()) {
        result.fallbackAssistant.push(new AssistantMessage(ts, text));
      }
      return result;
    }

    case 'agent_reasoning': {
      // Reasoning text lives in payload.message (sometimes payload.text).
      const text = payload.message || payload.text;
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

function normalizeResponseItem(payload, ts) {
  if (!payload) return null;
  const result = {
    canonical: [],
    fallbackAssistant: [],
    fallbackThinking: [],
    isCanonicalAssistant: false,
    isCanonicalThinking: false,
  };

  switch (payload.type) {
    case 'message': {
      if (payload.role === 'developer') return null;

      if (payload.role === 'assistant') {
        const textContent = extractTextContent(payload.content);
        if (textContent?.trim()) {
          result.isCanonicalAssistant = true;
          result.canonical.push(new AssistantMessage(ts, textContent));
        }
        return result;
      }

      if (payload.role === 'user') {
        const textContent = extractTextContent(payload.content);
        if (textContent?.trim()) {
          result.canonical.push(new UserMessage(ts, textContent));
        }
        return result;
      }

      return result;
    }

    case 'reasoning': {
      const summaryText = payload.summary
        ?.map(s => s.text)
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
      result.canonical.push(convertCodexFunctionCall(ts, payload));
      return result;
    }

    case 'function_call_output': {
      result.canonical.push(new ToolResultMessage(ts, payload.call_id || '', normalizeToolResultContent(payload.output), false));
      return result;
    }

    case 'custom_tool_call': {
      result.canonical.push(convertCodexCustomToolCall(ts, payload, parseApplyPatch));
      return result;
    }

    case 'custom_tool_call_output': {
      result.canonical.push(new ToolResultMessage(ts, payload.call_id || '', normalizeToolResultContent(payload.output), false));
      return result;
    }

    case 'web_search_call': {
      const query = payload.action?.query
        || (payload.action?.queries || []).join(', ')
        || '';
      result.canonical.push(new WebSearchToolUseMessage(ts, payload.id || `web-search-${Date.now()}`, query));
      // Synthetic tool-result summarizing status
      if (payload.status === 'completed' || payload.status === 'searching') {
        result.canonical.push(new ToolResultMessage(ts, payload.id || `web-search-${Date.now()}`, normalizeToolResultContent(query ? `Searched: ${query}` : 'Web search completed'), false));
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
