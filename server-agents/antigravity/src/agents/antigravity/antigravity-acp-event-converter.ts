import {
  AssistantMessage,
  ErrorMessage,
  ThinkingMessage,
  type ChatMessage,
  type ToolUseChatMessage,
} from '@garcon/common/chat-types';
import {
  ACP_TERMINAL_TOOL_STATUSES,
  MAX_TOOL_ENTRIES_PER_SESSION,
  acpContentText,
  asObject,
  asString,
  evictOldestToolEntry,
  type AcpEventConverter,
  type AcpRuntimeBoundary,
  type AcpSessionUpdateContext,
} from '@garcon/server-agent-common/acp/event-converter';
import { AcpInBandFailure, acpOutputUpdateType } from '@garcon/server-agent-common/acp/in-band-failure';
import { antigravityToolCall, convertAntigravityToolUse } from './tool-use-converter.js';
import { mergeCall, needsMoreEvidence, toolCallResult, type TrackedCall } from './tool-call-snapshot.js';

const WARNING_MARKER = '\n⚠ ';
const EXECUTOR_ERROR = 'agent executor error: ';

interface DeferredCall {
  call: TrackedCall;
  readonly preceding: ChatMessage[];
}

interface SessionState {
  assistantText: string;
  answerStarted: boolean;
  thinkingText: string;
  readonly failure: AcpInBandFailure;
  // Tool rows and results already published; kept across turns because a
  // stopped turn's late terminal update can arrive after the next turn begins.
  readonly emittedToolIds: Set<string>;
  readonly completedToolIds: Set<string>;
  // ACP can split identity, arguments and MCP metadata across updates and permission requests.
  readonly calls: Map<string, TrackedCall>;
  // Permission-only traffic must not evict an active tool's identity or result.
  readonly permissions: Map<string, TrackedCall>;
  readonly deferred: Map<string, DeferredCall>;
}

function hasPublishedCall(session: SessionState, id: string): boolean {
  return session.emittedToolIds.has(id) || session.calls.has(id) || session.completedToolIds.has(id);
}

function rememberCall(calls: Map<string, TrackedCall>, call: TrackedCall): void {
  calls.set(call.toolCallId, call);
  evictOldestToolEntry(calls);
}

// Upstream model failures (bad key, quota, HTTP errors) do not fail the ACP
// prompt: agy streams one complete chunk carrying this marker, then ends the
// turn with `end_turn`. Verified against agy 1.5.13. Text the chunk carries
// before the marker stays assistant output. The marker must open the chunk (its
// detail may then span lines) or be its last line, so prose that merely quotes
// it mid-reply is not taken for a failure.
export function splitExecutorError(text: string): { readonly text: string; readonly failure: string | null } {
  const marker = WARNING_MARKER + EXECUTOR_ERROR;
  const index = text.startsWith(marker) ? 0 : text.lastIndexOf(marker);
  if (index < 0 || (index > 0 && text.slice(index + 1).trimEnd().includes('\n'))) return { text, failure: null };
  return {
    text: text.slice(0, index),
    failure: `Antigravity ${text.slice(index + WARNING_MARKER.length).trim()}`,
  };
}

export class AntigravityAcpEventConverter implements AcpEventConverter {
  #sessions = new Map<string, SessionState>();

  beginTurn(sessionId: string): void {
    const session = this.#sessionFor(sessionId);
    session.assistantText = '';
    session.answerStarted = false;
    session.thinkingText = '';
    session.failure.reset();
  }

  permissionToolUse(
    toolCall: Record<string, unknown>,
    context: AcpSessionUpdateContext,
  ): ToolUseChatMessage | null {
    const call = antigravityToolCall(toolCall);
    if (!call) return null;
    const session = this.#sessionFor(context.sessionId);
    const deferred = session.deferred.get(call.toolCallId);
    const calls = session.calls.has(call.toolCallId) ? session.calls : session.permissions;
    const resolved = mergeCall(deferred?.call ?? calls.get(call.toolCallId), call);
    if (deferred) deferred.call = resolved;
    else rememberCall(calls, resolved);
    // A provisional display title is not evidence of what the user is approving.
    return convertAntigravityToolUse(context.timestamp, { ...resolved, planTitle: null });
  }

