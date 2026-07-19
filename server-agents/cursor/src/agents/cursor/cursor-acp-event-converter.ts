import {
  AssistantMessage,
  CursorAskQuestionToolUseMessage,
  CursorCreatePlanToolUseMessage,
  ThinkingMessage,
  ToolResultMessage,
  type ChatMessage,
  type CursorAskQuestionPrompt,
  type CursorPlanPhase,
  type CursorPlanTodo,
  type CursorPlanTodoStatus,
  type ToolUseChatMessage,
} from '@garcon/common/chat-types';
import type { PermissionDecisionPayload } from '@garcon/common/chat-command-contracts';
import { normalizeCursorToolResultContent } from './tool-result-converter.js';
import { convertCursorToolUse } from './tool-use-converter.js';
import {
  asObject,
  asString,
  type AcpBlockingRequestToolUse,
  type AcpCustomRequest,
  type AcpEventConverter,
  type AcpSessionUpdateContext,
} from '../shared/acp-event-converter.js';

const TERMINAL_TOOL_STATUSES = new Set(['completed', 'failed', 'errored', 'rejected', 'cancelled']);
const MAX_TOOL_SNAPSHOTS_PER_SESSION = 512;

interface TurnBuffer {
  assistantText: string;
  thinkingText: string;
  emittedToolIds: Set<string>;
}

interface ToolCallSnapshot {
  toolCallId: string;
  rawName?: string;
  kind?: string;
  title?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown[];
  locations?: unknown[];
  highLevelToolCallResult?: unknown;
}

interface SessionState {
  buffer: TurnBuffer;
  toolCalls: Map<string, ToolCallSnapshot>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function canonicalText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function toolNameFromIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const beforeColon = value.split(':')[0] ?? value;
  const leaf = beforeColon.split('.').pop();
  return canonicalText(leaf);
}

function chunkText(value: unknown): string {
  if (typeof value === 'string') return value;
  const content = asObject(value);
  return asString(content.text ?? content.content ?? content.delta) ?? '';
}

function toolCallIdFrom(value: Record<string, unknown>): string {
  return asString(value.toolCallId ?? value.tool_call_id ?? value.callId ?? value.id) ?? '';
}

function normalizedKind(value: Record<string, unknown>): string | undefined {
  return canonicalText(asString(value.kind)?.toLowerCase());
}

function rawToolName(value: Record<string, unknown>): string | undefined {
  const explicit = canonicalText(asString(value.toolName ?? value.tool_name ?? value.name));
  if (explicit) return explicit;
  return normalizedKind(value);
}

function toolCallTextContent(rawContent: unknown): string {
  const parts = asArray(rawContent);
  const textParts: string[] = [];
  for (const entry of parts) {
    const content = asObject(entry);
    const contentType = asString(content.type) ?? '';
    if (contentType === 'content') {
      const block = asObject(content.content);
      const text = asString(block.text);
      if (text) textParts.push(text);
      continue;
    }
    if (contentType === 'diff') {
      const diff = asObject(content.diff);
      const oldText = asString(diff.oldText ?? diff.old_text);
      const newText = asString(diff.newText ?? diff.new_text);
      if (oldText || newText) {
        textParts.push([oldText, newText].filter(Boolean).join('\n'));
      }
      continue;
    }
    const fallbackText = asString(content.text);
    if (fallbackText) textParts.push(fallbackText);
  }
  return textParts.filter((part) => part.trim().length > 0).join('\n');
}

function inferredInput(snapshot: ToolCallSnapshot): Record<string, unknown> {
  const inferred: Record<string, unknown> = {};
  const kind = snapshot.kind?.toLowerCase();
  const locations = snapshot.locations ?? [];
  const firstLocation = locations
    .map((entry) => asObject(entry))
    .find((entry) => typeof entry.path === 'string');
  const firstPath = asString(firstLocation?.path);
  const contentText = toolCallTextContent(snapshot.content);

  if (firstPath) inferred.path = firstPath;
  if (snapshot.title) inferred.title = snapshot.title;
  if (snapshot.kind) inferred.kind = snapshot.kind;

  if (kind === 'execute' && contentText) {
    inferred.command = contentText;
  }

  if (kind === 'search' && contentText) {
    inferred.pattern = contentText;
  }

  if (kind === 'fetch' && contentText) {
    inferred.prompt = contentText;
  }

  if (locations.length > 0) inferred.locations = locations;
  if (contentText) inferred.content = contentText;

  return inferred;
}

function toolInputFromSnapshot(snapshot: ToolCallSnapshot): unknown {
  if (snapshot.rawInput !== undefined) return snapshot.rawInput;
  return inferredInput(snapshot);
}

function toolOutputFromSnapshot(snapshot: ToolCallSnapshot): unknown {
  if (snapshot.rawOutput !== undefined) return snapshot.rawOutput;
  const contentText = toolCallTextContent(snapshot.content);
  if (!contentText) return undefined;
  return contentText;
}

