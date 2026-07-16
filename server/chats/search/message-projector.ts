import type { ChatMessage } from '../../../common/chat-types.js';
import type { ChatSearchSnippetRole } from '../../../common/chat-search.js';
import type { HistoricalSearchMessageRow, SearchMessageRowInput } from './worker-protocol.js';

const MAX_BODY_CHARS = 64_000;
const MAX_TOOL_INPUT_CHARS = 16_000;
const MAX_TOOL_RESULT_HEAD_CHARS = 2_000;
const MAX_TOOL_RESULT_TAIL_CHARS = 512;
const MAX_RECURSIVE_CHARS = 4_000;
const MAX_RECURSIVE_DEPTH = 8;

interface ExtractionBudget {
  remaining: number;
  seen: Set<object>;
}

function joinText(...values: Array<string | null | undefined>): string {
  return values.filter((value): value is string => Boolean(value)).join(' ');
}

function boundedUnknownText(
  value: unknown,
  budget: ExtractionBudget = { remaining: MAX_RECURSIVE_CHARS, seen: new Set() },
  depth = 0,
): string {
  if (budget.remaining <= 0 || depth > MAX_RECURSIVE_DEPTH || value == null) return '';
  let text = '';
  if (typeof value === 'string') {
    text = value.slice(0, budget.remaining);
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    text = String(value).slice(0, budget.remaining);
  } else if (typeof value === 'object') {
    if (budget.seen.has(value)) return '';
    budget.seen.add(value);
    const entries = Array.isArray(value)
      ? value.map((entry, index) => [String(index), entry] as const)
      : Object.entries(value as Record<string, unknown>);
    const parts: string[] = [];
    for (const [key, entry] of entries) {
      if (budget.remaining <= 0) break;
      const child = boundedUnknownText(entry, budget, depth + 1);
      if (!child) continue;
      parts.push(Array.isArray(value) ? child : `${key} ${child}`);
    }
    text = parts.join(' ');
  }
  budget.remaining -= text.length;
  return text;
}

