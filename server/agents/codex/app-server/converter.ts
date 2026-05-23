import {
  AssistantMessage,
  BashToolUseMessage,
  EditToolUseMessage,
  ErrorMessage,
  ExternalToolUseMessage,
  GlobToolUseMessage,
  GrepToolUseMessage,
  ListToolUseMessage,
  McpToolUseMessage,
  ReadToolUseMessage,
  ThinkingMessage,
  TodoWriteToolUseMessage,
  ToolResultMessage,
  UpdatePlanToolUseMessage,
  UserMessage,
  WebFetchToolUseMessage,
  WebSearchToolUseMessage,
  WriteStdinToolUseMessage,
  WriteToolUseMessage,
  type ChatMessage,
} from "../../../../common/chat-types.js";
import { stripResolvedFileMentionContext } from "../../shared/file-mention-context.js";
import { normalizeTodoItems, normalizeToolInput, normalizeToolResultContent } from "../../shared/normalize-util.js";
import type { CodexThread, CodexThreadItem, CodexTurn, CodexUserInput } from './protocol.js';

export interface ConvertCodexAppServerItemOptions {
  includeUserMessages?: boolean;
}

export function convertCodexAppServerThread(thread: CodexThread): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const turn of thread.turns ?? []) {
    const timestamp = timestampFromTurn(turn, thread.updatedAt);
    for (const item of turn.items ?? []) {
      messages.push(...convertCodexAppServerItem(item, timestamp));
    }
  }
  return messages;
}

export function convertCodexAppServerLiveItem(item: CodexThreadItem, timestamp = new Date().toISOString()): ChatMessage[] {
  return convertCodexAppServerItem(item, timestamp, { includeUserMessages: false });
}

export function convertCodexAppServerTurnMissingItems(
  turn: CodexTurn,
  alreadyEmittedItemIds: ReadonlySet<string>,
  options: ConvertCodexAppServerItemOptions = {},
): ChatMessage[] {
  const timestamp = timestampFromTurn(turn);
  const messages: ChatMessage[] = [];
  for (const item of turn.items ?? []) {
    if (alreadyEmittedItemIds.has(item.id)) continue;
    messages.push(...convertCodexAppServerItem(item, timestamp, options));
  }
  return messages;
}

export function convertCodexAppServerItem(
  item: CodexThreadItem,
  timestamp = new Date().toISOString(),
  options: ConvertCodexAppServerItemOptions = {},
): ChatMessage[] {
  switch (item.type) {
    case 'userMessage': {
      if (options.includeUserMessages === false) return [];
      const text = userInputText(item.content);
      return text.trim() ? [new UserMessage(timestamp, stripResolvedFileMentionContext(text))] : [];
    }
    case 'agentMessage':
      return item.text?.trim() ? [new AssistantMessage(timestamp, item.text)] : [];
    case 'plan':
      return item.text?.trim() ? [new AssistantMessage(timestamp, item.text)] : [];
    case 'reasoning': {
      const text = [...(item.summary ?? []), ...(item.content ?? [])].filter(Boolean).join('\n');
      return text.trim() ? [new ThinkingMessage(timestamp, text)] : [];
    }
    case 'commandExecution':
      return convertCommandExecution(item, timestamp);
    case 'fileChange':
      return convertFileChange(item, timestamp);
    case 'webSearch':
      return convertWebSearch(item, timestamp);
    case 'dynamicToolCall':
      return convertDynamicToolCall(item, timestamp);
    case 'mcpToolCall':
      return convertMcpToolCall(item, timestamp);
    case 'imageGeneration':
      return item.result ? [new ToolResultMessage(timestamp, item.id, normalizeToolResultContent(item.result), item.status === 'failed')] : [];
    case 'hookPrompt':
    case 'imageView':
    case 'enteredReviewMode':
    case 'exitedReviewMode':
    case 'contextCompaction':
      return [];
    default:
      return [];
  }
}

export function getCodexThreadPreview(thread: CodexThread): { firstMessage: string; lastMessage: string; lastActivity: string; createdAt: string | null } {
  const messages = convertCodexAppServerThread(thread);
  const firstUser = messages.find((message): message is UserMessage => message instanceof UserMessage);
  const lastMessage = [...messages].reverse().find((message) => message instanceof UserMessage || message instanceof AssistantMessage);

  return {
    firstMessage: firstUser?.content || thread.preview || 'Unknown Codex Session',
    lastMessage: lastMessage instanceof UserMessage || lastMessage instanceof AssistantMessage
      ? lastMessage.content
      : firstUser?.content || thread.preview || 'Unknown Codex Session',
    lastActivity: timestampFromNumber(thread.updatedAt) ?? new Date().toISOString(),
    createdAt: timestampFromNumber(thread.createdAt),
  };
}

