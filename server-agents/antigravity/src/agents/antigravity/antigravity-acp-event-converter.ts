import {
  AssistantMessage,
  ErrorMessage,
  ThinkingMessage,
  ToolResultMessage,
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
  type AcpSessionUpdateContext,
} from '@garcon/server-agent-common/acp/event-converter';
import { AcpInBandFailure, acpOutputUpdateType } from '@garcon/server-agent-common/acp/in-band-failure';
import {
  antigravityToolCall,
  antigravityToolResultText,
  convertAntigravityToolUse,
  type AntigravityToolCall,
} from './tool-use-converter.js';

const WARNING_MARKER = '\n⚠ ';
const EXECUTOR_ERROR = 'agent executor error: ';

interface TrackedCall extends AntigravityToolCall {
  readonly rawOutput?: unknown;
  readonly content?: readonly Record<string, unknown>[];
  readonly contentIsNewer: boolean;
}

interface DeferredCall {
  call: TrackedCall;
  readonly preceding: ChatMessage[];
}

interface SessionState {
  assistantText: string;
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

function isAgentWork(name: string | null): boolean {
  return name === 'manage_task' || name === 'update_steps' || name === 'send_message';
}

function reportedResult(call: TrackedCall, terminal: Record<string, unknown>): ToolResultMessage['content'] {
  const name = call.isMcp ? null : call.name ?? (call.planTitle === 'matched' ? 'update_steps' : null);
  const agentWork = isAgentWork(name);
  const raw = agentWork ? call.rawOutput : terminal.rawOutput;
  const blocks = agentWork || Array.isArray(terminal.content) ? (call.content ?? []) : [];
  const output = (agentWork ? asString(raw) : undefined) ?? asString(asObject(raw).output) ?? '';
  const blockText = blocks.map(block => asString(asObject(block.content).text) ?? '').filter(Boolean).join('\n');
  // A fresh diagnostic takes precedence over an independent progress field,
  // even if the final frame supplies only the status.
  const text = output.trim() && !(call.contentIsNewer && blockText.trim()) ? output : blockText;
  const distinct = output.trim() !== '' && blockText.trim() !== '' && output !== blockText;
  const result: ToolResultMessage['content'] = {};
  const structured = raw != null && typeof raw !== 'string' && (typeof raw !== 'object' || Array.isArray(raw) ||
    Object.keys(asObject(raw)).some(key => key !== 'output' || typeof asObject(raw).output !== 'string'));
  if (agentWork && (structured || (distinct && text === blockText))) {
    result.rawOutput = raw;
  }
  if (agentWork && ((distinct && text === output) ||
      blocks.some(block => block.type !== 'content' || asObject(block.content).type !== 'text'))) result.items = blocks;
  const normalized = antigravityToolResultText(name ?? '', text);
  if (normalized.trim()) result.raw = normalized;
  return result;
}

function mergeCall(previous: TrackedCall | undefined, call: AntigravityToolCall, update?: Record<string, unknown>): TrackedCall {
  const name = call.name || previous?.name || null;
  const partial = !name || isAgentWork(name) || call.isMcp || previous?.isMcp;
  let input = call.input;
  if (previous && !Object.keys(input).length) input = previous.input;
  else if (previous && partial) input = { ...previous.input, ...input };
  return {
    ...call,
    name,
    kind: call.kind || previous?.kind || null,
    isMcp: call.isMcp || !!previous?.isMcp || !!(asString(input.server) && asString(input.tool)),
    planTitle: previous?.planTitle === 'excluded' ? 'excluded' : call.planTitle ?? previous?.planTitle ?? null,
    input,
    // ACP patches rawOutput and content independently. Null rawOutput is unchanged;
    // an explicit content array replaces its predecessor, including an empty one.
    rawOutput: update?.rawOutput ?? previous?.rawOutput,
    contentIsNewer: update?.rawOutput != null ? false : Array.isArray(update?.content) || !!previous?.contentIsNewer,
    content: Array.isArray(update?.content)
      ? update.content.map(asObject).filter(block => block.type !== 'diff') : previous?.content,
  };
}

function needsMoreEvidence(call: TrackedCall, row: ToolUseChatMessage): boolean {
  if (!Object.keys(call.input).length) return true;
  if (row.type === 'mcp-tool-use') return false;
  if (call.isMcp || !call.name) return true;
  return row.type === 'external-tool-use' && isAgentWork(call.name);
}

export class AntigravityAcpEventConverter implements AcpEventConverter {
  #sessions = new Map<string, SessionState>();

  beginTurn(sessionId: string): void {
    const session = this.#sessionFor(sessionId);
    session.assistantText = '';
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
    else {
      calls.set(call.toolCallId, resolved);
      evictOldestToolEntry(calls);
    }
    // A provisional display title is not evidence of what the user is approving.
    return convertAntigravityToolUse(context.timestamp, { ...resolved, planTitle: null });
  }

  fromSessionUpdate(
    notification: Record<string, unknown>,
    context: AcpSessionUpdateContext,
  ): ChatMessage[] {
    const update = asObject(notification.update);
    const session = this.#sessionFor(context.sessionId);
    const updateType = asString(update.sessionUpdate);
    const outputType = acpOutputUpdateType(update, (id) => session.emittedToolIds.has(id)
      || session.deferred.has(id) || session.calls.has(id) || session.completedToolIds.has(id) || session.permissions.has(id));
    session.assistantText += session.failure.continueOn(outputType);
    return this.#convertUpdate(session, update, updateType, context);
  }