  fromSessionUpdate(
    notification: Record<string, unknown>,
    context: AcpSessionUpdateContext,
  ): ChatMessage[] {
    const update = asObject(notification.update);
    const session = this.#sessionFor(context.sessionId);
    const outputType = acpOutputUpdateType(update, id =>
      hasPublishedCall(session, id) || session.deferred.has(id) || session.permissions.has(id));
    const restored = session.failure.continueOn(outputType);
    const messages = restored ? this.#appendAnswer(session, restored, context.timestamp) : [];
    switch (update.sessionUpdate) {
      case 'agent_message':
      case 'agent_message_chunk':
        messages.push(...this.#appendAnswer(session, session.failure.offer(acpContentText(update.content)), context.timestamp));
        break;
      case 'agent_thought_chunk':
        session.thinkingText += acpContentText(update.content);
        break;
      case 'tool_call':
      case 'tool_call_update':
        messages.push(...this.#toolCallUpdate(session, update, context.timestamp));
        break;
    }
    return messages;
  }

  // A retired session's final flush must not recreate state the runtime
  // released. The runtime takes a turn's failure before this flush, so one still
  // held here arrived after the turn ended and is published as an error row.
  endTurn(sessionId: string, context: AcpSessionUpdateContext): ChatMessage[] {
    const session = this.#sessions.get(sessionId);
    if (!session) return [];
    const messages = [...this.#emitDeferred(session, context.timestamp), ...this.#flush(session, context.timestamp)];
    const late = session.failure.take();
    if (late) messages.push(new ErrorMessage(context.timestamp, late));
    return messages;
  }

  releaseSession(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  flushPending(context: AcpSessionUpdateContext, boundary: AcpRuntimeBoundary): ChatMessage[] {
    const session = this.#sessions.get(context.sessionId);
    if (!session?.deferred.size) return [];
    if (boundary.kind === 'stderr') return this.#emitDeferred(session, context.timestamp);
    const { toolCallId } = boundary;
    // Publishing the target already released everything older than it.
    if (hasPublishedCall(session, toolCallId)) return [];
    const rows = this.#emitDeferred(session, context.timestamp, toolCallId);
    const target = session.deferred.get(toolCallId);
    if (target) rows.push(...target.preceding.splice(0));
    // A new unrelated request is a tool boundary; its decision can arrive mid-answer.
    else if (boundary.kind === 'permission-request') rows.push(...this.#flush(session, context.timestamp));
    return rows;
  }

  takeTurnFailure(sessionId: string): string | null {
    return this.#sessions.get(sessionId)?.failure.take() ?? null;
  }

  #toolCallUpdate(session: SessionState, update: Record<string, unknown>, timestamp: string): ChatMessage[] {
    const parsed = antigravityToolCall(update);
    if (!parsed || session.completedToolIds.has(parsed.toolCallId)) return [];
    const { toolCallId } = parsed;
    const status = asString(update.status) ?? '';
    const terminal = ACP_TERMINAL_TOOL_STATUSES.has(status);
    const pending = session.deferred.get(toolCallId);
    const previous = pending?.call ?? session.calls.get(toolCallId) ?? session.permissions.get(toolCallId);
    const call = mergeCall(previous, parsed, update);
    session.permissions.delete(toolCallId);
    const messages: ChatMessage[] = [];
    if (!hasPublishedCall(session, toolCallId)) {
      const row = convertAntigravityToolUse(timestamp, call);
      if (!terminal && needsMoreEvidence(call, row)) {
        if (!pending) return this.#deferCall(session, call, timestamp);
        pending.call = call;
        return [];
      }
      messages.push(...this.#emitDeferred(session, timestamp, toolCallId));
      messages.push(...(pending?.preceding ?? this.#flush(session, timestamp)), row);
      session.deferred.delete(toolCallId);
      this.#remember(session.emittedToolIds, toolCallId);
    }
    if (!terminal) {
      rememberCall(session.calls, call);
      return messages;
    }
    messages.push(...this.#emitDeferred(session, timestamp), ...this.#flush(session, timestamp));
    this.#remember(session.completedToolIds, toolCallId);
    session.calls.delete(toolCallId);
    messages.push(toolCallResult(timestamp, call, update, status, previous));
    return messages;
  }

  #deferCall(session: SessionState, call: TrackedCall, timestamp: string): ChatMessage[] {
    const messages: ChatMessage[] = [];
    if (session.deferred.size >= MAX_TOOL_ENTRIES_PER_SESSION) {
      const oldest = session.deferred.values().next().value;
      if (oldest) messages.push(...this.#publishDeferred(session, timestamp, oldest));
    }
    let preceding = this.#flush(session, timestamp);
    if (!session.deferred.size) {
      messages.push(...preceding);
      preceding = [];
    }
    session.deferred.set(call.toolCallId, { call, preceding });
    return messages;
  }

  // Only actual publication (or the memory bound) fixes an incomplete call's
  // place. Another incomplete start and the prose between them can still wait.
  #emitDeferred(session: SessionState, timestamp: string, beforeId?: string): ChatMessage[] {
    const messages: ChatMessage[] = [];
    for (const [id, pending] of session.deferred) {
      if (id === beforeId) break;
      messages.push(...this.#publishDeferred(session, timestamp, pending));
    }
    return messages;
  }

  #publishDeferred(session: SessionState, timestamp: string, { call, preceding }: DeferredCall): ChatMessage[] {
    session.deferred.delete(call.toolCallId);
    this.#remember(session.emittedToolIds, call.toolCallId);
    rememberCall(session.calls, call);
    return [...preceding, convertAntigravityToolUse(timestamp, call)];
  }

  #remember(ids: Set<string>, toolCallId: string): void {
    ids.add(toolCallId);
    evictOldestToolEntry(ids);
  }

  #appendAnswer(session: SessionState, text: string, timestamp: string): ChatMessage[] {
    session.assistantText += text;
    if (session.answerStarted || !/\S/.test(text)) return [];
    // Leading thinking becomes visible now; later thoughts must not split the buffered Markdown.
    session.answerStarted = true;
    return session.deferred.size ? [] : this.#flushThinking(session, timestamp);
  }

  #flushThinking(session: SessionState, timestamp: string): ChatMessage[] {
    const thinking = session.thinkingText;
    session.thinkingText = '';
    return /\S/.test(thinking) ? [new ThinkingMessage(timestamp, thinking)] : [];
  }

  #flush(session: SessionState, timestamp: string): ChatMessage[] {
    const messages = this.#flushThinking(session, timestamp);
    if (session.answerStarted) messages.push(new AssistantMessage(timestamp, session.assistantText));
    session.assistantText = '';
    session.answerStarted = false;
    return messages;
  }

  #sessionFor(sessionId: string): SessionState {
    const existing = this.#sessions.get(sessionId);
    if (existing) return existing;
    const created: SessionState = {
      assistantText: '',
      answerStarted: false,
      thinkingText: '',
      failure: new AcpInBandFailure(splitExecutorError),
      emittedToolIds: new Set(),
      completedToolIds: new Set(),
      calls: new Map(),
      permissions: new Map(),
      deferred: new Map(),
    };
    this.#sessions.set(sessionId, created);
    return created;
  }
}
