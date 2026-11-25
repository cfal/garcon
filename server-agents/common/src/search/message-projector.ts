import type { ChatMessage } from '@garcon/common/chat-types';
import { isCleanCommandSuccess } from '@garcon/common/command-output';
import type { ChatSearchSnippetRole } from '@garcon/common/chat-search';
import type { SearchMessageRowInput } from './rows.js';
import { SEARCH_TIMESTAMP_MAX_BYTES } from './schema.js';

const MAX_BODY_CHARS = 64_000;
const MAX_TOOL_INPUT_CHARS = 16_000;
const MAX_TOOL_RESULT_HEAD_CHARS = 2_000;
const MAX_TOOL_RESULT_TAIL_CHARS = 512;
const MAX_TOOL_RESULT_CHARS = MAX_TOOL_RESULT_HEAD_CHARS + MAX_TOOL_RESULT_TAIL_CHARS;
const MAX_RECURSIVE_CHARS = 4_000;
const MAX_RECURSIVE_DEPTH = 8;
const MAX_RECURSIVE_NODES = 512;

interface ExtractionBudget {
  remaining: number;
  remainingNodes: number;
  seen: Set<object>;
  truncated: boolean;
}

interface PreferredFields { readonly [key: string]: PreferredFields | null }
const TOOL_RESULT_FIELDS: PreferredFields = { raw: null, rawOutput: { output: null } };

function assertNever(value: never): never {
  throw new Error(`Unhandled transcript search message type: ${String(value)}`);
}

function collapseSearchWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function searchablePrefix(text: string, budget: ExtractionBudget): string {
  // Only searchable text spends the preferred field's budget; never scan beyond the prefix.
  const prefix = text.slice(0, budget.remaining);
  budget.truncated ||= prefix.length < text.length;
  return collapseSearchWhitespace(prefix);
}

function appendText(parts: string[], value: unknown, budget: ExtractionBudget): void {
  if (typeof value !== 'string' || value.length === 0 || budget.remaining <= 0) return;
  if (parts.length > 0) {
    if (budget.remaining === 0) return;
    parts.push(' ');
    budget.remaining -= 1;
  }
  const selected = value.slice(0, budget.remaining);
  parts.push(selected);
  budget.remaining -= selected.length;
  if (selected.length < value.length) budget.truncated = true;
}

function joinBounded(limit: number, values: Iterable<unknown>, budget?: ExtractionBudget): string {
  const target = budget ?? {
    remaining: limit,
    remainingNodes: MAX_RECURSIVE_NODES,
    seen: new Set<object>(),
    truncated: false,
  };
  const parts: string[] = [];
  for (const value of values) {
    appendText(parts, value, target);
    if (target.remaining <= 0) break;
  }
  return parts.join('');
}

function boundedUnknownText(
  value: unknown,
  budget: ExtractionBudget = {
    remaining: MAX_RECURSIVE_CHARS,
    remainingNodes: MAX_RECURSIVE_NODES,
    seen: new Set(),
    truncated: false,
  },
  depth = 0,
  preferred?: PreferredFields | null,
): string {
  if (budget.remaining <= 0) return '';
  if (budget.remainingNodes <= 0) {
    budget.truncated = true;
    return '';
  }
  budget.remainingNodes -= 1;
  if (value == null) return '';
  if (depth > MAX_RECURSIVE_DEPTH) {
    budget.truncated = true;
    return '';
  }
  if (typeof value === 'string') {
    const selected = value.slice(0, budget.remaining);
    budget.remaining -= selected.length;
    if (selected.length < value.length) budget.truncated = true;
    return selected;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return boundedUnknownText(String(value), budget, depth);
  }
  if (typeof value !== 'object') return '';
  if (budget.seen.has(value)) return '';
  budget.seen.add(value);
  const parts: string[] = [];
  const appendChild = (key: string | null, childValue: unknown, childFields?: PreferredFields | null): void => {
    if (budget.remaining <= 0) return;
    if (parts.length > 0) {
      parts.push(' ');
      budget.remaining -= 1;
    }
    if (key) {
      const selectedKey = key.slice(0, budget.remaining);
      parts.push(selectedKey);
      budget.remaining -= selectedKey.length;
      if (selectedKey.length < key.length) budget.truncated = true;
      if (budget.remaining > 0) {
        parts.push(' ');
        budget.remaining -= 1;
      }
    }
    const child = boundedUnknownText(childValue, budget, depth + 1, childFields);
    if (child) parts.push(child);
  };
  if (Array.isArray(value)) {
    let index = 0;
    for (; index < value.length && budget.remaining > 0 && budget.remainingNodes > 0; index += 1) {
      appendChild(null, value[index]);
    }
    if (index < value.length) budget.truncated = true;
  } else {
    const record = value as Record<string, unknown>;
    if (preferred) {
      for (const [key, fields] of Object.entries(preferred)) {
        if (!Object.hasOwn(record, key)) continue;
        let child = record[key];
        if (typeof child === 'string') {
          child = searchablePrefix(child, budget);
          if (!child) continue;
        }
        appendChild(key, child, fields);
      }
    }
    for (const key in record) {
      if ((preferred && Object.hasOwn(preferred, key)) || !Object.hasOwn(record, key)) continue;
      appendChild(key, record[key]);
      if (budget.remaining <= 0 || budget.remainingNodes <= 0) {
        budget.truncated = true;
        break;
      }
    }
  }
  return parts.join('');
}

