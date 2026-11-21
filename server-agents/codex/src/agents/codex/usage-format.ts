import { isRecord } from '@garcon/common/json';
import { parseFirstJsonlValue } from '@garcon/server-agent-common/lib/jsonl';
import {
  parseTimestampMs,
  type MalformedUsage,
  type TranscriptUsageFormat,
  type UsageRecord,
  type UsageSpeed,
} from '@garcon/server-agent-common/usage/usage-record';

// Mirrors codex-rs TokenUsage at the pinned 0.169.0:
// https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/protocol/src/protocol.rs#L2545-L2565
interface CodexTokenUsage {
  readonly input_tokens: number;
  readonly cached_input_tokens: number;
  readonly cache_write_input_tokens: number;
  readonly output_tokens: number;
  readonly reasoning_output_tokens: number;
  readonly total_tokens: number;
}

const USAGE_FIELDS = [
  'input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
] as const satisfies readonly (keyof CodexTokenUsage)[];

// Native forks restamp inherited usage in a burst.
const FORK_COPY_MAX_GAP_MS = 1000;
const NATIVE_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface UsageTurn {
  readonly id: string;
  model: string;
  speed: UsageSpeed | null;
  hasContext: boolean;
}

/**
 * Usage events carry neither model nor service tier. Turn start freezes the settings
 * before compaction or live edits; `turn_context` supplies the confirmed model. Codex writes a
 * `token_usage_record` for every billed response, including remote compaction,
 * before that response's `token_count`:
 * https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/core/src/session/mod.rs#L5697-L5719
 * Once a session has records they alone are billed; `token_count` then reports
 * context size, which after compaction is an estimate rather than a request.
 * Rollouts written before records existed bill `token_count` deltas, validated
 * against the cumulative counters, whose previous value is the next baseline.
 */
export interface CodexUsageState {
  model: string;
  threadModel: string | null;
  threadSpeed: UsageSpeed | null;
  turn: UsageTurn | null;
  sessionId: string;
  sawSessionMeta: boolean;
  lastUsageSignature: string | null;
  lastCumulativeUsage: CodexTokenUsage | null;
  forkThreadId: string | null;
  forkCopyAnchorMs: number | null;
  sawUsageRecord: boolean;
}

