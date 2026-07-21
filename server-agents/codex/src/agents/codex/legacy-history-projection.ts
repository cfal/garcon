import type {
  CodexJsonlNormalizationContext,
  CodexJsonlNormalizationResult,
} from './history-normalizer.js';
import { normalizeCodexJsonlEntry } from './history-normalizer.js';

const MAX_PENDING_HIDDEN_WAIT_CALLS = 10_000;

export class LegacyCodexProjection {
  readonly #hiddenWaitCallIds = new Set<string>();

  project(
    entry: Record<string, unknown>,
    context: CodexJsonlNormalizationContext,
  ): CodexJsonlNormalizationResult | null {
    const payload = entry.type === 'response_item' ? record(entry.payload) : null;
    if (isHiddenCodeModeWaitCall(payload)) {
      this.#rememberHiddenWait(payload.call_id);
      return emptyResult();
    }
    if (isToolOutput(payload)) {
      const callId = string(payload?.call_id);
      if (callId && this.#hiddenWaitCallIds.delete(callId)) return emptyResult();
    }
    return normalizeCodexJsonlEntry(entry, context);
  }

  #rememberHiddenWait(callId: string): void {
    this.#hiddenWaitCallIds.add(callId);
    if (this.#hiddenWaitCallIds.size <= MAX_PENDING_HIDDEN_WAIT_CALLS) return;
    const oldest = this.#hiddenWaitCallIds.values().next().value;
    if (oldest) this.#hiddenWaitCallIds.delete(oldest);
  }
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
