// Discriminated union of all chat message types. Shared between server
// and frontend -- the server converts provider-specific formats into
// these shapes, and the frontend renders them directly.

export interface ChatImage {
  data: string;
  name: string;
  mimeType?: string;
}

export type UserMessageDeliveryStatus = 'submitting' | 'accepted' | 'failed';

export interface ChatMessageMetadata {
  clientRequestId?: string;
  upstreamRequestId?: string;
  turnId?: string;
  deliveryStatus?: UserMessageDeliveryStatus;
}

// Canonical shape for a single todo/plan item. All provider-specific
// formats are normalized to this at the converter boundary.
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

// Lightweight coercion for already-serialized TodoItem arrays.
// Agent-specific normalization lives in server/agents/shared/normalize-util.
export function coerceTodoItems(raw: unknown): TodoItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items: TodoItem[] = [];
  for (const entry of raw) {
    if (entry == null || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const content = obj.content ?? obj.text ?? obj.step;
    if (typeof content !== 'string') continue;
    const s = obj.status;
    const completed = obj.completed;
    const status: TodoStatus =
      completed === true || s === 'completed' || s === 'done' ? 'completed' :
      s === 'in_progress' || s === 'in-progress' ? 'in_progress' : 'pending';
    items.push({ content, status });
  }
  return items.length > 0 ? items : undefined;
}

export class UserMessage {
  readonly type = 'user-message' as const;
  constructor(
    public timestamp: string,
    public content: string,
    public images?: ChatImage[],
    public metadata?: ChatMessageMetadata,
  ) {}
}

export class AssistantMessage {
  readonly type = 'assistant-message' as const;
  constructor(public timestamp: string, public content: string) {}
}

export class ThinkingMessage {
  readonly type = 'thinking' as const;
  constructor(public timestamp: string, public content: string) {}
}

export class BashToolUseMessage {
  readonly type = 'bash-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public command: string,
    public description?: string,
  ) {}
}

export class ExecToolUseMessage {
  readonly type = 'exec-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public code: string,
    public language: string,
  ) {}
}

export class ReadToolUseMessage {
  readonly type = 'read-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public filePath: string,
    public offset?: number,
    public limit?: number,
    public endLine?: number,
  ) {}
}

export class ListToolUseMessage {
  readonly type = 'list-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public path?: string,
  ) {}
}

export class EditToolUseMessage {
  readonly type = 'edit-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public filePath?: string,
    public oldString?: string,
    public newString?: string,
    public changes?: Array<{ path?: string; kind?: string }>,
  ) {}
}

export class WriteToolUseMessage {
  readonly type = 'write-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public filePath: string,
    public content?: string,
  ) {}
}

export class ApplyPatchToolUseMessage {
  readonly type = 'apply-patch-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public filePath?: string,
    public oldString?: string,
    public newString?: string,
    public patch?: string,
  ) {}
}

export class GrepToolUseMessage {
  readonly type = 'grep-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public pattern?: string,
    public path?: string,
  ) {}
}

export class GlobToolUseMessage {
  readonly type = 'glob-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public pattern?: string,
    public path?: string,
  ) {}
}

export class WebSearchToolUseMessage {
  readonly type = 'web-search-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public query: string,
  ) {}
}

export class WebFetchToolUseMessage {
  readonly type = 'web-fetch-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public url: string,
    public prompt?: string,
  ) {}
}

export class TodoWriteToolUseMessage {
  readonly type = 'todo-write-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public todos?: TodoItem[],
  ) {}
}

export class TodoReadToolUseMessage {
  readonly type = 'todo-read-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
  ) {}
}

export class TaskToolUseMessage {
  readonly type = 'task-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public subagentType?: string,
    public description?: string,
    public prompt?: string,
    public model?: string,
    public resume?: string,
  ) {}
}

export const CODEX_SUBAGENT_ACTIONS = [
  'spawn_agent',
  'send_input',
  'send_message',
  'followup_task',
  'wait_agent',
  'interrupt_agent',
  'list_agents',
  'close_agent',
  'resume_agent',
] as const;

export type CodexSubagentAction = (typeof CODEX_SUBAGENT_ACTIONS)[number];