function boundedUnknownForJoin(value: unknown, outerBudget: ExtractionBudget): string {
  const nestedBudget: ExtractionBudget = {
    remaining: Math.min(MAX_RECURSIVE_CHARS, outerBudget.remaining),
    remainingNodes: Math.min(MAX_RECURSIVE_NODES, outerBudget.remainingNodes),
    seen: new Set(),
    truncated: false,
  };
  const initialNodes = nestedBudget.remainingNodes;
  const text = boundedUnknownText(value, nestedBudget);
  outerBudget.remainingNodes -= initialNodes - nestedBudget.remainingNodes;
  outerBudget.truncated ||= nestedBudget.truncated;
  return text;
}

function boundedToolResult(value: unknown, budget: ExtractionBudget): string {
  if (typeof value !== 'string') {
    const nestedBudget = { ...budget, remaining: MAX_TOOL_RESULT_CHARS };
    // Indexes the user-visible diagnostic before supplementary tool payloads.
    const text = boundedUnknownText(value, nestedBudget, 0, TOOL_RESULT_FIELDS);
    budget.remainingNodes = nestedBudget.remainingNodes;
    budget.truncated ||= nestedBudget.truncated;
    return text;
  }
  if (value.length <= MAX_TOOL_RESULT_CHARS) return value;
  budget.truncated = true;
  return `${value.slice(0, MAX_TOOL_RESULT_HEAD_CHARS)} ${value.slice(-MAX_TOOL_RESULT_TAIL_CHARS)}`;
}

