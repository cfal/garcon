// Converts Codex JSONL function_call and custom_tool_call payloads
// directly into concrete ToolUseMessage subclasses. Owns all
// Codex-specific field extraction for historical JSONL replay.

import {
  BashToolUseMessage,
  EditToolUseMessage,
  ExecToolUseMessage,
  WaitToolUseMessage,
  WriteStdinToolUseMessage,
  UpdatePlanToolUseMessage,
  UnknownToolUseMessage,
  type ToolUseChatMessage,
} from '../../../common/chat-types.js';
import { normalizeToolInput, normalizeTodoItems } from '../shared/normalize-util.js';
import { convertCodexSubagentToolUse } from './subagent-tool-use.js';

interface ApplyPatchPayload {
  file_path: string;
  old_string: string;
  new_string: string;
}

type ApplyPatchParser = (input: string) => ApplyPatchPayload;

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function convertCodexWaitFunctionCall(
  ts: string,
  callId: string,
  rawArgs: unknown,
): WaitToolUseMessage | null {
  const input = asObject(normalizeToolInput(rawArgs));
  const executionId = asString(input.cell_id);
  if (executionId === undefined) return null;
  return new WaitToolUseMessage(
    ts,
    callId,
    executionId,
    asNumber(input.yield_time_ms),
    asNumber(input.max_tokens),
    asBoolean(input.terminate),
  );
}

/**
 * Converts a Codex function_call payload into a concrete ToolUseMessage.
 * Handles shell_command, exec_command, write_stdin, and update_plan directly.
 */
export function convertCodexFunctionCall(ts: string, payload: unknown): ToolUseChatMessage {
  const rawPayload = asObject(payload);
  const rawName = typeof rawPayload.name === 'string' ? rawPayload.name : 'unknown';
  const callId = typeof rawPayload.call_id === 'string' ? rawPayload.call_id : '';
  const rawArgs = rawPayload.arguments;
  const input = asObject(normalizeToolInput(rawArgs));

  const subagentToolUse = convertCodexSubagentToolUse(ts, callId, rawName, input);
  if (subagentToolUse) return subagentToolUse;

  if (rawName === 'wait') {
    return convertCodexWaitFunctionCall(ts, callId, rawArgs)
      ?? new UnknownToolUseMessage(ts, callId, rawName, input);
  }

  if (rawName === 'shell_command' || rawName === 'exec_command') {
    let command: string | undefined;
    if (typeof rawArgs === 'string') {
      try {
        const parsed = asObject(JSON.parse(rawArgs || '{}'));
        command = asString(parsed.command) || asString(parsed.cmd);
      } catch { /* malformed JSON -- fall through */ }
    } else {
      const parsed = asObject(rawArgs);
      command = asString(parsed.command) || asString(parsed.cmd);
    }

    if (typeof command === 'string' && command.length > 0) {
      return new BashToolUseMessage(ts, callId, command);
    }

    return new UnknownToolUseMessage(ts, callId, rawName, asObject(normalizeToolInput(rawArgs)));
  }

  if (rawName === 'write_stdin') {
    return new WriteStdinToolUseMessage(ts, callId, input);
  }

  if (rawName === 'update_plan') {
    return new UpdatePlanToolUseMessage(ts, callId, normalizeTodoItems(input.items ?? input.todos ?? input.plan));
  }

  return new UnknownToolUseMessage(ts, callId, rawName, input);
}

/**
 * Converts a Codex custom_tool_call payload into a concrete ToolUseMessage.
 * Handles apply_patch by parsing the diff into EditToolUseMessage fields.
 */
export function convertCodexCustomToolCall(
  ts: string,
  payload: unknown,
  parseApplyPatch: ApplyPatchParser,
): ToolUseChatMessage {
  const rawPayload = asObject(payload);
  const rawName = typeof rawPayload.name === 'string' ? rawPayload.name : 'custom_tool';
  const callId = typeof rawPayload.call_id === 'string' ? rawPayload.call_id : '';
  const rawInput = rawPayload.input;

  if (rawName === 'exec' && typeof rawInput === 'string') {
    return new ExecToolUseMessage(ts, callId, rawInput, 'javascript');
  }

  if (rawName === 'apply_patch') {
    const parsed = parseApplyPatch(typeof rawInput === 'string' ? rawInput : '');
    return new EditToolUseMessage(
      ts,
      callId,
      parsed.file_path,
      parsed.old_string,
      parsed.new_string,
    );
  }

  return new UnknownToolUseMessage(ts, callId, rawName, asObject(normalizeToolInput(rawInput)));
}