export interface CodexSubagentInputItem {
  type?: string;
  text?: string;
  imageUrl?: string;
  path?: string;
  name?: string;
}

export interface CodexSubagentDetails {
  target?: string;
  targets?: string[];
  message?: string;
  taskName?: string;
  agentType?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  forkContext?: boolean;
  forkTurns?: string;
  timeoutMs?: number;
  pathPrefix?: string;
  interrupt?: boolean;
  items?: CodexSubagentInputItem[];
}

export class CodexSubagentToolUseMessage {
  readonly type = 'codex-subagent-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public action: CodexSubagentAction,
    public details: CodexSubagentDetails = {},
  ) {}
}

export class UpdatePlanToolUseMessage {
  readonly type = 'update-plan-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public todos?: TodoItem[],
  ) {}
}

export class WriteStdinToolUseMessage {
  readonly type = 'write-stdin-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public input: Record<string, unknown>,
  ) {}
}

export class EnterPlanModeToolUseMessage {
  readonly type = 'enter-plan-mode-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
  ) {}
}

export class ExitPlanModeToolUseMessage {
  readonly type = 'exit-plan-mode-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public plan: string,
    public allowedPrompts?: Array<{ tool: string; prompt: string }>,
  ) {}
}

export interface AskUserQuestionOption {
  id: string;
  label: string;
  description?: string;
  preview?: string;
}

export interface AskUserQuestionPrompt {
  id: string;
  prompt: string;
  options: AskUserQuestionOption[];
  header?: string;
  allowMultiple?: boolean;
}

export class AskUserQuestionToolUseMessage {
  readonly type = 'ask-user-question-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public title: string | undefined,
    public questions: AskUserQuestionPrompt[],
  ) {}
}

export interface CursorAskQuestionOption {
  id: string;
  label: string;
}

export interface CursorAskQuestionPrompt {
  id: string;
  prompt: string;
  options: CursorAskQuestionOption[];
  allowMultiple?: boolean;
}

export class CursorAskQuestionToolUseMessage {
  readonly type = 'cursor-ask-question-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public title: string | undefined,
    public questions: CursorAskQuestionPrompt[],
  ) {}
}

export type CursorPlanTodoStatus = TodoStatus | 'cancelled';

export interface CursorPlanTodo {
  id?: string;
  content: string;
  status: CursorPlanTodoStatus;
}

export interface CursorPlanPhase {
  name: string;
  todos: CursorPlanTodo[];
}

export class CursorCreatePlanToolUseMessage {
  readonly type = 'cursor-create-plan-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public plan: string,
    public name?: string,
    public overview?: string,
    public todos?: CursorPlanTodo[],
    public isProject?: boolean,
    public phases?: CursorPlanPhase[],
  ) {}
}

export class AmpFinderToolUseMessage {
  readonly type = 'amp-finder-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public query?: string,
  ) {}
}

export class AmpOracleToolUseMessage {
  readonly type = 'amp-oracle-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public task?: string,
    public context?: string,
    public files?: string[],
  ) {}
}

export class AmpLibrarianToolUseMessage {
  readonly type = 'amp-librarian-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public query?: string,
    public context?: string,
  ) {}
}

export class AmpSkillToolUseMessage {
  readonly type = 'amp-skill-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public name?: string,
  ) {}
}

export class AmpMermaidToolUseMessage {
  readonly type = 'amp-mermaid-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
  ) {}
}

export class AmpHandoffToolUseMessage {
  readonly type = 'amp-handoff-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public goal?: string,
  ) {}
}

export class AmpLookAtToolUseMessage {
  readonly type = 'amp-look-at-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public path?: string,
    public objective?: string,
  ) {}
}

export class AmpFindThreadToolUseMessage {
  readonly type = 'amp-find-thread-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public query?: string,
  ) {}
}

export class AmpReadThreadToolUseMessage {
  readonly type = 'amp-read-thread-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public threadId?: string,
    public goal?: string,
  ) {}
}

export class AmpTaskListToolUseMessage {
  readonly type = 'amp-task-list-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public action?: string,
    public taskId?: string,
    public title?: string,
    public status?: string,
  ) {}
}

