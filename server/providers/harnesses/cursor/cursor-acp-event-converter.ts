import {
  AssistantMessage,
  ThinkingMessage,
  ToolResultMessage,
  type ChatMessage,
} from '../../../../common/chat-types.js';
import { normalizeCursorToolResultContent } from '../../converters/cursor-tool-result.js';
import { convertCursorToolUse } from '../../converters/cursor-tool-use.js';
import { asObject, asString, type AcpEventConverter, type AcpSessionUpdateContext } from '../../acp/event-converter.js';

interface TurnBuffer {
  assistantText: string;
  thinkingText: string;
  emittedToolIds: Set<string>;
}

function toolNameFromIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const beforeColon = value.split(':')[0] ?? value;
  const leaf = beforeColon.split('.').pop();
  return leaf?.trim() || undefined;
}

function chunkText(value: unknown): string {
  if (typeof value === 'string') return value;
  const content = asObject(value);
  return asString(content.text ?? content.content ?? content.delta) ?? '';
}

function hasTerminalToolStatus(status: string | undefined): boolean {
  if (!status) return false;
  return status === 'completed'
    || status === 'failed'
    || status === 'errored'
    || status === 'rejected'
    || status === 'cancelled';
}

function hasToolError(update: Record<string, unknown>): boolean {
  const status = asString(update.status);
  return status === 'failed'
    || status === 'errored'
    || status === 'rejected'
    || update.isError === true
    || update.is_error === true
    || update.error === true;
}

export class CursorAcpEventConverter implements AcpEventConverter {
  #buffers = new Map<string, TurnBuffer>();

  beginTurn(sessionId: string): void {
    this.#buffers.set(sessionId, {
      assistantText: '',
      thinkingText: '',
      emittedToolIds: new Set(),
    });
  }

  fromSessionUpdate(
    notification: Record<string, unknown>,
    context: AcpSessionUpdateContext,
  ): ChatMessage[] {
    const update = asObject(notification.update);
    const updateType = asString(update.sessionUpdate);
    if (!updateType) return [];

    const buffer = this.#bufferFor(context.sessionId);
    const timestamp = context.timestamp;

    if (updateType === 'agent_thought_chunk') {
      buffer.thinkingText += chunkText(update.content);
      return [];
    }

    if (updateType === 'agent_message_chunk') {
      buffer.assistantText += chunkText(update.content);
      return [];
    }

    if (updateType === 'agent_thought') {
      buffer.thinkingText += chunkText(update.content);
      return [];
    }

    if (updateType === 'agent_message') {
      buffer.assistantText += chunkText(update.content);
      return [];
    }

    if (updateType === 'tool_call') {
      const toolCallId = asString(update.toolCallId ?? update.tool_call_id ?? update.callId ?? update.id) ?? '';
      const toolName = asString(update.toolName ?? update.tool_name ?? update.name)
        ?? toolNameFromIdentifier(toolCallId)
        ?? 'Unknown';
      const rawInput = update.rawInput ?? update.input ?? update.args ?? {};

      const messages = this.#flushChunks(buffer, timestamp);
      if (toolCallId && buffer.emittedToolIds.has(toolCallId)) return messages;
      if (toolCallId) buffer.emittedToolIds.add(toolCallId);
      messages.push(convertCursorToolUse(timestamp, {
        id: toolCallId,
        name: toolName,
        input: rawInput,
      }));
      return messages;
    }

    if (updateType === 'tool_call_update') {
      const status = asString(update.status);
      const rawOutput = update.rawOutput ?? update.output ?? update.result;
      if (!hasTerminalToolStatus(status) && rawOutput === undefined) return [];

      const toolCallId = asString(update.toolCallId ?? update.tool_call_id ?? update.callId ?? update.id) ?? '';
      const toolName = asString(update.toolName ?? update.tool_name ?? update.name)
        ?? toolNameFromIdentifier(toolCallId)
        ?? 'Unknown';
      const output = rawOutput === undefined
        ? { status: status ?? 'unknown' }
        : normalizeCursorToolResultContent(toolName, rawOutput, update.highLevelToolCallResult);

      return [
        new ToolResultMessage(
          timestamp,
          toolCallId,
          typeof output === 'object' && output !== null && !Array.isArray(output)
            ? output as Record<string, unknown>
            : { output },
          hasToolError(update),
        ),
      ];
    }

    return [];
  }

  endTurn(sessionId: string, context: AcpSessionUpdateContext): ChatMessage[] {
    const buffer = this.#bufferFor(sessionId);
    const messages = this.#flushChunks(buffer, context.timestamp);
    this.#buffers.delete(sessionId);
    return messages;
  }

  #bufferFor(sessionId: string): TurnBuffer {
    const existing = this.#buffers.get(sessionId);
    if (existing) return existing;
    const next: TurnBuffer = {
      assistantText: '',
      thinkingText: '',
      emittedToolIds: new Set(),
    };
    this.#buffers.set(sessionId, next);
    return next;
  }

  #flushChunks(buffer: TurnBuffer, timestamp: string): ChatMessage[] {
    const messages: ChatMessage[] = [];
    const thinking = buffer.thinkingText.trim();
    const assistant = buffer.assistantText.trim();

    if (thinking) {
      messages.push(new ThinkingMessage(timestamp, thinking));
      buffer.thinkingText = '';
    }

    if (assistant) {
      messages.push(new AssistantMessage(timestamp, assistant));
      buffer.assistantText = '';
    }

    return messages;
  }
}
