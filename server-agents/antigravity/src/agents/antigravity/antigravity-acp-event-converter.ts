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
import { ACP_NEW_OUTPUT_UPDATES, AcpInBandFailure, acpOutputUpdateType } from '@garcon/server-agent-common/acp/in-band-failure';
import {
  antigravityToolCall,
  antigravityToolResultText,
  convertAntigravityToolUse,
  type AntigravityToolCall,
} from './tool-use-converter.js';

const WARNING_MARKER = '\n⚠ ';
const EXECUTOR_ERROR = 'agent executor error: ';
interface SessionState {
  assistantText: string;
  thinkingText: string;
  readonly failure: AcpInBandFailure;
  // Tool rows and results already published; kept across turns because a
  // stopped turn's late terminal update can arrive after the next turn begins.
  readonly emittedToolIds: Set<string>;
  readonly completedToolIds: Set<string>;
  // ACP can split identity, arguments and MCP metadata across updates and permission requests.
  readonly calls: Map<string, AntigravityToolCall>;
  // Calls whose row is still waiting for arguments; the turn's end emits them.
  readonly deferredCalls: Map<string, AntigravityToolCall>;
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

function toolResultText(update: Record<string, unknown>): string {
  const rawOutput = asObject(update.rawOutput);
  const output = asString(rawOutput.output);
  if (output?.trim()) return output;
  const parts: string[] = [];
  for (const entry of Array.isArray(update.content) ? update.content : []) {
    const content = asObject(entry);
    const text = asString(asObject(content.content).text);
    if (content.type === 'content' && text) parts.push(text);
  }
  return parts.join('\n');
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
    return convertAntigravityToolUse(context.timestamp, this.#resolvedCall(session, call));
  }

  fromSessionUpdate(
    notification: Record<string, unknown>,
    context: AcpSessionUpdateContext,
  ): ChatMessage[] {
    const update = asObject(notification.update);
    const session = this.#sessionFor(context.sessionId);
    const updateType = asString(update.sessionUpdate);
    const outputType = acpOutputUpdateType(update, (id) => session.emittedToolIds.has(id)
      || session.deferredCalls.has(id) || session.completedToolIds.has(id) || session.calls.has(id));
    session.assistantText += session.failure.continueOn(outputType);
    // New output publishes waiting rows first, so nothing moves ahead of a call
    // that started earlier.
    const waiting = this.#emitDeferred(session, update, outputType, context.timestamp);
    return [...waiting, ...this.#convertUpdate(session, update, updateType, context)];
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
        const flushed = !answerStarted && session.thinkingText.trim() ? this.#flush(session, context.timestamp) : [];
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
    const messages = this.#flush(session, context.timestamp);
    // A stopped turn may never send the frame a waiting row needed; the call
    // still happened, so its row is published with what is known.
    messages.push(...this.#emitDeferred(session, null, undefined, context.timestamp));
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

  // A call's row waits for its arguments when the first frame carries none, so a
  // later frame can still give it its shared tool type; a terminal frame emits
  // it regardless.
  // Records the frame, then fills the name and arguments it omits from earlier
  // frames of the same call.
  #resolvedCall(session: SessionState, call: AntigravityToolCall): AntigravityToolCall {
    const previous = session.calls.get(call.toolCallId);
    const resolved: AntigravityToolCall = {
      ...call,
      name: call.name || previous?.name || null,
      kind: call.kind ?? previous?.kind ?? null,
      planTitle: previous?.planTitle === 'excluded' ? 'excluded' : call.planTitle ?? previous?.planTitle ?? null,
      input: Object.keys(call.input).length > 0 ? call.input : previous?.input ?? {},
    };
    session.calls.set(call.toolCallId, resolved);
    evictOldestToolEntry(session.calls);
    return resolved;
  }

  #toolCall(
    session: SessionState,
    update: Record<string, unknown>,
    timestamp: string,
    terminal: boolean,
  ): ChatMessage[] {
    const parsed = antigravityToolCall(update);
    if (!parsed) return [];
    const call = this.#resolvedCall(session, parsed);
    // A progress frame for a published call publishes nothing, so streamed text
    // around it stays one message. Text before any other frame is flushed first,
    // so it stays ahead of the tool row, a waiting row, and the call's result.
    const emitted = session.emittedToolIds.has(call.toolCallId);
    if (emitted && !terminal) return [];
    const messages = this.#flush(session, timestamp);
    if (emitted) return messages;
    if (!terminal && Object.keys(call.input).length === 0) {
      session.deferredCalls.set(call.toolCallId, call);
      return messages;
    }
    session.deferredCalls.delete(call.toolCallId);
    this.#remember(session.emittedToolIds, call.toolCallId);
    messages.push(convertAntigravityToolUse(timestamp, call));
    return messages;
  }

  #toolCallUpdate(session: SessionState, update: Record<string, unknown>, timestamp: string): ChatMessage[] {
    const status = asString(update.status);
    if (!status || !ACP_TERMINAL_TOOL_STATUSES.has(status)) return this.#toolCall(session, update, timestamp, false);
    const toolCallId = asString(update.toolCallId);
    if (!toolCallId || session.completedToolIds.has(toolCallId)) return [];
    this.#remember(session.completedToolIds, toolCallId);
    // A terminal update can be the first frame for a call, so its tool row comes first.
    const messages = this.#toolCall(session, update, timestamp, true);
    const name = session.calls.get(toolCallId)?.name ?? '';
    session.calls.delete(toolCallId);
    const text = antigravityToolResultText(name, toolResultText(update));
    // agy completes the tool invocation even when the command exits unsuccessfully.
    const exitCode = name === 'run_command' ? asObject(update.rawOutput).exit_code : undefined;
    const commandFailed = typeof exitCode === 'number' && exitCode !== 0;
    const failed = status !== 'completed' || commandFailed;
    const content: ToolResultMessage['content'] = {};
    if (text.trim()) content.raw = text;
    else if (commandFailed) content.exitCode = exitCode;
    else if (failed) content.status = status;
    messages.push(new ToolResultMessage(timestamp, toolCallId, content, failed));
    return messages;
  }

  // Publishes rows still waiting for arguments: all of them at the turn's end
  // (`update` null), otherwise when output other than the waiting call's own
  // frames arrives.
  #emitDeferred(
    session: SessionState,
    update: Record<string, unknown> | null,
    updateType: string | undefined,
    timestamp: string,
  ): ChatMessage[] {
    if (session.deferredCalls.size === 0) return [];
    if (update) {
      const ownFrame = (updateType === 'tool_call' || updateType === 'tool_call_update')
        && session.deferredCalls.has(asString(update.toolCallId) ?? '');
      if (ownFrame || !ACP_NEW_OUTPUT_UPDATES.has(updateType ?? '')) return [];
    }
    const rows: ChatMessage[] = [];
    for (const call of session.deferredCalls.values()) {
      this.#remember(session.emittedToolIds, call.toolCallId);
      rows.push(convertAntigravityToolUse(timestamp, session.calls.get(call.toolCallId) ?? call));
    }
    session.deferredCalls.clear();
    return rows;
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
      deferredCalls: new Map(),
    };
    this.#sessions.set(sessionId, created);
    return created;
  }
}
