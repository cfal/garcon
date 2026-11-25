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
  type AcpSteeringProtocol,
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
  answerStarted: boolean;
  thinkingText: string;
  readonly failure: AcpInBandFailure;
  // Tool rows and results already published; kept across turns because a
  // stopped turn's late terminal update can arrive after the next turn begins.
  readonly emittedToolIds: Set<string>;
  readonly completedToolIds: Set<string>;
  // Tool names by call ID; terminal updates need the name to normalize output.
  readonly toolNames: Map<string, string>;
  // Arguments seen on any frame of a call, including its permission request,
  // for a row that waited on a frame without them.
  readonly toolInputs: Map<string, Record<string, unknown>>;
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
      || session.deferredCalls.has(id) || session.completedToolIds.has(id) || session.toolNames.has(id));
    const restored = session.failure.continueOn(outputType);
    // New output publishes waiting rows first, so nothing moves ahead of a call
    // that started earlier.
    const waiting = this.#emitDeferred(session, update, outputType, context.timestamp);
    if (restored) waiting.push(...this.#appendAnswer(session, restored, context.timestamp));
    return [...waiting, ...this.#convertUpdate(session, update, updateType, context)];
  }

  #convertUpdate(
    session: SessionState,
    update: Record<string, unknown>,
    updateType: string | undefined,
    context: AcpSessionUpdateContext,
  ): ChatMessage[] {
    switch (updateType) {
      case 'agent_message':
      case 'agent_message_chunk':
        return this.#appendAnswer(session, session.failure.offer(acpContentText(update.content)), context.timestamp);
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

  readonly steering: AcpSteeringProtocol = {
    // agy 1.5.13 sends the same bare end_turn for supersession and a natural completion without usage.
    // Garcon favors immediate steering acknowledgment here; that ambiguous completion can be a false positive.
    likelySuperseded: result => result?.stopReason === 'end_turn' && result.usage == null,
    refused: error => error.code === -32603 && error.message.includes('answer it or send session/cancel, then send this prompt again'),
  };

  // A call's row waits for its arguments when the first frame carries none, so a
  // later frame can still give it its shared tool type; a terminal frame emits
  // it regardless.
  // Records the frame, then fills the name and arguments it omits from earlier
  // frames of the same call.
  #resolvedCall(session: SessionState, call: AntigravityToolCall): AntigravityToolCall {
    this.#rememberCall(session, call);
    return {
      ...call,
      name: call.name ?? session.toolNames.get(call.toolCallId) ?? null,
      input: Object.keys(call.input).length > 0 ? call.input : session.toolInputs.get(call.toolCallId) ?? {},
    };
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
    const name = asString(update.name) ?? session.toolNames.get(toolCallId) ?? '';
    session.toolNames.delete(toolCallId);
    session.toolInputs.delete(toolCallId);
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
      rows.push(convertAntigravityToolUse(timestamp, {
        ...call,
        name: session.toolNames.get(call.toolCallId) ?? call.name,
        input: session.toolInputs.get(call.toolCallId) ?? call.input,
      }));
    }
    session.deferredCalls.clear();
    return rows;
  }

  #remember(ids: Set<string>, toolCallId: string): void {
    ids.add(toolCallId);
    evictOldestToolEntry(ids);
  }

  // A later frame without a name or arguments must not replace what the call started with.
  #rememberCall(session: SessionState, call: { readonly toolCallId: string; readonly name: string | null; readonly input: Record<string, unknown> }): void {
    if (call.name) {
      session.toolNames.set(call.toolCallId, call.name);
      evictOldestToolEntry(session.toolNames);
    }
    if (Object.keys(call.input).length > 0) {
      session.toolInputs.set(call.toolCallId, call.input);
      evictOldestToolEntry(session.toolInputs);
    }
  }

  #appendAnswer(session: SessionState, text: string, timestamp: string): ChatMessage[] {
    session.assistantText += text;
    if (session.answerStarted || !/\S/.test(text)) return [];
    // Leading thinking becomes visible now; later thoughts must not split the buffered Markdown.
    session.answerStarted = true;
    return this.#flushThinking(session, timestamp);
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
      toolNames: new Map(),
      toolInputs: new Map(),
      deferredCalls: new Map(),
    };
    this.#sessions.set(sessionId, created);
    return created;
  }
}