export class ExternalToolUseMessage {
  readonly type = 'external-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public name: string,
    public input: Record<string, unknown>,
    public namespace?: string | null,
  ) {}
}

export class McpToolUseMessage {
  readonly type = 'mcp-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public server: string,
    public tool: string,
    public input: Record<string, unknown>,
  ) {}
}

export class RequestPermissionsToolUseMessage {
  readonly type = 'request-permissions-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public permissions: Record<string, unknown>,
    public reason?: string,
  ) {}
}

export class UnknownToolUseMessage {
  readonly type = 'unknown-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public rawName: string,
    public input: Record<string, unknown>,
  ) {}
}

export class ToolResultMessage {
  readonly type = 'tool-result' as const;
  constructor(public timestamp: string, public toolId: string, public content: Record<string, unknown>, public isError: boolean) {}
}

export class ErrorMessage {
  readonly type = 'error' as const;
  constructor(public timestamp: string, public content: string) {}
}

export class PermissionRequestMessage {
  readonly type = 'permission-request' as const;
  constructor(public timestamp: string, public permissionRequestId: string, public requestedTool: ToolUseChatMessage) {}
}

export class PermissionResolvedMessage {
  readonly type = 'permission-resolved' as const;
  constructor(public timestamp: string, public permissionRequestId: string, public allowed: boolean) {}
}

export class PermissionCancelledMessage {
  readonly type = 'permission-cancelled' as const;
  constructor(public timestamp: string, public permissionRequestId: string, public reason?: 'cancelled' | 'session-complete' | 'aborted') {}
}

// What initiated a context compaction: an explicit `/compact` command or an
// automatic compaction triggered when the context window filled up.
export type CompactionTrigger = 'manual' | 'auto';

// Marks a context-compaction boundary in the conversation. The agent replaced
// the earlier history with `summary` to free up context. Token counts, when the
// provider reports them, describe the window before and after compaction.
export class CompactionMessage {
  readonly type = 'compaction' as const;
  constructor(
    public timestamp: string,
    public trigger: CompactionTrigger,
    public summary: string,
    public preTokens?: number,
    public postTokens?: number,
  ) {}
}

// Marks a cross-agent continuation boundary in the conversation. Messages
// before this point were produced by `fromAgentId`; the chat continues under
// `toAgentId` with a fresh seeded session, so prior tool state is not carried
// over. Generic across agents: identifies both sides by agent id and model.
export class AgentSwitchMessage {
  readonly type = 'agent-switch' as const;
  constructor(
    public timestamp: string,
    public fromAgentId: string,
    public toAgentId: string,
    public fromModel?: string,
    public toModel?: string,
  ) {}
}

// Union of all explicit tool-use message classes.
export type ToolUseChatMessage =
  | BashToolUseMessage
  | ExecToolUseMessage
  | ReadToolUseMessage
  | ListToolUseMessage
  | EditToolUseMessage
  | WriteToolUseMessage
  | ApplyPatchToolUseMessage
  | GrepToolUseMessage
  | GlobToolUseMessage
  | WebSearchToolUseMessage
  | WebFetchToolUseMessage
  | TodoWriteToolUseMessage
  | TodoReadToolUseMessage
  | TaskToolUseMessage
  | CodexSubagentToolUseMessage
  | UpdatePlanToolUseMessage
  | WriteStdinToolUseMessage
  | EnterPlanModeToolUseMessage
  | ExitPlanModeToolUseMessage
  | AskUserQuestionToolUseMessage
  | CursorAskQuestionToolUseMessage
  | CursorCreatePlanToolUseMessage
  | AmpFinderToolUseMessage
  | AmpOracleToolUseMessage
  | AmpLibrarianToolUseMessage
  | AmpSkillToolUseMessage
  | AmpMermaidToolUseMessage
  | AmpHandoffToolUseMessage
  | AmpLookAtToolUseMessage
  | AmpFindThreadToolUseMessage
  | AmpReadThreadToolUseMessage
  | AmpTaskListToolUseMessage
  | ExternalToolUseMessage
  | McpToolUseMessage
  | RequestPermissionsToolUseMessage
  | UnknownToolUseMessage;

