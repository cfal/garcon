import {
  CODEX_SUBAGENT_ACTIONS, CODEX_SUBAGENT_STATUSES, CODEX_SUBAGENT_LIFECYCLE_SOURCES,
  isToolUseMessage, parseChatMessage, parseUserMessagePresentation,
} from '@garcon/common/chat-types';
import type * as Chat from '@garcon/common/chat-types';
import { isCliPresentation, isCliRowFormat, isCliBodyDisclosure } from '@garcon/common/cli-presentation';
import { isRecord } from '@garcon/common/json';
import { parseTranscriptNoticeDetail } from '@garcon/common/transcript-notice-details';
import { isPermissionOccurrenceId } from '@garcon/common/permission-occurrence';

type Validator = (value: unknown) => boolean;
type Fields<T> = { readonly [K in keyof T]-?: Validator };
type Shape = Readonly<Record<string, Validator>>;
const string: Validator = (value) => typeof value === 'string';
const number: Validator = (value) => typeof value === 'number' && Number.isFinite(value);
const boolean: Validator = (value) => typeof value === 'boolean';
const optional = (validate: Validator): Validator => (value) => value === undefined || validate(value);
const array = (validate: Validator): Validator => (value) => Array.isArray(value) && value.every(validate);
const oneOf = (choices: readonly unknown[]): Validator => (value) => choices.includes(value);
const object = (shape: Shape): Validator => (value) => isRecord(value)
  && Object.keys(value).every((key) => Object.hasOwn(shape, key))
  && Object.entries(shape).every(([key, validate]) => validate(value[key]));
const dictionary = (validate: Validator): Validator => (value) => isRecord(value) && Object.values(value).every(validate);

const metadata = object({
  clientRequestId: optional(string), clientMessageId: optional(string), upstreamRequestId: optional(string), turnId: optional(string),
} satisfies Fields<Chat.ChatMessageMetadata>);
const image = object({ data: string, name: string, mimeType: optional(string) } satisfies Fields<Chat.ChatImage>);
const todo = object({ content: string, status: oneOf(['pending', 'in_progress', 'completed']) } satisfies Fields<Chat.TodoItem>);
const cursorTodo = object({
  id: optional(string), content: string, status: oneOf(['pending', 'in_progress', 'completed', 'cancelled']),
} satisfies Fields<Chat.CursorPlanTodo>);
const cursorPhase = object({ name: string, todos: array(cursorTodo) } satisfies Fields<Chat.CursorPlanPhase>);
const questionOption = object({
  id: string, label: string, description: optional(string), preview: optional(string),
} satisfies Fields<Chat.AskUserQuestionOption>);
const question = object({
  id: string, prompt: string, options: array(questionOption), header: optional(string), allowMultiple: optional(boolean),
} satisfies Fields<Chat.AskUserQuestionPrompt>);
const cursorQuestionOption = object({ id: string, label: string } satisfies Fields<Chat.CursorAskQuestionOption>);
const cursorQuestion = object({
  id: string, prompt: string, options: array(cursorQuestionOption), allowMultiple: optional(boolean),
} satisfies Fields<Chat.CursorAskQuestionPrompt>);
const subagentInput = object({
  type: optional(string), text: optional(string), imageUrl: optional(string), path: optional(string), name: optional(string),
} satisfies Fields<Chat.CodexSubagentInputItem>);
const subagentStatus = object({ status: oneOf(CODEX_SUBAGENT_STATUSES), message: optional(string) } satisfies Fields<Chat.CodexSubagentState>);
const subagentDetails = object({
  target: optional(string), threadId: optional(string), targets: optional(array(string)), message: optional(string),
  taskName: optional(string), agentType: optional(string), model: optional(string), reasoningEffort: optional(string),
  serviceTier: optional(string), forkContext: optional(boolean), forkTurns: optional(string), timeoutMs: optional(number),
  pathPrefix: optional(string), interrupt: optional(boolean), items: optional(array(subagentInput)),
  agentStates: optional(dictionary(subagentStatus)), lifecycleSource: optional(oneOf(CODEX_SUBAGENT_LIFECYCLE_SOURCES)),
  sourceFingerprint: optional(string),
} satisfies Fields<Chat.CodexSubagentDetails>);

