import {
  AssistantMessage,
  ThinkingMessage,
  ToolResultMessage,
  type ChatMessage,
  type ToolUseChatMessage,
} from '@garcon/common/chat-types';
import {
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
  failure: string | null;
  readonly emittedToolIds: Set<string>;
  // Tool names by call ID; terminal updates need the name to normalize output.
  readonly toolNames: Map<string, string>;
}

// Upstream model failures (bad key, quota, HTTP errors) do not fail the ACP
// prompt: agy streams one complete chunk carrying this marker, then ends the
// turn with `end_turn`. Verified against agy 1.5.13.
export function antigravityExecutorError(text: string): string | null {
  if (!text.startsWith(WARNING_MARKER + EXECUTOR_ERROR)) return null;
  return `Antigravity ${text.slice(WARNING_MARKER.length).trim()}`;
}

function chunkText(value: unknown): string {
  if (typeof value === 'string') return value;
  return asString(asObject(value).text) ?? '';
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
    session.failure = null;
    session.emittedToolIds.clear();
  }

  permissionToolUse(
    toolCall: Record<string, unknown>,
    context: AcpSessionUpdateContext,
  ): ToolUseChatMessage | null {
    const call = antigravityToolCall(toolCall);
    return call ? convertAntigravityToolUse(context.timestamp, call) : null;
  }

  fromSessionUpdate(
    notification: Record<string, unknown>,
    context: AcpSessionUpdateContext,
  ): ChatMessage[] {
    const update = asObject(notification.update);
    const session = this.#sessionFor(context.sessionId);
    switch (asString(update.sessionUpdate)) {
      case 'agent_message_chunk': {
        const text = chunkText(update.content);
        const failure = antigravityExecutorError(text);
        if (failure) session.failure ??= failure;
        else session.assistantText += text;
        return [];
      }
      case 'agent_thought_chunk':
        session.thinkingText += chunkText(update.content);
        return [];
      case 'tool_call':
        return this.#toolCall(session, update, context.timestamp);
      case 'tool_call_update':
        return this.#toolCallUpdate(session, update, context.timestamp);
      default:
        return [];
    }
  }

  endTurn(sessionId: string, context: AcpSessionUpdateContext): ChatMessage[] {
    return this.#flush(this.#sessionFor(sessionId), context.timestamp);
  }

  releaseSession(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  takeTurnFailure(sessionId: string): string | null {
    const session = this.#sessions.get(sessionId);
    const failure = session?.failure ?? null;
    if (session) session.failure = null;
    return failure;
  }

  #toolCall(session: SessionState, update: Record<string, unknown>, timestamp: string): ChatMessage[] {
    const call = antigravityToolCall(update);
    if (!call) return [];
    this.#rememberToolName(session, call.toolCallId, call.name);
    const messages = this.#flush(session, timestamp);
    if (session.emittedToolIds.has(call.toolCallId)) return messages;
    session.emittedToolIds.add(call.toolCallId);
    messages.push(convertAntigravityToolUse(timestamp, call));
    return messages;
  }

  #toolCallUpdate(session: SessionState, update: Record<string, unknown>, timestamp: string): ChatMessage[] {
    const status = asString(update.status);
    if (status !== 'completed' && status !== 'failed') return [];
    const toolCallId = asString(update.toolCallId);
    if (!toolCallId) return [];
    // A terminal update can be the first frame for a call, so its tool row comes first.
    const messages = this.#toolCall(session, update, timestamp);
    const name = asString(update.name) ?? session.toolNames.get(toolCallId) ?? '';
    session.toolNames.delete(toolCallId);
    const text = antigravityToolResultText(name, toolResultText(update));
    const failed = status === 'failed';
    const content = text.trim() ? { raw: text } : failed ? { status } : {};
    messages.push(new ToolResultMessage(timestamp, toolCallId, content, failed));
    return messages;
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
      failure: null,
      emittedToolIds: new Set(),
      toolNames: new Map(),
    };
    this.#sessions.set(sessionId, created);
    return created;
  }
}