  #convertUpdate(
    session: SessionState,
    update: Record<string, unknown>,
    updateType: string | undefined,
    context: AcpSessionUpdateContext,
  ): ChatMessage[] {
    switch (updateType) {
      // An answer stays one buffer until a tool frame or the turn's end. agy
      // forwards thought parts wherever the model streams them, including
      // between chunks of one answer; publishing on every switch made each chunk
      // its own row and broke Markdown that spans chunks. Thinking that precedes
      // the answer is still published when the answer starts, so a long answer
      // does not hide it.
      // A whole `agent_message` carries the same content as a run of chunks.
      case 'agent_message':
      case 'agent_message_chunk': {
        const answerStarted = session.assistantText.trim() !== '';
        const flushed = !session.deferred.size && !answerStarted && session.thinkingText.trim() ? this.#flush(session, context.timestamp) : [];
        session.assistantText += session.failure.offer(acpContentText(update.content));
        return flushed;
      }
      case 'agent_thought_chunk':
        session.thinkingText += acpContentText(update.content);
        return [];
      case 'tool_call':
      case 'tool_call_update':
        return this.#toolCallUpdate(session, update, context.timestamp);
      default:
        return [];
    }
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

  takeTurnFailure(sessionId: string): string | null {
    return this.#sessions.get(sessionId)?.failure.take() ?? null;
  }

  #toolCallUpdate(session: SessionState, update: Record<string, unknown>, timestamp: string): ChatMessage[] {
    const parsed = antigravityToolCall(update);
    if (!parsed || session.completedToolIds.has(parsed.toolCallId)) return [];
    const { toolCallId } = parsed;
    const status = asString(update.status);
    const terminal = ACP_TERMINAL_TOOL_STATUSES.has(status ?? '');
    const pending = session.deferred.get(toolCallId);
    const call = mergeCall(pending?.call ?? session.calls.get(toolCallId) ?? session.permissions.get(toolCallId), parsed, update);
    session.permissions.delete(toolCallId);
    const emitted = session.calls.has(toolCallId) || session.emittedToolIds.has(toolCallId);
    const messages: ChatMessage[] = [];
    if (!emitted) {
      const row = convertAntigravityToolUse(timestamp, call);
      if (!terminal && needsMoreEvidence(call, row)) {
        if (pending) pending.call = call;
        else {
          if (session.deferred.size >= MAX_TOOL_ENTRIES_PER_SESSION) {
            const oldest = session.deferred.values().next().value;
            if (oldest) messages.push(...this.#publishDeferred(session, timestamp, oldest));
          }
          const preceding = this.#flush(session, timestamp);
          if (!session.deferred.size) messages.push(...preceding);
          session.deferred.set(toolCallId, { call, preceding: session.deferred.size ? preceding : [] });
        }
        return messages;
      }
      messages.push(...this.#emitDeferred(session, timestamp, toolCallId));
      messages.push(...(pending?.preceding ?? this.#flush(session, timestamp)), row);
      session.deferred.delete(toolCallId);
      this.#remember(session.emittedToolIds, toolCallId);
    }
    if (!terminal) {
      session.calls.set(toolCallId, call);
      evictOldestToolEntry(session.calls);
      return messages;
    }
    messages.push(...this.#emitDeferred(session, timestamp), ...this.#flush(session, timestamp));
    this.#remember(session.completedToolIds, toolCallId);
    session.calls.delete(toolCallId);
    // agy completes the tool invocation even when the command exits unsuccessfully.
    const name = call.isMcp ? null : call.name;
    const exitCode = name === 'run_command' ? asObject(call.rawOutput).exit_code : undefined;
    const commandFailed = typeof exitCode === 'number' && exitCode !== 0;
    const failed = status !== 'completed' || commandFailed;
    const content = reportedResult(call, update);
    if (!Object.keys(content).length && failed) {
      if (commandFailed) content.exitCode = exitCode;
      else content.status = status;
    }
    messages.push(new ToolResultMessage(timestamp, toolCallId, content, failed));
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
    session.calls.set(call.toolCallId, call);
    evictOldestToolEntry(session.calls);
    return [...preceding, convertAntigravityToolUse(timestamp, call)];
  }

  #remember(ids: Set<string>, toolCallId: string): void {
    ids.add(toolCallId);
    evictOldestToolEntry(ids);
  }

  #flush(session: SessionState, timestamp: string): ChatMessage[] {
    const messages: ChatMessage[] = [];
    const thinking = session.thinkingText.trim();
    const assistant = session.assistantText.trim();
    if (thinking) messages.push(new ThinkingMessage(timestamp, thinking));
    if (assistant) messages.push(new AssistantMessage(timestamp, assistant));
    session.thinkingText = '';
    session.assistantText = '';
    return messages;
  }

  #sessionFor(sessionId: string): SessionState {
    const existing = this.#sessions.get(sessionId);
    if (existing) return existing;
    const created: SessionState = {
      assistantText: '',
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
