import type { ChatMessage } from "../../../../common/chat-types.js";
import type { CodexThreadItem } from './protocol.js';

export class CodexTurnMessageDeduper {
  #itemIds = new Set<string>();
  #renderedKeys = new Set<string>();

  recordItem(item: CodexThreadItem, messages: ChatMessage[]): void {
    this.#itemIds.add(item.id);
    this.recordMessages(messages);
  }

  recordMessages(messages: ChatMessage[]): void {
    for (const message of messages) this.recordMessage(message);
  }

  recordMessage(message: ChatMessage): void {
    for (const key of renderedMessageKeys(message)) this.#renderedKeys.add(key);
  }

  shouldEmitItem(item: CodexThreadItem, messages: ChatMessage[]): boolean {
    if (this.#itemIds.has(item.id)) return false;
    if (messages.length === 0) return false;
    return messages.some((message) => this.shouldEmitMessage(message));
  }

  shouldEmitMessage(message: ChatMessage): boolean {
    const keys = renderedMessageKeys(message);
    if (keys.length === 0) return true;
    return keys.every((key) => !this.#renderedKeys.has(key));
  }
}

function renderedMessageKeys(message: ChatMessage): string[] {
  const keys: string[] = [];
  if ('toolId' in message && typeof message.toolId === 'string' && message.toolId) {
    keys.push(`${message.type}:tool:${message.toolId}`);
  }

  if ('content' in message && typeof message.content === 'string') {
    const content = message.content.trim();
    if (content) keys.push(`${message.type}:text:${content}`);
  }

  const semanticKey = renderedSemanticKey(message);
  if (semanticKey) keys.push(semanticKey);

  return keys;
}

function renderedSemanticKey(message: ChatMessage): string | null {
  switch (message.type) {
    case 'bash-tool-use':
      return message.command.trim() ? `${message.type}:command:${message.command.trim()}` : null;
    case 'read-tool-use':
      return `${message.type}:read:${message.filePath}:${message.offset ?? ''}:${message.limit ?? ''}:${message.endLine ?? ''}`;
    case 'list-tool-use':
      return `${message.type}:list:${message.path ?? ''}`;
    case 'edit-tool-use':
      return `${message.type}:edit:${stableJson([message.filePath, message.oldString, message.newString, message.changes])}`;
    case 'write-tool-use':
      return `${message.type}:write:${stableJson([message.filePath, message.content])}`;
    case 'apply-patch-tool-use':
      return `${message.type}:patch:${stableJson([message.filePath, message.oldString, message.newString, message.patch])}`;
    case 'grep-tool-use':
      return `${message.type}:grep:${stableJson([message.pattern, message.path])}`;
    case 'glob-tool-use':
      return `${message.type}:glob:${stableJson([message.pattern, message.path])}`;
    case 'web-search-tool-use':
      return `${message.type}:query:${message.query.trim()}`;
    case 'web-fetch-tool-use':
      return `${message.type}:fetch:${stableJson([message.url, message.prompt])}`;
    case 'todo-write-tool-use':
      return `${message.type}:todos:${stableJson(message.todos)}`;
    case 'todo-read-tool-use':
      return message.type;
    case 'task-tool-use':
      return `${message.type}:task:${stableJson([message.subagentType, message.description, message.prompt, message.model, message.resume])}`;
    case 'update-plan-tool-use':
      return `${message.type}:plan:${stableJson(message.todos)}`;
    case 'write-stdin-tool-use':
      return `${message.type}:stdin:${stableJson(message.input)}`;
    case 'external-tool-use':
      return `${message.type}:external:${stableJson([message.namespace, message.name, message.input])}`;
    case 'mcp-tool-use':
      return `${message.type}:mcp:${stableJson([message.server, message.tool, message.input])}`;
    case 'unknown-tool-use':
      return `${message.type}:unknown:${stableJson([message.rawName, message.input])}`;
    case 'tool-result':
      return `${message.type}:result:${stableJson([message.content, message.isError])}`;
    default:
      return null;
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return nested;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(nested).sort()) sorted[key] = nested[key];
    return sorted;
  }) ?? 'undefined';
}
