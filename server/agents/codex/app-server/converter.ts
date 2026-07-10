import {
  AssistantMessage,
  BashToolUseMessage,
  CompactionMessage,
  EditToolUseMessage,
  ErrorMessage,
  ExecToolUseMessage,
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
  type CompactionTrigger,
} from "../../../../common/chat-types.js";
import { stripResolvedFileMentionContext } from "../../shared/file-mention-context.js";
import { normalizeTodoItems, normalizeToolInput, normalizeToolResultContent } from "../../shared/normalize-util.js";
import { convertCodexSubagentToolUse } from '../subagent-tool-use.js';
import type { CodexRawResponseItem, CodexThreadItem, CodexUserInput, CodexWebSearchAction } from './protocol.js';

export interface ConvertCodexAppServerItemOptions {
  includeUserMessages?: boolean;
  // Trigger for a contextCompaction item, which the item itself does not carry.
  compactionTrigger?: CompactionTrigger;
}

export function convertCodexAppServerLiveItem(
  item: CodexThreadItem,
  timestamp = new Date().toISOString(),
  compactionTrigger?: CompactionTrigger,
): ChatMessage[] {
  return convertCodexAppServerItem(item, timestamp, { includeUserMessages: false, compactionTrigger });
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
    case 'contextCompaction':
      // The app-server exposes only a marker for compaction (no summary or
      // tokens); the trigger is supplied by the runtime, which knows whether
      // /compact initiated it. Defaults to 'manual' when unknown.
      return [new CompactionMessage(timestamp, options.compactionTrigger ?? 'manual', '')];
    case 'hookPrompt':
    case 'imageView':
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      return [];
    default:
      return [];
  }
}

export function convertCodexRawExecItem(
  item: CodexRawResponseItem,
  timestamp: string,
  activeExecCallIds: Set<string>,
): ChatMessage[] {
  if (
    item.type === 'custom_tool_call'
    && item.name === 'exec'
    && typeof item.call_id === 'string'
    && typeof item.input === 'string'
  ) {
    if (activeExecCallIds.has(item.call_id)) return [];
    activeExecCallIds.add(item.call_id);
    return [new ExecToolUseMessage(timestamp, item.call_id, item.input, 'javascript')];
  }

  if (
    item.type === 'custom_tool_call_output'
    && typeof item.call_id === 'string'
    && activeExecCallIds.delete(item.call_id)
  ) {
    return [
      new ToolResultMessage(
        timestamp,
        item.call_id,
        normalizeToolResultContent(item.output),
        false,
      ),
    ];
  }

  return [];
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
  const query = webSearchDisplayQuery(item);
  if (!query) return [];
  const messages: ChatMessage[] = [new WebSearchToolUseMessage(timestamp, item.id, query)];
  messages.push(new ToolResultMessage(timestamp, item.id, normalizeToolResultContent(`Searched: ${query}`), false));
  return messages;
}

function webSearchDisplayQuery(item: Extract<CodexThreadItem, { type: 'webSearch' }>): string {
  const directQuery = stringValue(item.query);
  if (directQuery) return directQuery;
  return webSearchActionDisplayQuery(item.action);
}

function webSearchActionDisplayQuery(action: CodexWebSearchAction | null): string {
  if (!action) return '';
  switch (action.type) {
    case 'search':
      return firstNonEmpty(action.query, ...stringArray(action.queries));
    case 'openPage':
    case 'open_page':
      return action.url?.trim() ?? '';
    case 'findInPage':
    case 'find_in_page':
      return firstNonEmpty(action.pattern, action.url);
    case 'other':
      return '';
  }
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  return values.map(stringValue).find(Boolean) ?? '';
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function convertDynamicToolCall(item: Extract<CodexThreadItem, { type: 'dynamicToolCall' }>, timestamp: string): ChatMessage[] {
  const input = normalizeToolInput(item.arguments);
  const toolUse = convertKnownDynamicTool(timestamp, item.id, item.tool, item.namespace, input)
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
  namespace: string | null,
  input: Record<string, unknown>,
): ChatMessage | null {
  const subagentToolUse = namespace ? null : convertCodexSubagentToolUse(timestamp, id, tool, input);
  if (subagentToolUse) return subagentToolUse;

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

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