function convertCommandExecution(item: Extract<CodexThreadItem, { type: 'commandExecution' }>, timestamp: string): ChatMessage[] {
  const messages: ChatMessage[] = [
    new BashToolUseMessage(timestamp, item.id, item.command || ''),
  ];
  if (item.status !== 'inProgress') {
    const content = item.aggregatedOutput || (item.status === 'completed' ? '' : item.status);
    messages.push(new ToolResultMessage(timestamp, item.id, normalizeToolResultContent(content), item.exitCode !== null ? item.exitCode !== 0 : item.status !== 'completed'));
  }
  return messages;
}

function convertFileChange(item: Extract<CodexThreadItem, { type: 'fileChange' }>, timestamp: string): ChatMessage[] {
  const messages: ChatMessage[] = [
    new EditToolUseMessage(timestamp, item.id, undefined, undefined, undefined, item.changes),
  ];
  if (item.status !== 'inProgress') {
    messages.push(new ToolResultMessage(
      timestamp,
      item.id,
      normalizeToolResultContent(item.status === 'completed' ? 'File changes applied' : item.status),
      item.status !== 'completed',
    ));
  }
  return messages;
}

function convertWebSearch(item: Extract<CodexThreadItem, { type: 'webSearch' }>, timestamp: string): ChatMessage[] {
  const query = item.query || '';
  const messages: ChatMessage[] = [new WebSearchToolUseMessage(timestamp, item.id, query)];
  if (query) {
    messages.push(new ToolResultMessage(timestamp, item.id, normalizeToolResultContent(`Searched: ${query}`), false));
  }
  return messages;
}

function convertDynamicToolCall(item: Extract<CodexThreadItem, { type: 'dynamicToolCall' }>, timestamp: string): ChatMessage[] {
  const input = normalizeToolInput(item.arguments);
  const toolUse = convertKnownDynamicTool(timestamp, item.id, item.tool, input)
    ?? new ExternalToolUseMessage(timestamp, item.id, item.tool, input, item.namespace);
  const messages: ChatMessage[] = [toolUse];
  if (item.status !== 'inProgress') {
    messages.push(new ToolResultMessage(
      timestamp,
      item.id,
      normalizeToolResultContent(item.contentItems ?? item.success),
      item.success === false || item.status === 'failed',
    ));
  }
  return messages;
}

function convertMcpToolCall(item: Extract<CodexThreadItem, { type: 'mcpToolCall' }>, timestamp: string): ChatMessage[] {
  const messages: ChatMessage[] = [
    new McpToolUseMessage(timestamp, item.id, item.server, item.tool, normalizeToolInput(item.arguments)),
  ];
  if (item.status !== 'inProgress') {
    messages.push(new ToolResultMessage(timestamp, item.id, normalizeToolResultContent(item.error ?? item.result), Boolean(item.error || item.status === 'failed')));
  }
  return messages;
}

function convertKnownDynamicTool(
  timestamp: string,
  id: string,
  tool: string,
  input: Record<string, unknown>,
): ChatMessage | null {
  switch (tool) {
    case 'shell_command':
    case 'exec_command':
    case 'bash':
      return new BashToolUseMessage(timestamp, id, stringField(input.command) || stringField(input.cmd) || '');
    case 'read':
      return new ReadToolUseMessage(timestamp, id, stringField(input.filePath) || stringField(input.path) || '');
    case 'list':
      return new ListToolUseMessage(timestamp, id, stringField(input.path));
    case 'edit':
    case 'apply_patch':
      return new EditToolUseMessage(timestamp, id, stringField(input.filePath) || stringField(input.path), stringField(input.oldString), stringField(input.newString));
    case 'write':
      return new WriteToolUseMessage(timestamp, id, stringField(input.filePath) || stringField(input.path) || '', stringField(input.content));
    case 'grep':
      return new GrepToolUseMessage(timestamp, id, stringField(input.pattern), stringField(input.path));
    case 'glob':
      return new GlobToolUseMessage(timestamp, id, stringField(input.pattern), stringField(input.path));
    case 'web_search':
      return new WebSearchToolUseMessage(timestamp, id, stringField(input.query) || '');
    case 'web_fetch':
      return new WebFetchToolUseMessage(timestamp, id, stringField(input.url) || '', stringField(input.prompt));
    case 'update_plan':
      return new UpdatePlanToolUseMessage(timestamp, id, normalizeTodoItems(input.items ?? input.todos ?? input.plan));
    case 'write_stdin':
      return new WriteStdinToolUseMessage(timestamp, id, input);
    case 'todo_list':
      return new TodoWriteToolUseMessage(timestamp, id, normalizeTodoItems(input.items ?? input.todos));
    default:
      return null;
  }
}

function userInputText(content: CodexUserInput[]): string {
  return (content ?? [])
    .map((item) => item.type === 'text' ? item.text : '')
    .filter(Boolean)
    .join('\n');
}

function timestampFromTurn(turn: CodexTurn, fallback?: number | null): string {
  return timestampFromNumber(turn.completedAt ?? turn.startedAt ?? fallback) ?? new Date().toISOString();
}

function timestampFromNumber(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const millis = value > 10_000_000_000 ? value : value * 1000;
  return new Date(millis).toISOString();
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
