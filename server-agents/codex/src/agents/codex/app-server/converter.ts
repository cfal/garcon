import {
  AssistantMessage,
  BashToolUseMessage,
  CompactionMessage,
  CodexSubagentToolUseMessage,
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
  type CodexSubagentAction,
  type CodexSubagentDetails,
  type CodexSubagentState,
  type CompactionTrigger,
} from '@garcon/common/chat-types';
import { stripResolvedFileMentionContext } from '@garcon/server-agent-common/shared/file-mention-context';
import { normalizeTodoItems, normalizeToolInput, normalizeToolResultContent } from '@garcon/server-agent-common/shared/normalize-util';
import { convertCodexSubagentToolUse } from '../subagent-tool-use.js';
import { convertCodexWaitFunctionCall } from '../jsonl-tool-use-converter.js';
import {
  codexCodeModeResultToolId,
  createCodexCodeModeBashMessages,
  projectCodexCodeModeCommands,
  rememberCodexCodeModeResult,
} from '../code-mode-command-projection.js';
import {
  convertCodexSubagentActivity,
  convertCodexInterAgentLifecycle,
  convertCodexSubagentLifecycleText,
} from '../subagent-lifecycle.js';
import { normalizeCodexCommandDisplay } from './command-display.js';
import type {
  CodexCollabAgentState,
  CodexCollabAgentTool,
  CodexRawResponseItem,
  CodexThreadItem,
  CodexUserInput,
  CodexWebSearchAction,
} from './protocol.js';

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
      const text = userInputText(item.content);
      if (options.includeUserMessages === false) return [];
      return text.trim() ? [new UserMessage(timestamp, stripResolvedFileMentionContext(text))] : [];
    }
    case 'agentMessage': {
      return item.text?.trim() ? [new AssistantMessage(timestamp, item.text)] : [];
    }
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
    case 'collabAgentToolCall':
      return convertCollabAgentToolCall(item, timestamp);
    case 'subAgentActivity':
      return [convertCodexSubagentActivity(
        timestamp,
        item.id,
        item.kind,
        item.agentThreadId,
        item.agentPath,
      )];
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
      case 'sleep':
      case 'enteredReviewMode':
    case 'exitedReviewMode':
      return [];
    default:
      return [];
  }
}

export function convertCodexRawCodeModeItem(
  item: CodexRawResponseItem,
  timestamp: string,
  activeCodeModeResultToolIds: Map<string, string>,
): ChatMessage[] {
  if (item.type === 'agent_message') {
    const text = rawResponseItemText(item.content);
    const lifecycle = convertCodexInterAgentLifecycle(
      timestamp,
      item.id ?? `subagent-lifecycle-${timestamp}`,
      item.author,
      item.recipient,
      text,
    );
    return lifecycle ? [lifecycle] : [];
  }

  if (item.type === 'message' && item.role === 'user') {
    const text = rawResponseItemText(item.content);
    const lifecycle = convertCodexSubagentLifecycleText(
      timestamp,
      item.id ?? `subagent-lifecycle-${timestamp}`,
      text,
    );
    return lifecycle ? [lifecycle] : [];
  }

  if (
    item.type === 'custom_tool_call'
    && item.name === 'exec'
    && typeof item.call_id === 'string'
    && typeof item.input === 'string'
  ) {
    if (activeCodeModeResultToolIds.has(item.call_id)) return [];
    const projection = projectCodexCodeModeCommands(item.input);
    if (!projection) {
      rememberCodexCodeModeResult(activeCodeModeResultToolIds, item.call_id, item.call_id);
      return [new ExecToolUseMessage(timestamp, item.call_id, item.input, 'javascript')];
    }
    rememberCodexCodeModeResult(
      activeCodeModeResultToolIds,
      item.call_id,
      codexCodeModeResultToolId(item.call_id, projection),
    );
    return createCodexCodeModeBashMessages(timestamp, item.call_id, projection);
  }

  if (
    item.type === 'function_call'
    && item.name === 'wait'
    && typeof item.call_id === 'string'
  ) {
    if (activeCodeModeResultToolIds.has(item.call_id)) return [];
    const message = convertCodexWaitFunctionCall(timestamp, item.call_id, item.arguments);
    if (!message) return [];
    rememberCodexCodeModeResult(activeCodeModeResultToolIds, item.call_id, item.call_id);
    return [message];
  }

  if (
    (item.type === 'custom_tool_call_output' || item.type === 'function_call_output')
    && typeof item.call_id === 'string'
  ) {
    const resultToolId = activeCodeModeResultToolIds.get(item.call_id);
    if (!resultToolId) return [];
    activeCodeModeResultToolIds.delete(item.call_id);
    return [
      new ToolResultMessage(
        timestamp,
        resultToolId,
        normalizeToolResultContent(item.output),
        false,
      ),
    ];
  }

  return [];
}

function rawResponseItemText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  return content
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => typeof item.text === 'string' ? item.text : '')
    .filter(Boolean)
    .join('\n');
}

function convertCommandExecution(item: Extract<CodexThreadItem, { type: 'commandExecution' }>, timestamp: string): ChatMessage[] {
  const messages: ChatMessage[] = [
    new BashToolUseMessage(timestamp, item.id, normalizeCodexCommandDisplay(item.command || '')),
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

function convertCollabAgentToolCall(
  item: Extract<CodexThreadItem, { type: 'collabAgentToolCall' }>,
  timestamp: string,
): ChatMessage[] {
  const details: CodexSubagentDetails = {
    ...(item.receiverThreadIds.length === 1 ? { target: item.receiverThreadIds[0] } : {}),
    ...(item.receiverThreadIds.length > 1 ? { targets: item.receiverThreadIds } : {}),
    ...(item.prompt ? { message: item.prompt } : {}),
    ...(item.model ? { model: item.model } : {}),
    ...(item.reasoningEffort ? { reasoningEffort: item.reasoningEffort } : {}),
    agentStates: normalizeCollabAgentStates(item.agentsStates),
  };
  const messages: ChatMessage[] = [
    new CodexSubagentToolUseMessage(timestamp, item.id, collabAction(item.tool), details),
  ];
  if (item.status !== 'inProgress') {
    messages.push(new ToolResultMessage(
      timestamp,
      item.id,
      normalizeToolResultContent(item.agentsStates),
      item.status === 'failed',
    ));
  }
  return messages;
}

function collabAction(tool: CodexCollabAgentTool): CodexSubagentAction {
  switch (tool) {
    case 'spawnAgent': return 'spawn_agent';
    case 'sendInput': return 'send_input';
    case 'resumeAgent': return 'resume_agent';
    case 'wait': return 'wait_agent';
    case 'closeAgent': return 'close_agent';
  }
}

function normalizeCollabAgentStates(
  states: Record<string, CodexCollabAgentState>,
): Record<string, CodexSubagentState> {
  return Object.fromEntries(Object.entries(states).map(([agentId, agentState]) => [
    agentId,
    {
      status: agentState.status,
      ...(agentState.message ? { message: agentState.message } : {}),
    },
  ]));
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