function boundedToolResult(value: unknown): string {
  const text = typeof value === 'string'
    ? value
    : boundedUnknownText(value, { remaining: MAX_TOOL_RESULT_HEAD_CHARS + MAX_TOOL_RESULT_TAIL_CHARS, seen: new Set() });
  if (text.length <= MAX_TOOL_RESULT_HEAD_CHARS + MAX_TOOL_RESULT_TAIL_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_HEAD_CHARS)} ${text.slice(-MAX_TOOL_RESULT_TAIL_CHARS)}`;
}

function messageText(message: ChatMessage): string {
  switch (message.type) {
    case 'user-message':
    case 'assistant-message':
    case 'thinking':
    case 'error':
      return message.content;
    case 'compaction':
      return message.summary;
    case 'agent-switch':
      return joinText(message.fromAgentId, message.toAgentId, message.fromModel, message.toModel);
    case 'tool-result':
      return boundedToolResult(message.content);
    case 'permission-request':
      return messageText(message.requestedTool);
    case 'bash-tool-use':
      return joinText(message.description, message.command);
    case 'exec-tool-use':
      return joinText(message.language, message.code);
    case 'wait-tool-use':
      return joinText(
        message.executionId,
        message.yieldTimeMs === undefined ? undefined : String(message.yieldTimeMs),
        message.maxTokens === undefined ? undefined : String(message.maxTokens),
        message.terminate === undefined ? undefined : String(message.terminate),
      );
    case 'read-tool-use':
    case 'write-tool-use':
      return joinText(message.filePath, 'content' in message ? message.content : undefined);
    case 'list-tool-use':
      return message.path ?? '';
    case 'edit-tool-use':
    case 'apply-patch-tool-use':
      return joinText(
        message.filePath,
        message.oldString,
        message.newString,
        'patch' in message ? message.patch : undefined,
      );
    case 'grep-tool-use':
    case 'glob-tool-use':
      return joinText(message.pattern, message.path);
    case 'web-search-tool-use':
    case 'amp-finder-tool-use':
    case 'amp-librarian-tool-use':
    case 'amp-find-thread-tool-use':
      return joinText(message.query, 'context' in message ? message.context : undefined);
    case 'web-fetch-tool-use':
      return joinText(message.url, message.prompt);
    case 'todo-write-tool-use':
    case 'update-plan-tool-use':
      return joinText(...(message.todos ?? []).map((todo) => `${todo.status} ${todo.content}`));
    case 'task-tool-use':
      return joinText(message.subagentType, message.description, message.prompt, message.model);
    case 'codex-subagent-tool-use':
      return joinText(message.action, boundedUnknownText(message.details));
    case 'write-stdin-tool-use':
      return boundedUnknownText(message.input, { remaining: MAX_TOOL_INPUT_CHARS, seen: new Set() });
    case 'exit-plan-mode-tool-use':
      return joinText(message.plan, ...(message.allowedPrompts ?? []).map((entry) => `${entry.tool} ${entry.prompt}`));
    case 'ask-user-question-tool-use':
      return joinText(message.title, boundedUnknownText(message.questions));
    case 'cursor-ask-question-tool-use':
      return joinText(message.title, boundedUnknownText(message.questions));
    case 'cursor-create-plan-tool-use':
      return joinText(message.name, message.overview, message.plan, boundedUnknownText(message.todos), boundedUnknownText(message.phases));
    case 'amp-oracle-tool-use':
      return joinText(message.task, message.context, ...(message.files ?? []));
    case 'amp-skill-tool-use':
      return message.name ?? '';
    case 'amp-handoff-tool-use':
      return message.goal ?? '';
    case 'amp-look-at-tool-use':
      return joinText(message.path, message.objective);
    case 'amp-read-thread-tool-use':
      return joinText(message.threadId, message.goal);
    case 'amp-task-list-tool-use':
      return joinText(message.action, message.taskId, message.title, message.status);
    case 'external-tool-use':
      return joinText(message.namespace ?? undefined, message.name, boundedUnknownText(message.input));
    case 'mcp-tool-use':
      return joinText(message.server, message.tool, boundedUnknownText(message.input));
    case 'request-permissions-tool-use':
      return joinText(message.reason, boundedUnknownText(message.permissions));
    case 'unknown-tool-use':
      return joinText(message.rawName, boundedUnknownText(message.input));
    case 'todo-read-tool-use':
    case 'enter-plan-mode-tool-use':
    case 'amp-mermaid-tool-use':
    case 'permission-resolved':
    case 'permission-cancelled':
      return '';
  }
}

function roleForMessage(message: ChatMessage): ChatSearchSnippetRole {
  if (message.type === 'user-message') return 'user';
  if (message.type === 'assistant-message' || message.type === 'thinking') return 'assistant';
  if (message.type.endsWith('-tool-use')
      || message.type === 'tool-result'
      || message.type === 'permission-request') return 'tool';
  return 'system';
}

export function projectSearchMessage(message: ChatMessage): SearchMessageRowInput | null {
  const body = messageText(message).replace(/\s+/g, ' ').trim().slice(0, MAX_BODY_CHARS);
  if (!body) return null;
  return {
    role: roleForMessage(message),
    timestamp: typeof message.timestamp === 'string' ? message.timestamp : null,
    body,
  };
}

export function projectSearchMessages(messages: ChatMessage[]): SearchMessageRowInput[] {
  return messages.flatMap((message) => {
    const row = projectSearchMessage(message);
    return row ? [row] : [];
  });
}

export function projectHistoricalSearchMessages(messages: ChatMessage[]): HistoricalSearchMessageRow[] {
  let ordinal = 0;
  return messages.flatMap((message) => {
    ordinal += 1;
    const row = projectSearchMessage(message);
    return row ? [{ ...row, messageOrdinal: ordinal }] : [];
  });
}