function messageText(message: ChatMessage, budget: ExtractionBudget): string {
  const joinTool = (...values: unknown[]) => joinBounded(MAX_TOOL_INPUT_CHARS, values, budget);
  switch (message.type) {
    case 'user-message':
    case 'assistant-message':
    case 'command-output':
    case 'thinking':
      return joinBounded(MAX_BODY_CHARS, [message.content], budget);
    case 'command-result':
      return isCleanCommandSuccess(message.result) ? '' : joinBounded(MAX_BODY_CHARS, [message.content], budget);
    case 'error':
    case 'cli-row':
      return '';
    case 'compaction':
      return joinBounded(MAX_BODY_CHARS, [message.summary], budget);
    case 'agent-switch':
      return joinTool(message.fromAgentId, message.toAgentId, message.fromModel, message.toModel);
    case 'tool-result':
      return boundedToolResult(message.content, budget);
    case 'permission-request':
      return messageText(message.requestedTool, budget);
    case 'bash-tool-use':
      return joinTool(message.description, message.command);
    case 'claude-monitor-tool-use':
      return joinTool(
        message.description,
        message.command,
        message.webSocketUrl,
        boundedUnknownForJoin(message.webSocketProtocols, budget),
        boundedUnknownForJoin(message.allowedDomains, budget),
      );
    case 'exec-tool-use':
      return joinTool(message.language, message.code);
    case 'wait-tool-use':
      return joinTool(
        message.executionId,
        message.yieldTimeMs === undefined ? undefined : String(message.yieldTimeMs),
        message.maxTokens === undefined ? undefined : String(message.maxTokens),
        message.terminate === undefined ? undefined : String(message.terminate),
      );
    case 'read-tool-use':
    case 'write-tool-use':
      return joinTool(message.filePath, 'content' in message ? message.content : undefined);
    case 'list-tool-use':
      return joinTool(message.path);
    case 'edit-tool-use':
    case 'apply-patch-tool-use':
      return joinTool(
        message.filePath,
        message.oldString,
        message.newString,
        'patch' in message ? message.patch : undefined,
      );
    case 'grep-tool-use':
    case 'glob-tool-use':
      return joinTool(message.pattern, message.path);
    case 'web-search-tool-use':
    case 'pi-tool-search-tool-use':
    case 'claude-tool-search-tool-use':
    case 'amp-finder-tool-use':
    case 'amp-librarian-tool-use':
    case 'amp-find-thread-tool-use':
      return joinTool(message.query, 'context' in message ? message.context : undefined);
    case 'web-fetch-tool-use':
      return joinTool(message.url, message.prompt);
    case 'todo-write-tool-use':
    case 'update-plan-tool-use': {
      const values = function* () {
        for (const todo of message.todos ?? []) yield `${todo.status} ${todo.content}`;
      };
      return joinBounded(MAX_TOOL_INPUT_CHARS, values(), budget);
    }
    case 'task-tool-use':
      return joinTool(message.subagentType, message.description, message.prompt, message.model);
    case 'background-task-tool-use':
      return joinTool(message.action, message.taskId, message.input);
    case 'agent-message-tool-use':
      return joinTool(message.recipient, message.message);
    case 'codex-subagent-tool-use':
      return joinTool(message.action, boundedUnknownForJoin(message.details, budget));
    case 'write-stdin-tool-use':
      return boundedUnknownText(message.input, budget);
    case 'exit-plan-mode-tool-use': {
      const values = function* () {
        yield message.plan;
        for (const entry of message.allowedPrompts ?? []) yield `${entry.tool} ${entry.prompt}`;
      };
      return joinBounded(MAX_TOOL_INPUT_CHARS, values(), budget);
    }
    case 'ask-user-question-tool-use':
      return joinTool(message.title, boundedUnknownForJoin(message.questions, budget));
    case 'cursor-create-plan-tool-use':
      return joinTool(
        message.name,
        message.overview,
        message.plan,
        boundedUnknownForJoin(message.todos, budget),
        boundedUnknownForJoin(message.phases, budget),
      );
    case 'amp-oracle-tool-use': {
      const values = function* () {
        yield message.task;
        yield message.context;
        for (const file of message.files ?? []) yield file;
      };
      return joinBounded(MAX_TOOL_INPUT_CHARS, values(), budget);
    }
    case 'amp-skill-tool-use':
      return joinTool(message.name);
    case 'amp-handoff-tool-use':
      return joinTool(message.goal);
    case 'amp-look-at-tool-use':
      return joinTool(message.path, message.objective);
    case 'amp-read-thread-tool-use':
      return joinTool(message.threadId, message.goal);
    case 'amp-task-list-tool-use':
      return joinTool(message.action, message.taskId, message.title, message.status);
    case 'external-tool-use':
      return joinTool(message.namespace, message.name, boundedUnknownForJoin(message.input, budget));
    case 'mcp-tool-use':
      return joinTool(message.server, message.tool, boundedUnknownForJoin(message.input, budget));
    case 'request-permissions-tool-use':
      return joinTool(message.reason, boundedUnknownForJoin(message.permissions, budget));
    case 'unknown-tool-use':
      return joinTool(message.rawName, boundedUnknownForJoin(message.input, budget));
    case 'todo-read-tool-use':
    case 'enter-plan-mode-tool-use':
    case 'amp-mermaid-tool-use':
    case 'transcript-notice':
    case 'permission-resolved':
    case 'permission-cancelled':
    case 'permission-expired':
      return '';
  }
  return assertNever(message);
}

function roleForMessage(message: ChatMessage): ChatSearchSnippetRole {
  if (message.type === 'user-message') return 'user';
  if (message.type === 'assistant-message' || message.type === 'thinking') return 'assistant';
  if (message.type === 'command-output') return message.channel === 'stdout' ? 'assistant' : 'system';
  if (message.type.endsWith('-tool-use')
      || message.type === 'tool-result'
      || message.type === 'permission-request') return 'tool';
  return 'system';
}

function searchBodyLimit(type: ChatMessage['type']): number {
  if (type === 'tool-result') return MAX_TOOL_RESULT_CHARS;
  if (type.endsWith('-tool-use') || type === 'permission-request') return MAX_TOOL_INPUT_CHARS;
  return MAX_BODY_CHARS;
}

function projectOne(message: ChatMessage): {
  row: SearchMessageRowInput | null;
  truncated: boolean;
} {
  const budget: ExtractionBudget = {
    remaining: searchBodyLimit(message.type),
    remainingNodes: MAX_RECURSIVE_NODES,
    seen: new Set(),
    truncated: false,
  };
  const raw = messageText(message, budget);
  const body = collapseSearchWhitespace(raw);
  const timestamp = typeof message.timestamp === 'string'
    && Buffer.byteLength(message.timestamp, 'utf8') <= SEARCH_TIMESTAMP_MAX_BYTES
    ? message.timestamp
    : null;
  return {
    truncated: budget.truncated,
    row: body ? {
      role: roleForMessage(message),
      timestamp,
      body,
    } : null,
  };
}

export function projectSearchMessage(message: ChatMessage): SearchMessageRowInput | null {
  return projectOne(message).row;
}
