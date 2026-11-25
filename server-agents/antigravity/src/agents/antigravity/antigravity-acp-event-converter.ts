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
  readonly result?: ToolResultMessage['content'];
  readonly exitCode?: number;
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
  deferredId: string | null;
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

function reportedResult(update: Record<string, unknown>): ToolResultMessage['content'] | undefined {
  const rawOutput = asObject(update.rawOutput);
  const output = asString(update.rawOutput) ?? asString(rawOutput.output);
  if (output?.trim()) return { raw: output };
  const blocks = Array.isArray(update.content) ? update.content.map(asObject) : [];
  if (blocks.some(block => block.type !== 'content' || asObject(block.content).type !== 'text')) return { items: update.content };
  const text = blocks.map(block => asString(asObject(block.content).text) ?? '').join('\n');
  if (text.trim()) return { raw: text };
  // Command transport fields alone are not a result body.
  if (Object.keys(rawOutput).some(key => key !== 'exit_code' && (key !== 'output' || typeof rawOutput.output !== 'string')) ||
      Array.isArray(update.rawOutput) || typeof update.rawOutput === 'boolean' || typeof update.rawOutput === 'number') {
    return { rawOutput: update.rawOutput };
  }
  if (update.content !== undefined || output !== undefined || (update.rawOutput !== undefined && rawOutput.exit_code === undefined)) return {};
  return undefined;
}

function mergeCall(previous: TrackedCall | undefined, call: AntigravityToolCall, update?: Record<string, unknown>): TrackedCall {
  const code = asObject(update?.rawOutput).exit_code;
  const input = !previous ? call.input : Object.keys(call.input).length ? { ...previous.input, ...call.input } : previous.input;
  return {
    ...call,
    name: call.name || previous?.name || null,
    kind: call.kind || previous?.kind || null,
    isMcp: call.isMcp || !!previous?.isMcp || !!(asString(input.server) && asString(input.tool)),
    planTitle: previous?.planTitle === 'excluded' ? 'excluded' : call.planTitle ?? previous?.planTitle ?? null,
    input,
    result: (update && reportedResult(update)) ?? previous?.result,
    exitCode: typeof code === 'number' ? code : previous?.exitCode,
  };
}

function needsMoreEvidence(call: TrackedCall, row: ToolUseChatMessage): boolean {
  if (!Object.keys(call.input).length) return true;
  if (row.type === 'mcp-tool-use') return false;
  if (!call.name) return !call.isMcp;
  return row.type === 'external-tool-use' && !call.isMcp &&
    (call.name === 'manage_task' || call.name === 'send_message' || call.name === 'update_steps');
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
    const calls = session.calls.has(call.toolCallId) ? session.calls : session.permissions;
    const resolved = mergeCall(calls.get(call.toolCallId), call);
    calls.set(call.toolCallId, resolved);
    evictOldestToolEntry(calls);
    return convertAntigravityToolUse(context.timestamp, resolved);
  }

  fromSessionUpdate(
    notification: Record<string, unknown>,
    context: AcpSessionUpdateContext,
  ): ChatMessage[] {
    const update = asObject(notification.update);
    const session = this.#sessionFor(context.sessionId);
    const updateType = asString(update.sessionUpdate);
    const outputType = acpOutputUpdateType(update, (id) => session.emittedToolIds.has(id)
      || session.calls.has(id) || session.completedToolIds.has(id) || session.permissions.has(id));
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
        const flushed = !session.deferredId && !answerStarted && session.thinkingText.trim() ? this.#flush(session, context.timestamp) : [];
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
    const call = mergeCall(session.calls.get(toolCallId) ?? session.permissions.get(toolCallId), parsed, update);
    session.permissions.delete(toolCallId);
    const emitted = session.emittedToolIds.has(toolCallId);
    if (!terminal) {
      session.calls.set(toolCallId, call);
      evictOldestToolEntry(session.calls);
    }
    if (emitted && !terminal) return [];

    // Buffered prose after a deferred call can wait for its identity; another
    // tool row or result is a publication boundary and cannot overtake it.
    const wasDeferred = session.deferredId === toolCallId;
    const messages = wasDeferred ? [] : [...this.#emitDeferred(session, timestamp), ...this.#flush(session, timestamp)];
    if (!emitted) {
      const row = convertAntigravityToolUse(timestamp, call);
      if (!terminal && needsMoreEvidence(call, row)) {
        session.deferredId = toolCallId;
        return messages;
      }
      session.deferredId = null;
      this.#remember(session.emittedToolIds, toolCallId);
      messages.push(row);
    }
    if (!terminal) return messages;
    if (wasDeferred) messages.push(...this.#flush(session, timestamp));
    this.#remember(session.completedToolIds, toolCallId);
    session.calls.delete(toolCallId);
    // agy completes the tool invocation even when the command exits unsuccessfully.
    const name = call.isMcp ? null : call.name;
    const exitCode = name === 'run_command' ? call.exitCode : undefined;
    const commandFailed = typeof exitCode === 'number' && exitCode !== 0;
    const failed = status !== 'completed' || commandFailed;
    const content = { ...call.result };
    if (typeof content.raw === 'string') {
      const text = antigravityToolResultText(name ?? '', content.raw);
      if (text.trim()) content.raw = text;
      else delete content.raw;
    }
    if (!Object.keys(content).length && failed) {
      if (commandFailed) content.exitCode = exitCode;
      else content.status = status;
    }
    messages.push(new ToolResultMessage(timestamp, toolCallId, content, failed));
    return messages;
  }

  #emitDeferred(session: SessionState, timestamp: string): ChatMessage[] {
    const id = session.deferredId;
    if (!id) return [];
    session.deferredId = null;
    const call = session.calls.get(id);
    if (!call) return [];
    this.#remember(session.emittedToolIds, id);
    return [convertAntigravityToolUse(timestamp, call)];
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
      deferredId: null,
    };
    this.#sessions.set(sessionId, created);
    return created;
  }
}
