import {
  AssistantMessage,
  ThinkingMessage,
  ToolResultMessage,
  type ChatMessage,
  type ToolUseChatMessage,
} from '@garcon/common/chat-types';
import {
  acpContentText,
  asObject,
  asString,
  type AcpEventConverter,
  type AcpSessionUpdateContext,
} from '@garcon/server-agent-common/acp/event-converter';
import {
  antigravityToolCall,
  antigravityToolResultText,
  convertAntigravityToolUse,
} from './tool-use-converter.js';

const WARNING_MARKER = '\n⚠ ';
const EXECUTOR_ERROR = 'agent executor error: ';
const MAX_TOOL_NAMES_PER_SESSION = 512;

interface SessionState {
  assistantText: string;
  thinkingText: string;
  // An executor-error chunk is a failure only if nothing follows it before the
  // turn ends, since agy ends the turn right after it; later output means the
  // chunk was ordinary text that happened to quote the marker.
  pendingFailure: { readonly failure: string; readonly text: string } | null;
  // Tool rows and results already published; kept across turns because a
  // stopped turn's late terminal update can arrive after the next turn begins.
  readonly emittedToolIds: Set<string>;
  readonly completedToolIds: Set<string>;
  // Tool names by call ID; terminal updates need the name to normalize output.
  readonly toolNames: Map<string, string>;
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
  if (output !== undefined) return output;
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
    session.pendingFailure = null;
  }

  permissionToolUse(
    toolCall: Record<string, unknown>,
    context: AcpSessionUpdateContext,
  ): ToolUseChatMessage | null {
    const call = antigravityToolCall(toolCall);
    if (!call) return null;
    // The request may omit the name an earlier frame of the same call carried.
    const name = call.name ?? this.#sessions.get(context.sessionId)?.toolNames.get(call.toolCallId) ?? null;
    return convertAntigravityToolUse(context.timestamp, { ...call, name });
  }

  fromSessionUpdate(
    notification: Record<string, unknown>,
    context: AcpSessionUpdateContext,
  ): ChatMessage[] {
    const update = asObject(notification.update);
    const session = this.#sessionFor(context.sessionId);
    switch (asString(update.sessionUpdate)) {
      // Switching between thought and message text flushes the other buffer, so
      // interleaved output keeps the order the agent produced it in.
      case 'agent_message_chunk': {
        this.#continueAfterFailureCandidate(session);
        const chunk = acpContentText(update.content);
        const { text, failure } = splitExecutorError(chunk);
        const flushed = session.thinkingText.trim() ? this.#flush(session, context.timestamp) : [];
        session.assistantText += text;
        if (failure) session.pendingFailure = { failure, text: chunk.slice(text.length) };
        return flushed;
      }
      case 'agent_thought_chunk': {
        this.#continueAfterFailureCandidate(session);
        const flushed = session.assistantText.trim() ? this.#flush(session, context.timestamp) : [];
        session.thinkingText += acpContentText(update.content);
        return flushed;
      }
      case 'tool_call':
        this.#continueAfterFailureCandidate(session);
        return this.#toolCall(session, update, context.timestamp, false);
      case 'tool_call_update':
        return this.#toolCallUpdate(session, update, context.timestamp);
      default:
        return [];
    }
  }

  // A retired session's final flush must not recreate state the runtime released.
  endTurn(sessionId: string, context: AcpSessionUpdateContext): ChatMessage[] {
    const session = this.#sessions.get(sessionId);
    return session ? this.#flush(session, context.timestamp) : [];
  }

  releaseSession(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  takeTurnFailure(sessionId: string): string | null {
    const session = this.#sessions.get(sessionId);
    const failure = session?.pendingFailure?.failure ?? null;
    if (session) session.pendingFailure = null;
    return failure;
  }

  // A call's row waits for its arguments when the first frame carries none, so a
  // later frame can still give it its shared tool type; a terminal frame emits
  // it regardless.
  #toolCall(
    session: SessionState,
    update: Record<string, unknown>,
    timestamp: string,
    terminal: boolean,
  ): ChatMessage[] {
    const parsed = antigravityToolCall(update);
    if (!parsed) return [];
    // A later frame without a name must not replace the name the call started with.
    if (parsed.name) this.#rememberToolName(session, parsed.toolCallId, parsed.name);
    const call = { ...parsed, name: parsed.name ?? session.toolNames.get(parsed.toolCallId) ?? null };
    if (session.emittedToolIds.has(call.toolCallId)) return [];
    if (!terminal && Object.keys(call.input).length === 0) return [];
    const messages = this.#flush(session, timestamp);
    this.#remember(session.emittedToolIds, call.toolCallId);
    messages.push(convertAntigravityToolUse(timestamp, call));
    return messages;
  }

  #toolCallUpdate(session: SessionState, update: Record<string, unknown>, timestamp: string): ChatMessage[] {
    const status = asString(update.status);
    if (status !== 'completed' && status !== 'failed') return this.#toolCall(session, update, timestamp, false);
    const toolCallId = asString(update.toolCallId);
    if (!toolCallId || session.completedToolIds.has(toolCallId)) return [];
    this.#remember(session.completedToolIds, toolCallId);
    // A terminal update can be the first frame for a call, so its tool row comes first.
    const messages = this.#toolCall(session, update, timestamp, true);
    const name = asString(update.name) ?? session.toolNames.get(toolCallId) ?? '';
    session.toolNames.delete(toolCallId);
    const text = antigravityToolResultText(name, toolResultText(update));
    const failed = status === 'failed';
    const content = text.trim() ? { raw: text } : failed ? { status } : {};
    messages.push(new ToolResultMessage(timestamp, toolCallId, content, failed));
    return messages;
  }

  #continueAfterFailureCandidate(session: SessionState): void {
    if (!session.pendingFailure) return;
    session.assistantText += session.pendingFailure.text;
    session.pendingFailure = null;
  }

  #remember(ids: Set<string>, toolCallId: string): void {
    ids.add(toolCallId);
    if (ids.size <= MAX_TOOL_NAMES_PER_SESSION) return;
    const oldest = ids.values().next().value;
    if (oldest !== undefined) ids.delete(oldest);
  }

  #rememberToolName(session: SessionState, toolCallId: string, name: string): void {
    session.toolNames.set(toolCallId, name);
    if (session.toolNames.size <= MAX_TOOL_NAMES_PER_SESSION) return;
    const oldest = session.toolNames.keys().next().value;
    if (oldest !== undefined) session.toolNames.delete(oldest);
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
      pendingFailure: null,
      emittedToolIds: new Set(),
      completedToolIds: new Set(),
      toolNames: new Map(),
    };
    this.#sessions.set(sessionId, created);
    return created;
  }
}
