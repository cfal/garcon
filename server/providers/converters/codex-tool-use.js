// Converts Codex JSONL function_call and custom_tool_call payloads
// directly into concrete ToolUseMessage subclasses. Owns all
// Codex-specific field extraction for historical JSONL replay.

import {
  BashToolUseMessage,
  EditToolUseMessage,
  WriteStdinToolUseMessage,
  UpdatePlanToolUseMessage,
  UnknownToolUseMessage,
} from '../../../common/chat-types.js';
import { normalizeToolInput, normalizeTodoItems } from '../normalize-util.js';

function asObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/**
 * Converts a Codex function_call payload into a concrete ToolUseMessage.
 * Handles shell_command, exec_command, write_stdin, and update_plan directly.
 */
export function convertCodexFunctionCall(ts, payload) {
  const rawName = typeof payload?.name === 'string' ? payload.name : 'unknown';
  const callId = payload?.call_id || '';
  const rawArgs = payload?.arguments;

  if (rawName === 'shell_command' || rawName === 'exec_command') {
    let command;
    if (typeof rawArgs === 'string') {
      try {
        const parsed = JSON.parse(rawArgs || '{}');
        command = parsed.command || parsed.cmd;
      } catch { /* malformed JSON -- fall through */ }
    } else if (rawArgs && typeof rawArgs === 'object') {
      command = rawArgs.command || rawArgs.cmd;
    }

    if (typeof command === 'string' && command.length > 0) {
      return new BashToolUseMessage(ts, callId, rawName, command);
    }

    return new UnknownToolUseMessage(ts, callId, rawName, asObject(normalizeToolInput(rawArgs)));
  }

  if (rawName === 'write_stdin') {
    return new WriteStdinToolUseMessage(ts, callId, rawName, asObject(normalizeToolInput(rawArgs)));
  }

  if (rawName === 'update_plan') {
    const input = asObject(normalizeToolInput(rawArgs));
    return new UpdatePlanToolUseMessage(ts, callId, rawName, normalizeTodoItems(input.items ?? input.todos ?? input.plan));
  }

  return new UnknownToolUseMessage(ts, callId, rawName, asObject(normalizeToolInput(rawArgs)));
}

/**
 * Converts a Codex custom_tool_call payload into a concrete ToolUseMessage.
 * Handles apply_patch by parsing the diff into EditToolUseMessage fields.
 */
export function convertCodexCustomToolCall(ts, payload, parseApplyPatch) {
  const rawName = typeof payload?.name === 'string' ? payload.name : 'custom_tool';
  const callId = payload?.call_id || '';
  const rawInput = payload?.input;

  if (rawName === 'apply_patch') {
    const parsed = parseApplyPatch(rawInput || '');
    return new EditToolUseMessage(
      ts,
      callId,
      rawName,
      parsed.file_path,
      parsed.old_string,
      parsed.new_string,
    );
  }

  return new UnknownToolUseMessage(ts, callId, rawName, asObject(normalizeToolInput(rawInput)));
}