export function createCodexUsageState(): CodexUsageState {
  return {
    model: '',
    threadModel: null,
    threadSpeed: null,
    turn: null,
    sessionId: '',
    sawSessionMeta: false,
    lastUsageSignature: null,
    lastCumulativeUsage: null,
    forkThreadId: null,
    forkCopyAnchorMs: null,
    sawUsageRecord: false,
  };
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readTokenUsage(value: unknown): CodexTokenUsage | null {
  if (!isRecord(value)) return null;
  const input = value.input_tokens;
  const output = value.output_tokens;
  if (typeof input !== 'number' || typeof output !== 'number') return null;
  return validTokenUsage({
    input_tokens: input,
    cached_input_tokens: value.cached_input_tokens ?? 0,
    cache_write_input_tokens: value.cache_write_input_tokens ?? 0,
    output_tokens: output,
    reasoning_output_tokens: value.reasoning_output_tokens ?? 0,
    total_tokens: value.total_tokens ?? input + output,
  });
}

function validTokenUsage(usage: Record<keyof CodexTokenUsage, unknown>): CodexTokenUsage | null {
  if (!USAGE_FIELDS.every((field) => nonNegativeInteger(usage[field]))) return null;
  const valid = usage as unknown as CodexTokenUsage;
  return valid.cached_input_tokens + valid.cache_write_input_tokens <= valid.input_tokens
    && valid.reasoning_output_tokens <= valid.output_tokens
    && valid.total_tokens >= valid.input_tokens + valid.output_tokens
    ? valid
    : null;
}

function combineUsage(
  left: CodexTokenUsage | null,
  right: CodexTokenUsage,
  sign: 1 | -1,
): CodexTokenUsage | null {
  return validTokenUsage(Object.fromEntries(
    USAGE_FIELDS.map((field) => [field, (left?.[field] ?? 0) + sign * right[field]]),
  ) as Record<keyof CodexTokenUsage, number>);
}

function sameUsage(left: CodexTokenUsage, right: CodexTokenUsage): boolean {
  return USAGE_FIELDS.every((field) => left[field] === right[field]);
}

function isForkedSessionMeta(payload: Record<string, unknown>): boolean {
  if (typeof payload.forked_from_id === 'string') return true;
  const source = isRecord(payload.source) ? payload.source : null;
  const subagent = source && isRecord(source.subagent) ? source.subagent : null;
  const spawn = subagent && isRecord(subagent.thread_spawn) ? subagent.thread_spawn : null;
  return typeof spawn?.parent_thread_id === 'string';
}

// An omitted tier or the native `default` sentinel means Standard; `fast` aliases priority.
// Mirrors codex-rs ServiceTier at the pinned 0.169.0:
// https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/protocol/src/config_types.rs#L528-L531
function usageSpeedFromServiceTier(serviceTier: unknown): UsageSpeed {
  if (serviceTier === 'priority' || serviceTier === 'fast') return 'fast';
  if (serviceTier == null || serviceTier === 'default') return 'standard';
  return serviceTier === 'flex' || serviceTier === 'ultrafast' ? serviceTier : 'unknown';
}

function consumeForkCopy(state: CodexUsageState, timestampMs: number, threadId?: unknown): boolean {
  if (state.forkCopyAnchorMs === null) return false;
  // Verbatim forks retain the original response's thread ID and dedupe by response ID;
  // a mismatch alone does not identify a restamped copy.
  // https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/protocol/src/protocol.rs#L2568-L2576
  const belongsToChild = state.forkThreadId !== null && threadId === state.forkThreadId;
  if (!belongsToChild && timestampMs - state.forkCopyAnchorMs < FORK_COPY_MAX_GAP_MS) {
    state.forkCopyAnchorMs = timestampMs;
    return true;
  }
  state.forkCopyAnchorMs = null;
  state.lastUsageSignature = null;
  return false;
}

function usageRecord(
  sessionId: string, model: string, timestampMs: number, usage: CodexTokenUsage, speed: UsageSpeed | null, dedupeKey: string,
): UsageRecord {
  return {
    timestampMs,
    model,
    sessionId,
    totals: {
      // Codex reports input_tokens inclusive of cache reads and writes.
      uncachedInputTokens: usage.input_tokens - usage.cached_input_tokens - usage.cache_write_input_tokens,
      cachedInputTokens: usage.cached_input_tokens,
      cacheWriteTokens: usage.cache_write_input_tokens,
      outputTokens: usage.output_tokens,
      reasoningTokens: usage.reasoning_output_tokens,
    },
    cacheWrite1hTokens: 0,
    speed: speed ?? 'standard',
    dedupeKey,
  };
}

// Bills one response. Its id identifies the request across verbatim and restamped fork copies.
function parseUsageRecord(entry: Record<string, unknown>, payload: Record<string, unknown>, state: CodexUsageState): UsageRecord | MalformedUsage | null {
  const timestampMs = parseTimestampMs(entry.timestamp);
  // Even a skipped copy makes its delayed token_count context-only.
  state.sawUsageRecord = true;
  if (timestampMs !== null && consumeForkCopy(state, timestampMs, payload.thread_id)) return null;
  const usage = readTokenUsage(payload.usage);
  const responseId = payload.response_id;
  const turn = state.turn?.id === payload.turn_id ? state.turn : null;
  const model = turn?.model ?? state.model;
  if (timestampMs === null || model.length === 0 || usage === null
    || typeof responseId !== 'string' || responseId.length === 0) {
    return { malformed: true, timestampMs };
  }
  if (usage.input_tokens + usage.output_tokens === 0) return null;
  let speed = state.threadSpeed;
  if (state.turn) speed = turn?.speed ?? 'unknown';
  return usageRecord(state.sessionId, model, timestampMs, usage, speed, `codex-response:${responseId}`);
}

export function parseCodexUsageLine(line: string, state: CodexUsageState): UsageRecord | MalformedUsage | null {
  // Tolerates a line that lost its newline the way the history loader does.
  const parsed = parseFirstJsonlValue(line);
  // Only marked lines are parsed, so a corrupt one may have held a request or its context.
  if (parsed.kind === 'invalid' || parsed.kind === 'incomplete') return { malformed: true, timestampMs: null };
  if (parsed.kind === 'empty') return null;
  const entry = parsed.value;
  if (!isRecord(entry) || !isRecord(entry.payload)) return null;
  const payload = entry.payload;

  if (entry.type === 'session_meta') {
    // Only the first meta names this session; copied ancestor metas would misattribute later records.
    if (state.sawSessionMeta) return null;
    state.sawSessionMeta = true;
    const id = payload.id ?? payload.session_id;
    if (typeof id === 'string') state.sessionId = id;
    const metaTimestampMs = parseTimestampMs(entry.timestamp);
    if (metaTimestampMs !== null && isForkedSessionMeta(payload)) {
      if (typeof payload.id === 'string' && NATIVE_THREAD_ID.test(payload.id)) state.forkThreadId = payload.id;
      state.forkCopyAnchorMs = metaTimestampMs;
    }
    return null;
  }
  if (entry.type === 'token_usage_record') return parseUsageRecord(entry, payload, state);
  if (entry.type === 'event_msg' && (payload.type === 'task_started' || payload.type === 'turn_started')
    && typeof payload.turn_id === 'string') {
    // Pre-context compaction on a model switch can use either the old model or its replacement.
    const modelChanged = state.model && state.threadModel && state.model !== state.threadModel;
    state.turn = { id: payload.turn_id, speed: state.threadSpeed, hasContext: false,
      model: modelChanged ? 'unknown' : state.threadModel ?? state.model };
    return null;
  }
  if (entry.type === 'turn_context') {
    if (typeof payload.model === 'string') state.model = payload.model;
    if (typeof payload.turn_id !== 'string') {
      state.turn = null;
    } else if (state.turn?.id === payload.turn_id) {
      state.turn.model = state.model;
      state.turn.hasContext = true;
    } else {
      state.turn = { id: payload.turn_id, model: state.model, speed: state.threadSpeed, hasContext: true };
    }
    return null;
  }
  if (payload.type === 'thread_settings_applied') {
    if (isRecord(payload.thread_settings)) {
      if (typeof payload.thread_settings.model === 'string') state.threadModel = payload.thread_settings.model;
      state.threadSpeed = usageSpeedFromServiceTier(payload.thread_settings.service_tier);
      // The initial checkpoint follows context. A setting between admission and context may be a live edit.
      if (state.turn && state.turn.speed === null) state.turn.speed = state.turn.hasContext ? state.threadSpeed : 'unknown';
    }
    return null;
  }
  if (payload.type !== 'token_count' || !isRecord(payload.info)) return null;

  // Codex may emit counters before the model or timestamp is known; they re-emit later.
  const timestampMs = parseTimestampMs(entry.timestamp);
  if (timestampMs === null || state.model.length === 0) return null;

  const last = readTokenUsage(payload.info.last_token_usage);
  const rawCumulative = payload.info.total_token_usage;
  const hasCumulative = rawCumulative !== undefined && rawCumulative !== null;
  const cumulative = hasCumulative ? readTokenUsage(rawCumulative) : null;

  if (consumeForkCopy(state, timestampMs)) {
    // Copied history is billed in the parent but sets the child's baseline.
    const signature = last === null ? null : JSON.stringify(last);
    if (cumulative !== null) state.lastCumulativeUsage = cumulative;
    else if (!hasCumulative && last !== null && signature !== state.lastUsageSignature) {
      state.lastCumulativeUsage = combineUsage(state.lastCumulativeUsage, last, 1);
    }
    state.lastUsageSignature = signature;
    return null;
  }

  const previous = state.lastCumulativeUsage;
  // A valid snapshot stays the next baseline even when its paired request is malformed.
  if (cumulative !== null) state.lastCumulativeUsage = cumulative;
  if (state.sawUsageRecord) return null;
  const malformed: MalformedUsage = { malformed: true, timestampMs };
  if (last === null || (hasCumulative && cumulative === null)) return malformed;

  // Zero-component counters report context size, not a request.
  if (last.input_tokens + last.output_tokens === 0) {
    state.lastUsageSignature = null;
    return null;
  }
  if (cumulative !== null && previous !== null && sameUsage(cumulative, previous)) return null;
  if (last.total_tokens !== last.input_tokens + last.output_tokens) return malformed;

  const signature = JSON.stringify(last);
  if (cumulative !== null) {
    // A session resumed in a new Codex process restarts its counters at this request.
    const restarted = sameUsage(cumulative, last);
    // Forks and continuations can inherit totals without a copied snapshot; the unseen
    // prefix must itself be valid usage.
    const reconciled = previous === null
      ? combineUsage(cumulative, last, -1) !== null
      : USAGE_FIELDS.every((field) => cumulative[field] - previous[field] === last[field]);
    if (!restarted && !reconciled) return malformed;
  } else {
    if (signature === state.lastUsageSignature) return null;
    // Advancing the expected totals makes a later cumulative re-emission of this request stale.
    const advanced = combineUsage(previous, last, 1);
    if (advanced === null) return malformed;
    state.lastCumulativeUsage = advanced;
  }
  state.lastUsageSignature = signature;

  // Garcon's JSONL fork copies these events verbatim under a new session id, so the
  // event's time and counters, not its session, identify the request across copies.
  return usageRecord(state.sessionId, state.model, timestampMs, last, state.threadSpeed,
    `codex:${timestampMs}:${state.model}:${signature}:${cumulative === null ? '' : JSON.stringify(cumulative)}`);
}

export const codexUsageFormat: TranscriptUsageFormat<CodexUsageState> = {
  // Metadata lines carry model, tier, and session even without usage.
  lineMarkers: ['"token_usage_record"', '"token_count"', '"turn_context"', '"task_started"', '"turn_started"', '"thread_settings_applied"', '"session_meta"'],
  createState: createCodexUsageState,
  cloneState: (state) => ({ ...state, turn: state.turn && { ...state.turn } }),
  parseLine: parseCodexUsageLine,
};