function hasTerminalToolStatus(status: string | undefined): boolean {
  if (!status) return false;
  return TERMINAL_TOOL_STATUSES.has(status);
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

function cursorPlanTodoStatus(value: unknown): CursorPlanTodoStatus {
  return value === 'completed'
    || value === 'in_progress'
    || value === 'cancelled'
    ? value
    : 'pending';
}

function cursorToolCallId(params: Record<string, unknown>, fallback: string): string {
  return asString(params.toolCallId ?? params.tool_call_id ?? params.callId ?? params.id) ?? fallback;
}

function cursorAskQuestions(rawQuestions: unknown): CursorAskQuestionPrompt[] {
  const questions: CursorAskQuestionPrompt[] = [];
  for (const rawQuestion of asArray(rawQuestions)) {
    const question = asObject(rawQuestion);
    const id = asString(question.id);
    const prompt = asString(question.prompt);
    if (!id || !prompt) continue;
    const options = asArray(question.options)
      .map((rawOption) => {
        const option = asObject(rawOption);
        const optionId = asString(option.id);
        const label = asString(option.label);
        return optionId && label ? { id: optionId, label } : null;
      })
      .filter((option): option is { id: string; label: string } => Boolean(option));
    questions.push({
      id,
      prompt,
      options,
      allowMultiple: asBoolean(question.allowMultiple),
    });
  }
  return questions;
}

function cursorPlanTodos(rawTodos: unknown): CursorPlanTodo[] {
  const todos: CursorPlanTodo[] = [];
  for (const rawTodo of asArray(rawTodos)) {
    const todo = asObject(rawTodo);
    const content = asString(todo.content);
    if (!content) continue;
    const normalized: CursorPlanTodo = {
      content,
      status: cursorPlanTodoStatus(todo.status),
    };
    const id = asString(todo.id);
    if (id) normalized.id = id;
    todos.push(normalized);
  }
  return todos;
}

function cursorPlanPhases(rawPhases: unknown): CursorPlanPhase[] | undefined {
  const phases: CursorPlanPhase[] = [];
  for (const rawPhase of asArray(rawPhases)) {
    const phase = asObject(rawPhase);
    const name = asString(phase.name);
    if (!name) continue;
    phases.push({
      name,
      todos: cursorPlanTodos(phase.todos),
    });
  }
  return phases.length > 0 ? phases : undefined;
}

function cursorAskQuestionResponse(decision: PermissionDecisionPayload): Record<string, unknown> {
  if (decision.response) return decision.response;
  if (!decision.allow) {
    return { outcome: { outcome: 'skipped', reason: 'User skipped question' } };
  }
  return { outcome: { outcome: 'skipped', reason: 'No answer was provided' } };
}

function cursorCreatePlanResponse(decision: PermissionDecisionPayload): Record<string, unknown> {
  if (decision.response) return decision.response;
  if (decision.allow) return { outcome: { outcome: 'accepted' } };
  return { outcome: { outcome: 'rejected', reason: 'User rejected plan' } };
}

function cursorCancelledResponse(): Record<string, unknown> {
  return { outcome: { outcome: 'cancelled' } };
}

export class CursorAcpEventConverter implements AcpEventConverter {
  #sessions = new Map<string, SessionState>();

  beginTurn(sessionId: string): void {
    const session = this.#sessionFor(sessionId);
    session.buffer = {
      assistantText: '',
      thinkingText: '',
      emittedToolIds: new Set(),
    };
  }

  permissionToolUse(toolCall: Record<string, unknown>, context: AcpSessionUpdateContext): ToolUseChatMessage | null {
    const snapshot = this.#captureToolSnapshot(context.sessionId, toolCall);
    const toolCallId = snapshot?.toolCallId ?? toolCallIdFrom(toolCall);
    if (!toolCallId) return null;

    const rawName = snapshot?.rawName
      ?? rawToolName(toolCall)
      ?? toolNameFromIdentifier(toolCallId)
      ?? asString(toolCall.title)
      ?? 'Permission';
    const input = snapshot ? toolInputFromSnapshot(snapshot) : (toolCall.rawInput ?? toolCall.input ?? {});

    return convertCursorToolUse(context.timestamp, {
      id: toolCallId,
      name: rawName,
      input,
    });
  }

  customRequestToolUse(
    request: AcpCustomRequest,
    context: AcpSessionUpdateContext,
  ): AcpBlockingRequestToolUse | null {
    const params = asObject(request.params);

    if (request.method === 'cursor/ask_question') {
      const toolId = cursorToolCallId(params, `cursor-question-${String(request.requestId)}`);
      return {
        tool: new CursorAskQuestionToolUseMessage(
          context.timestamp,
          toolId,
          asString(params.title),
          cursorAskQuestions(params.questions),
        ),
        responseForDecision: cursorAskQuestionResponse,
        responseForCancellation: cursorCancelledResponse,
      };
    }

    if (request.method === 'cursor/create_plan') {
      const toolId = cursorToolCallId(params, `cursor-plan-${String(request.requestId)}`);
      return {
        tool: new CursorCreatePlanToolUseMessage(
          context.timestamp,
          toolId,
          asString(params.plan) ?? '',
          asString(params.name),
          asString(params.overview),
          cursorPlanTodos(params.todos),
          asBoolean(params.isProject),
          cursorPlanPhases(params.phases),
        ),
        responseForDecision: cursorCreatePlanResponse,
        responseForCancellation: cursorCancelledResponse,
      };
    }

    return null;
  }

  fromSessionUpdate(
    notification: Record<string, unknown>,
    context: AcpSessionUpdateContext,
  ): ChatMessage[] {
    const update = asObject(notification.update);
    const updateType = asString(update.sessionUpdate);
    if (!updateType) return [];

    const session = this.#sessionFor(context.sessionId);
    const buffer = session.buffer;
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
      const snapshot = this.#captureToolSnapshot(context.sessionId, update);
      const toolCallId = snapshot?.toolCallId ?? '';
      const rawName = snapshot?.rawName ?? toolNameFromIdentifier(toolCallId) ?? 'Unknown';

      const messages = this.#flushChunks(buffer, timestamp);
      if (toolCallId && buffer.emittedToolIds.has(toolCallId)) return messages;
      if (toolCallId) buffer.emittedToolIds.add(toolCallId);

      messages.push(convertCursorToolUse(timestamp, {
        id: toolCallId,
        name: rawName,
        input: snapshot ? toolInputFromSnapshot(snapshot) : (update.rawInput ?? update.input ?? update.args ?? {}),
      }));
      return messages;
    }

    if (updateType === 'tool_call_update') {
      const snapshot = this.#captureToolSnapshot(context.sessionId, update);
      const status = asString(update.status);
      const rawOutput = snapshot ? toolOutputFromSnapshot(snapshot) : undefined;
      if (!hasTerminalToolStatus(status) && rawOutput === undefined) return [];

      const toolCallId = snapshot?.toolCallId ?? toolCallIdFrom(update);
      const toolName = snapshot?.rawName ?? toolNameFromIdentifier(toolCallId) ?? 'Unknown';
      const output = rawOutput === undefined
        ? { status: status ?? 'unknown' }
        : normalizeCursorToolResultContent(toolName, rawOutput, snapshot?.highLevelToolCallResult);

      if (snapshot && hasTerminalToolStatus(status) && toolCallId) {
        session.toolCalls.delete(toolCallId);
      }

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
    const session = this.#sessionFor(sessionId);
    return this.#flushChunks(session.buffer, context.timestamp);
  }

  #sessionFor(sessionId: string): SessionState {
    const existing = this.#sessions.get(sessionId);
    if (existing) return existing;
    const created: SessionState = {
      buffer: {
        assistantText: '',
        thinkingText: '',
        emittedToolIds: new Set(),
      },
      toolCalls: new Map(),
    };
    this.#sessions.set(sessionId, created);
    return created;
  }

  #captureToolSnapshot(sessionId: string, update: Record<string, unknown>): ToolCallSnapshot | null {
    const toolCallId = toolCallIdFrom(update);
    if (!toolCallId) return null;

    const session = this.#sessionFor(sessionId);
    const existing = session.toolCalls.get(toolCallId);
    const candidateRawName = rawToolName(update);
    const candidateTitle = canonicalText(asString(update.title));
    const candidateKind = normalizedKind(update);
    const candidateRawInput = update.rawInput ?? update.raw_input ?? update.input ?? update.args;
    const candidateRawOutput = update.rawOutput ?? update.raw_output ?? update.output ?? update.result;
    const candidateContent = asArray(update.content);
    const candidateLocations = asArray(update.locations);
    const candidateHighLevel = update.highLevelToolCallResult ?? update.high_level_tool_call_result;

    const snapshot: ToolCallSnapshot = {
      toolCallId,
      rawName: candidateRawName ?? existing?.rawName,
      kind: candidateKind ?? existing?.kind,
      title: candidateTitle ?? existing?.title,
      rawInput: candidateRawInput !== undefined ? candidateRawInput : existing?.rawInput,
      rawOutput: candidateRawOutput !== undefined ? candidateRawOutput : existing?.rawOutput,
      content: candidateContent.length > 0 ? candidateContent : existing?.content,
      locations: candidateLocations.length > 0 ? candidateLocations : existing?.locations,
      highLevelToolCallResult: candidateHighLevel ?? existing?.highLevelToolCallResult,
    };

    if (!snapshot.rawName) {
      snapshot.rawName = snapshot.kind ?? snapshot.title ?? toolNameFromIdentifier(toolCallId) ?? 'Unknown';
    }

    session.toolCalls.set(toolCallId, snapshot);
    if (session.toolCalls.size > MAX_TOOL_SNAPSHOTS_PER_SESSION) {
      const oldestToolCallId = session.toolCalls.keys().next().value;
      if (typeof oldestToolCallId === 'string') session.toolCalls.delete(oldestToolCallId);
    }
    return snapshot;
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