const messageFields = {
  'user-message': { content: string, images: optional(array(image)), metadata: optional(metadata),
    presentation: optional((value) => parseUserMessagePresentation(value) !== undefined) },
  'assistant-message': { content: string },
  thinking: { content: string },
  'bash-tool-use': { toolId: string, command: string, description: optional(string) },
  'exec-tool-use': { toolId: string, code: string, language: string },
  'wait-tool-use': { toolId: string, executionId: string, yieldTimeMs: optional(number), maxTokens: optional(number), terminate: optional(boolean) },
  'read-tool-use': { toolId: string, filePath: string, offset: optional(number), limit: optional(number), endLine: optional(number) },
  'list-tool-use': { toolId: string, path: optional(string) },
  'edit-tool-use': { toolId: string, filePath: optional(string), oldString: optional(string), newString: optional(string),
    changes: optional(array(object({ path: optional(string), kind: optional(string) }))) },
  'write-tool-use': { toolId: string, filePath: string, content: optional(string) },
  'apply-patch-tool-use': { toolId: string, filePath: optional(string), oldString: optional(string), newString: optional(string), patch: optional(string) },
  'grep-tool-use': { toolId: string, pattern: optional(string), path: optional(string) },
  'glob-tool-use': { toolId: string, pattern: optional(string), path: optional(string) },
  'web-search-tool-use': { toolId: string, query: string },
  'web-fetch-tool-use': { toolId: string, url: string, prompt: optional(string) },
  'todo-write-tool-use': { toolId: string, todos: optional(array(todo)) },
  'todo-read-tool-use': { toolId: string },
  'task-tool-use': { toolId: string, subagentType: optional(string), description: optional(string), prompt: optional(string), model: optional(string), resume: optional(string) },
  'codex-subagent-tool-use': { toolId: string, action: oneOf(CODEX_SUBAGENT_ACTIONS), details: subagentDetails },
  'update-plan-tool-use': { toolId: string, todos: optional(array(todo)) },
  'write-stdin-tool-use': { toolId: string, input: isRecord },
  'enter-plan-mode-tool-use': { toolId: string },
  'exit-plan-mode-tool-use': { toolId: string, plan: string, allowedPrompts: optional(array(object({ tool: string, prompt: string }))) },
  'ask-user-question-tool-use': { toolId: string, title: optional(string), questions: array(question) },
  'cursor-ask-question-tool-use': { toolId: string, title: optional(string), questions: array(cursorQuestion) },
  'cursor-create-plan-tool-use': { toolId: string, plan: string, name: optional(string), overview: optional(string),
    todos: optional(array(cursorTodo)), isProject: optional(boolean), phases: optional(array(cursorPhase)) },
  'amp-finder-tool-use': { toolId: string, query: optional(string) },
  'amp-oracle-tool-use': { toolId: string, task: optional(string), context: optional(string), files: optional(array(string)) },
  'amp-librarian-tool-use': { toolId: string, query: optional(string), context: optional(string) },
  'amp-skill-tool-use': { toolId: string, name: optional(string) },
  'amp-mermaid-tool-use': { toolId: string },
  'amp-handoff-tool-use': { toolId: string, goal: optional(string) },
  'amp-look-at-tool-use': { toolId: string, path: optional(string), objective: optional(string) },
  'amp-find-thread-tool-use': { toolId: string, query: optional(string) },
  'amp-read-thread-tool-use': { toolId: string, threadId: optional(string), goal: optional(string) },
  'amp-task-list-tool-use': { toolId: string, action: optional(string), taskId: optional(string), title: optional(string), status: optional(string) },
  'external-tool-use': { toolId: string, name: string, input: isRecord, namespace: optional((value) => value === null || string(value)) },
  'mcp-tool-use': { toolId: string, server: string, tool: string, input: isRecord },
  'request-permissions-tool-use': { toolId: string, permissions: isRecord, reason: optional(string) },
  'unknown-tool-use': { toolId: string, rawName: string, input: isRecord },
  'tool-result': { toolId: string, content: isRecord, isError: boolean },
  error: { content: string },
  'transcript-notice': { content: string, detail: optional((value) => parseTranscriptNoticeDetail(value) !== null), title: optional(string) },
  'cli-row': { content: string, presentation: isCliPresentation, format: isCliRowFormat, title: optional(string), disclosure: isCliBodyDisclosure },
  'permission-request': { permissionOccurrenceId: isPermissionOccurrenceId, requestedTool: (value) => {
    const message = parseOwnedNodeMessage(value);
    return message !== null && isToolUseMessage(message);
  } },
  'permission-resolved': { permissionOccurrenceId: isPermissionOccurrenceId, allowed: boolean },
  'permission-cancelled': { permissionOccurrenceId: isPermissionOccurrenceId, reason: optional(oneOf(['cancelled', 'session-complete', 'aborted'])) },
  'permission-expired': { permissionOccurrenceId: isPermissionOccurrenceId },
  compaction: { trigger: oneOf(['manual', 'auto']), summary: string, preTokens: optional(number), postTokens: optional(number) },
  'agent-switch': { fromAgentId: string, toAgentId: string, fromModel: optional(string), toModel: optional(string) },
} satisfies { [K in Chat.ChatMessage['type']]: Fields<Omit<Extract<Chat.ChatMessage, { type: K }>, 'type' | 'timestamp'>> };

/** Validates owned wire data before invoking the permissive historical message parser. */
export function parseOwnedNodeMessage(value: unknown): Chat.ChatMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string' || typeof value.timestamp !== 'string'
    || !Object.hasOwn(messageFields, value.type)) return null;
  const shape: Shape = messageFields[value.type as Chat.ChatMessage['type']];
  if (!Object.keys(value).every((key) => key === 'type' || key === 'timestamp' || Object.hasOwn(shape, key))) return null;
  try {
    if (!Object.entries(shape).every(([key, validate]) => validate(value[key]))) return null;
    return parseChatMessage(value);
  } catch {
    return null;
  }
}