export type ChatMessage =
  | UserMessage
  | AssistantMessage
  | ThinkingMessage
  | ToolUseChatMessage
  | ToolResultMessage
  | ErrorMessage
  | PermissionRequestMessage
  | PermissionResolvedMessage
  | PermissionCancelledMessage
  | CompactionMessage
  | AgentSwitchMessage;

// Narrows an unknown value to string, defaulting to ''.
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asOptionalString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asOptionalNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

function parseChatMessageMetadata(v: unknown): ChatMessageMetadata | undefined {
  const raw = asRecord(v);
  const metadata: ChatMessageMetadata = {};
  if (typeof raw.clientRequestId === 'string') metadata.clientRequestId = raw.clientRequestId;
  if (typeof raw.upstreamRequestId === 'string') metadata.upstreamRequestId = raw.upstreamRequestId;
  if (typeof raw.turnId === 'string') metadata.turnId = raw.turnId;
  if (
    raw.deliveryStatus === 'submitting' ||
    raw.deliveryStatus === 'accepted' ||
    raw.deliveryStatus === 'failed'
  ) {
    metadata.deliveryStatus = raw.deliveryStatus;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const items = v.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return items.length > 0 ? items : undefined;
}

function asChatImages(v: unknown): ChatImage[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const images: ChatImage[] = [];
  for (const entry of v) {
    const raw = asRecord(entry);
    if (typeof raw.data !== 'string' || typeof raw.name !== 'string') continue;
    images.push({
      data: raw.data,
      name: raw.name,
      ...(typeof raw.mimeType === 'string' && raw.mimeType ? { mimeType: raw.mimeType } : {}),
    });
  }
  if (images.length > 0 || v.length === 0) return images;
  return undefined;
}

function asAllowedPrompts(v: unknown): Array<{ tool: string; prompt: string }> | undefined {
  if (!Array.isArray(v)) return undefined;
  const prompts: Array<{ tool: string; prompt: string }> = [];
  for (const entry of v) {
    const raw = asRecord(entry);
    if (typeof raw.tool !== 'string' || typeof raw.prompt !== 'string') continue;
    prompts.push({ tool: raw.tool, prompt: raw.prompt });
  }
  if (prompts.length > 0 || v.length === 0) return prompts;
  return undefined;
}

function asOptionalBoolean(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function asAskUserQuestionOptions(v: unknown): AskUserQuestionOption[] {
  if (!Array.isArray(v)) return [];
  const options: AskUserQuestionOption[] = [];
  for (const entry of v) {
    const raw = asRecord(entry);
    if (typeof raw.id !== 'string' || typeof raw.label !== 'string') continue;
    const option: AskUserQuestionOption = { id: raw.id, label: raw.label };
    if (typeof raw.description === 'string') option.description = raw.description;
    if (typeof raw.preview === 'string') option.preview = raw.preview;
    options.push(option);
  }
  return options;
}

function asAskUserQuestions(v: unknown): AskUserQuestionPrompt[] {
  if (!Array.isArray(v)) return [];
  const questions: AskUserQuestionPrompt[] = [];
  for (const entry of v) {
    const raw = asRecord(entry);
    if (typeof raw.id !== 'string' || typeof raw.prompt !== 'string') continue;
    const question: AskUserQuestionPrompt = {
      id: raw.id,
      prompt: raw.prompt,
      options: asAskUserQuestionOptions(raw.options),
    };
    if (typeof raw.header === 'string') question.header = raw.header;
    question.allowMultiple = asOptionalBoolean(raw.allowMultiple);
    questions.push(question);
  }
  return questions;
}

function asCursorAskQuestionOptions(v: unknown): CursorAskQuestionOption[] {
  if (!Array.isArray(v)) return [];
  const options: CursorAskQuestionOption[] = [];
  for (const entry of v) {
    const raw = asRecord(entry);
    if (typeof raw.id !== 'string' || typeof raw.label !== 'string') continue;
    options.push({ id: raw.id, label: raw.label });
  }
  return options;
}

function asCursorAskQuestions(v: unknown): CursorAskQuestionPrompt[] {
  if (!Array.isArray(v)) return [];
  const questions: CursorAskQuestionPrompt[] = [];
  for (const entry of v) {
    const raw = asRecord(entry);
    if (typeof raw.id !== 'string' || typeof raw.prompt !== 'string') continue;
    questions.push({
      id: raw.id,
      prompt: raw.prompt,
      options: asCursorAskQuestionOptions(raw.options),
      allowMultiple: asOptionalBoolean(raw.allowMultiple),
    });
  }
  return questions;
}

function asCursorPlanTodoStatus(v: unknown): CursorPlanTodoStatus {
  return v === 'completed'
    || v === 'in_progress'
    || v === 'cancelled'
    ? v
    : 'pending';
}

function asCursorPlanTodos(v: unknown): CursorPlanTodo[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const todos: CursorPlanTodo[] = [];
  for (const entry of v) {
    const raw = asRecord(entry);
    if (typeof raw.content !== 'string') continue;
    const todo: CursorPlanTodo = {
      content: raw.content,
      status: asCursorPlanTodoStatus(raw.status),
    };
    if (typeof raw.id === 'string') todo.id = raw.id;
    todos.push(todo);
  }
  if (todos.length > 0 || v.length === 0) return todos;
  return undefined;
}

function asCursorPlanPhases(v: unknown): CursorPlanPhase[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const phases: CursorPlanPhase[] = [];
  for (const entry of v) {
    const raw = asRecord(entry);
    if (typeof raw.name !== 'string') continue;
    phases.push({
      name: raw.name,
      todos: asCursorPlanTodos(raw.todos) ?? [],
    });
  }
  if (phases.length > 0 || v.length === 0) return phases;
  return undefined;
}

function asOptionalChanges(v: unknown): Array<{ path?: string; kind?: string }> | undefined {
  if (!Array.isArray(v)) return undefined;
  const changes: Array<{ path?: string; kind?: string }> = [];
  for (const entry of v) {
    const raw = asRecord(entry);
    const change: { path?: string; kind?: string } = {};
    if (typeof raw.path === 'string') change.path = raw.path;
    if (typeof raw.kind === 'string') change.kind = raw.kind;
    if (change.path !== undefined || change.kind !== undefined) changes.push(change);
  }
  if (changes.length > 0 || v.length === 0) return changes;
  return undefined;
}

const CODEX_SUBAGENT_ACTION_SET = new Set<string>(CODEX_SUBAGENT_ACTIONS);

function asCodexSubagentAction(v: unknown): CodexSubagentAction | undefined {
  return typeof v === 'string' && CODEX_SUBAGENT_ACTION_SET.has(v)
    ? v as CodexSubagentAction
    : undefined;
}

function asCodexSubagentInputItems(v: unknown): CodexSubagentInputItem[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const items: CodexSubagentInputItem[] = [];
  for (const entry of v) {
    const raw = asRecord(entry);
    const item: CodexSubagentInputItem = {};
    if (typeof raw.type === 'string') item.type = raw.type;
    if (typeof raw.text === 'string') item.text = raw.text;
    if (typeof raw.imageUrl === 'string') item.imageUrl = raw.imageUrl;
    if (typeof raw.path === 'string') item.path = raw.path;
    if (typeof raw.name === 'string') item.name = raw.name;
    if (Object.keys(item).length > 0) items.push(item);
  }
  return items.length > 0 || v.length === 0 ? items : undefined;
}

function asCodexSubagentDetails(v: unknown): CodexSubagentDetails {
  const raw = asRecord(v);
  const details: CodexSubagentDetails = {};
  if (typeof raw.target === 'string') details.target = raw.target;
  const targets = asStringArray(raw.targets);
  if (targets !== undefined) details.targets = targets;
  if (typeof raw.message === 'string') details.message = raw.message;
  if (typeof raw.taskName === 'string') details.taskName = raw.taskName;
  if (typeof raw.agentType === 'string') details.agentType = raw.agentType;
  if (typeof raw.model === 'string') details.model = raw.model;
  if (typeof raw.reasoningEffort === 'string') details.reasoningEffort = raw.reasoningEffort;
  if (typeof raw.serviceTier === 'string') details.serviceTier = raw.serviceTier;
  if (typeof raw.forkContext === 'boolean') details.forkContext = raw.forkContext;
  if (typeof raw.forkTurns === 'string') details.forkTurns = raw.forkTurns;
  const timeoutMs = asOptionalNumber(raw.timeoutMs);
  if (timeoutMs !== undefined) details.timeoutMs = timeoutMs;
  if (typeof raw.pathPrefix === 'string') details.pathPrefix = raw.pathPrefix;
  if (typeof raw.interrupt === 'boolean') details.interrupt = raw.interrupt;
  const items = asCodexSubagentInputItems(raw.items);
  if (items !== undefined) details.items = items;
  return details;
}

type ToolUseMessageType = ToolUseChatMessage['type'];
type ToolUseMessageParser = (data: Record<string, unknown>) => ToolUseChatMessage | null;

const TOOL_USE_MESSAGE_PARSERS = {
  'bash-tool-use': (data) => {
    const command = asOptionalString(data.command);
    if (command === undefined) return null;
    return new BashToolUseMessage(
      str(data.timestamp), str(data.toolId),
      command, asOptionalString(data.description));
  },

  'exec-tool-use': (data) => {
    const code = asOptionalString(data.code);
    const language = asOptionalString(data.language);
    if (code === undefined || language === undefined) return null;
    return new ExecToolUseMessage(
      str(data.timestamp), str(data.toolId),
      code, language);
  },

  'read-tool-use': (data) => {
    const filePath = asOptionalString(data.filePath);
    if (filePath === undefined) return null;
    return new ReadToolUseMessage(
      str(data.timestamp), str(data.toolId),
      filePath,
      asOptionalNumber(data.offset), asOptionalNumber(data.limit),
      asOptionalNumber(data.endLine));
  },

  'list-tool-use': (data) =>
    new ListToolUseMessage(
      str(data.timestamp), str(data.toolId),
      asOptionalString(data.path)),

  'edit-tool-use': (data) =>
    new EditToolUseMessage(
      str(data.timestamp), str(data.toolId),
      asOptionalString(data.filePath),
      asOptionalString(data.oldString),
      asOptionalString(data.newString),
      asOptionalChanges(data.changes)),

  'write-tool-use': (data) => {
    const filePath = asOptionalString(data.filePath);
    if (filePath === undefined) return null;
    return new WriteToolUseMessage(
      str(data.timestamp), str(data.toolId),
      filePath, asOptionalString(data.content));
  },

  'apply-patch-tool-use': (data) =>
    new ApplyPatchToolUseMessage(
      str(data.timestamp), str(data.toolId),
      asOptionalString(data.filePath),
      asOptionalString(data.oldString),
      asOptionalString(data.newString),
      asOptionalString(data.patch)),

  'grep-tool-use': (data) =>
    new GrepToolUseMessage(
      str(data.timestamp), str(data.toolId),
      asOptionalString(data.pattern), asOptionalString(data.path)),

  'glob-tool-use': (data) =>
    new GlobToolUseMessage(
      str(data.timestamp), str(data.toolId),
      asOptionalString(data.pattern), asOptionalString(data.path)),

  'web-search-tool-use': (data) => {
    const query = asOptionalString(data.query);
    if (query === undefined) return null;
    return new WebSearchToolUseMessage(
      str(data.timestamp), str(data.toolId), query);
  },

  'web-fetch-tool-use': (data) => {
    const url = asOptionalString(data.url);
    if (url === undefined) return null;
    return new WebFetchToolUseMessage(
      str(data.timestamp), str(data.toolId),
      url, asOptionalString(data.prompt));
  },

  'todo-write-tool-use': (data) =>
    new TodoWriteToolUseMessage(
      str(data.timestamp), str(data.toolId),
      coerceTodoItems(data.todos)),

  'todo-read-tool-use': (data) =>
    new TodoReadToolUseMessage(str(data.timestamp), str(data.toolId)),

  'task-tool-use': (data) =>
    new TaskToolUseMessage(
      str(data.timestamp), str(data.toolId),
      asOptionalString(data.subagentType),
      asOptionalString(data.description),
      asOptionalString(data.prompt),
      asOptionalString(data.model),
      asOptionalString(data.resume)),

  'codex-subagent-tool-use': (data) => {
    const action = asCodexSubagentAction(data.action);
    if (action === undefined) return null;
    return new CodexSubagentToolUseMessage(
      str(data.timestamp), str(data.toolId),
      action,
      asCodexSubagentDetails(data.details));
  },

  'update-plan-tool-use': (data) =>
    new UpdatePlanToolUseMessage(
      str(data.timestamp), str(data.toolId),
      coerceTodoItems(data.todos)),

  'write-stdin-tool-use': (data) =>
    new WriteStdinToolUseMessage(
      str(data.timestamp), str(data.toolId), asRecord(data.input)),

  'enter-plan-mode-tool-use': (data) =>
    new EnterPlanModeToolUseMessage(str(data.timestamp), str(data.toolId)),

  'exit-plan-mode-tool-use': (data) => {
    const plan = asOptionalString(data.plan);
    if (plan === undefined) return null;
    return new ExitPlanModeToolUseMessage(
      str(data.timestamp), str(data.toolId),
      plan,
      asAllowedPrompts(data.allowedPrompts));
  },

  'ask-user-question-tool-use': (data) =>
    new AskUserQuestionToolUseMessage(
      str(data.timestamp), str(data.toolId),
      asOptionalString(data.title),
      asAskUserQuestions(data.questions)),

  'cursor-ask-question-tool-use': (data) =>
    new CursorAskQuestionToolUseMessage(
      str(data.timestamp), str(data.toolId),
      asOptionalString(data.title),
      asCursorAskQuestions(data.questions)),

  'cursor-create-plan-tool-use': (data) => {
    const plan = asOptionalString(data.plan);
    if (plan === undefined) return null;
    return new CursorCreatePlanToolUseMessage(
      str(data.timestamp), str(data.toolId),
      plan,
      asOptionalString(data.name),
      asOptionalString(data.overview),
      asCursorPlanTodos(data.todos),
      asOptionalBoolean(data.isProject),
      asCursorPlanPhases(data.phases));
  },

  'amp-finder-tool-use': (data) =>
    new AmpFinderToolUseMessage(
      str(data.timestamp), str(data.toolId),
      asOptionalString(data.query)),

  'amp-oracle-tool-use': (data) =>
    new AmpOracleToolUseMessage(
      str(data.timestamp), str(data.toolId),
      asOptionalString(data.task),
      asOptionalString(data.context),
      asStringArray(data.files)),

  'amp-librarian-tool-use': (data) =>
    new AmpLibrarianToolUseMessage(
      str(data.timestamp), str(data.toolId),
      asOptionalString(data.query),
      asOptionalString(data.context)),

  'amp-skill-tool-use': (data) =>
    new AmpSkillToolUseMessage(
      str(data.timestamp), str(data.toolId),
      asOptionalString(data.name)),

  'amp-mermaid-tool-use': (data) =>
    new AmpMermaidToolUseMessage(
      str(data.timestamp), str(data.toolId)),

  'amp-handoff-tool-use': (data) =>
    new AmpHandoffToolUseMessage(
      str(data.timestamp), str(data.toolId),
      asOptionalString(data.goal)),

  'amp-look-at-tool-use': (data) =>
    new AmpLookAtToolUseMessage(
      str(data.timestamp), str(data.toolId),
      asOptionalString(data.path),
      asOptionalString(data.objective)),

  'amp-find-thread-tool-use': (data) =>
    new AmpFindThreadToolUseMessage(
      str(data.timestamp), str(data.toolId),
      asOptionalString(data.query)),

  'amp-read-thread-tool-use': (data) =>
    new AmpReadThreadToolUseMessage(
      str(data.timestamp), str(data.toolId),
      asOptionalString(data.threadId),
      asOptionalString(data.goal)),

  'amp-task-list-tool-use': (data) =>
    new AmpTaskListToolUseMessage(
      str(data.timestamp), str(data.toolId),
      asOptionalString(data.action),
      asOptionalString(data.taskId),
      asOptionalString(data.title),
      asOptionalString(data.status)),

  'external-tool-use': (data) =>
    new ExternalToolUseMessage(
      str(data.timestamp), str(data.toolId),
      str(data.name),
      asRecord(data.input),
      data.namespace === null ? null : asOptionalString(data.namespace)),

  'mcp-tool-use': (data) =>
    new McpToolUseMessage(
      str(data.timestamp), str(data.toolId),
      str(data.server),
      str(data.tool),
      asRecord(data.input)),

  'request-permissions-tool-use': (data) =>
    new RequestPermissionsToolUseMessage(
      str(data.timestamp), str(data.toolId),
      asRecord(data.permissions),
      asOptionalString(data.reason)),

  'unknown-tool-use': (data) =>
    new UnknownToolUseMessage(
      str(data.timestamp), str(data.toolId),
      str(data.rawName), asRecord(data.input)),
} satisfies Record<ToolUseMessageType, ToolUseMessageParser>;

const TOOL_USE_MESSAGE_TYPES = new Set<ToolUseMessageType>(
  Object.keys(TOOL_USE_MESSAGE_PARSERS) as ToolUseMessageType[],
);

function parseToolUseMessage(data: Record<string, unknown>): ToolUseChatMessage | null {
  const type = data.type;
  if (typeof type !== 'string') return null;
  const parser = TOOL_USE_MESSAGE_PARSERS[type as ToolUseMessageType];
  return parser?.(data) ?? null;
}

// Runtime guard for tool-use messages. The parser table is the source of
// truth so parser support and guard behavior cannot drift.
export function isToolUseMessage(message: ChatMessage): message is ToolUseChatMessage {
  return TOOL_USE_MESSAGE_TYPES.has(message.type as ToolUseMessageType);
}

// Constructs a typed ChatMessage class instance from raw data.
// Returns null for unrecognized message types.
export function parseChatMessage(data: Record<string, unknown>): ChatMessage | null {
  const toolUseMessage = parseToolUseMessage(data);
  if (toolUseMessage) return toolUseMessage;

  switch (data.type) {
	    case 'user-message':
	      return new UserMessage(
	        str(data.timestamp),
	        str(data.content),
	        asChatImages(data.images),
	        parseChatMessageMetadata(data.metadata),
	      );
    case 'assistant-message':
      return new AssistantMessage(str(data.timestamp), str(data.content));
    case 'thinking':
      return new ThinkingMessage(str(data.timestamp), str(data.content));

    case 'tool-result':
      return new ToolResultMessage(str(data.timestamp), str(data.toolId), (data.content ?? {}) as Record<string, unknown>, Boolean(data.isError));
    case 'error':
      return new ErrorMessage(str(data.timestamp), str(data.content));
    case 'permission-request': {
      const requestedToolData = asRecord(data.requestedTool);
      const requestedTool = parseChatMessage(requestedToolData);
      if (!requestedTool || !isToolUseMessage(requestedTool)) return null;
      return new PermissionRequestMessage(str(data.timestamp), str(data.permissionRequestId), requestedTool);
    }
    case 'permission-resolved':
      return new PermissionResolvedMessage(str(data.timestamp), str(data.permissionRequestId), Boolean(data.allowed));
    case 'permission-cancelled':
      return new PermissionCancelledMessage(str(data.timestamp), str(data.permissionRequestId), data.reason as 'cancelled' | 'session-complete' | 'aborted' | undefined);
    case 'compaction':
      return new CompactionMessage(
        str(data.timestamp),
        data.trigger === 'auto' ? 'auto' : 'manual',
        str(data.summary),
        asOptionalNumber(data.preTokens),
        asOptionalNumber(data.postTokens),
      );
    case 'agent-switch':
      return new AgentSwitchMessage(
        str(data.timestamp),
        str(data.fromAgentId),
        str(data.toAgentId),
        asOptionalString(data.fromModel),
        asOptionalString(data.toModel),
      );
    default:
      return null;
  }
}

// Parses an array of raw message objects into typed ChatMessage instances.
// Silently drops entries with unrecognized types.
export function parseChatMessages(data: unknown): ChatMessage[] {
  if (!Array.isArray(data)) return [];
  const result: ChatMessage[] = [];
  for (const item of data) {
    const msg = parseChatMessage(item);
    if (msg) result.push(msg);
  }
  return result;
}
