import type {
  CodexJsonlNormalizationContext,
  CodexJsonlNormalizationResult,
} from './history-normalizer.js';
import { normalizeCodexJsonlEntry } from './history-normalizer.js';
import { ExecToolUseMessage } from '@garcon/common/chat-types';
import { codexHistoricalAnswers } from './user-input.js';
import {
  codexCodeModeResultToolId,
  createCodexCodeModeBashMessages,
  projectCodexCodeModeCommands,
  rememberCodexCodeModeResult,
} from './code-mode-command-projection.js';

const MAX_PENDING_CALLS = 10_000;

export class LegacyCodexProjection {
  readonly #hiddenWaitCallIds = new Set<string>();
  readonly #questionCallIds = new Set<string>();
  readonly #codeModeResultToolIds = new Map<string, string>();

  project(
    entry: Record<string, unknown>,
    context: CodexJsonlNormalizationContext,
  ): CodexJsonlNormalizationResult | null {
    const payload = entry.type === 'response_item' ? record(entry.payload) : null;
    const callId = string(payload?.call_id);
    if (callId && (payload?.type === 'function_call' || payload?.type === 'custom_tool_call')) {
      this.#questionCallIds.delete(callId);
      if (payload.type === 'function_call' && payload.name === 'request_user_input') {
        this.#rememberCall(this.#questionCallIds, callId);
      }
    }
    if (isHiddenCodeModeWaitCall(payload)) {
      this.#rememberCall(this.#hiddenWaitCallIds, payload.call_id);
      return emptyResult();
    }
    if (isToolOutput(payload)) {
      if (callId && this.#hiddenWaitCallIds.delete(callId)) return emptyResult();
      if (callId && this.#questionCallIds.delete(callId)) {
        const normalized = normalizeCodexJsonlEntry(entry, context);
        const answers = codexHistoricalAnswers(payload?.output);
        for (const message of normalized?.canonical ?? []) {
          if (message.type !== 'tool-result') continue;
          message.isError = answers === null;
          if (answers) message.content = { ...message.content, toolUseResult: { answers } };
        }
        return normalized;
      }
      const resultToolId = callId ? this.#codeModeResultToolIds.get(callId) : undefined;
      if (callId && resultToolId) {
        this.#codeModeResultToolIds.delete(callId);
        return normalizeCodexJsonlEntry({
          ...entry,
          payload: { ...payload, call_id: resultToolId },
        }, context);
      }
    }
    if (isCodeModeExecCall(payload)) {
      const normalized = normalizeCodexJsonlEntry(entry, context);
      const projection = projectCodexCodeModeCommands(payload.input);
      if (!normalized || !projection) return normalized;
      const outerMessage = normalized.canonical[0];
      if (normalized.canonical.length !== 1 || !(outerMessage instanceof ExecToolUseMessage)) {
        return normalized;
      }
      rememberCodexCodeModeResult(
        this.#codeModeResultToolIds,
        payload.call_id,
        codexCodeModeResultToolId(payload.call_id, projection),
      );
      return {
        ...normalized,
        canonical: createCodexCodeModeBashMessages(
          outerMessage.timestamp,
          payload.call_id,
          projection,
        ),
      };
    }
    return normalizeCodexJsonlEntry(entry, context);
  }

  #rememberCall(callIds: Set<string>, callId: string): void {
    callIds.add(callId);
    if (callIds.size <= MAX_PENDING_CALLS) return;
    const oldest = callIds.values().next().value;
    if (oldest) callIds.delete(oldest);
  }
}

function isCodeModeExecCall(
  payload: Record<string, unknown> | null,
): payload is Record<string, unknown> & { call_id: string; input: string } {
  return payload?.type === 'custom_tool_call'
    && payload.name === 'exec'
    && Boolean(string(payload.call_id))
    && typeof payload.input === 'string';
}

function isHiddenCodeModeWaitCall(
  payload: Record<string, unknown> | null,
): payload is Record<string, unknown> & { call_id: string } {
  const callId = string(payload?.call_id);
  if (!callId) return false;
  if (payload?.type !== 'function_call' || payload.name !== 'wait') return false;
  const argumentsValue = parseArguments(payload.arguments);
  return typeof argumentsValue.cell_id === 'string' && argumentsValue.cell_id.trim().length > 0;
}

function isToolOutput(payload: Record<string, unknown> | null): boolean {
  return payload?.type === 'custom_tool_call_output'
    || payload?.type === 'function_call_output';
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return record(JSON.parse(value)) ?? {};
    } catch {
      return {};
    }
  }
  return record(value) ?? {};
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function emptyResult(): CodexJsonlNormalizationResult {
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
