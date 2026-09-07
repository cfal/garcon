import type {
  AskUserQuestionOption,
  AskUserQuestionPrompt,
  ChatImage,
  ChatMessageMetadata,
  CursorAskQuestionOption,
  CursorAskQuestionPrompt,
  CursorPlanPhase,
  CursorPlanTodo,
  CursorPlanTodoStatus,
} from './chat-types.js';

export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function parseChatMessageMetadata(value: unknown): ChatMessageMetadata | undefined {
  const raw = asRecord(value);
  const metadata: ChatMessageMetadata = {};
  if (typeof raw.clientRequestId === 'string') metadata.clientRequestId = raw.clientRequestId;
  if (typeof raw.clientMessageId === 'string') metadata.clientMessageId = raw.clientMessageId;
  if (typeof raw.upstreamRequestId === 'string') metadata.upstreamRequestId = raw.upstreamRequestId;
  if (typeof raw.turnId === 'string') metadata.turnId = raw.turnId;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => (
    typeof item === 'string' && item.trim().length > 0
  ));
  return items.length > 0 ? items : undefined;
}

export function asChatImages(value: unknown): ChatImage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const images: ChatImage[] = [];
  for (const entry of value) {
    const raw = asRecord(entry);
    if (typeof raw.data !== 'string' || typeof raw.name !== 'string') continue;
    images.push({
      data: raw.data,
      name: raw.name,
      ...(typeof raw.mimeType === 'string' && raw.mimeType ? { mimeType: raw.mimeType } : {}),
    });
  }
  if (images.length > 0 || value.length === 0) return images;
  return undefined;
}

export function asAllowedPrompts(value: unknown): Array<{ tool: string; prompt: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const prompts: Array<{ tool: string; prompt: string }> = [];
  for (const entry of value) {
    const raw = asRecord(entry);
    if (typeof raw.tool !== 'string' || typeof raw.prompt !== 'string') continue;
    prompts.push({ tool: raw.tool, prompt: raw.prompt });
  }
  if (prompts.length > 0 || value.length === 0) return prompts;
  return undefined;
}

export function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asAskUserQuestionOptions(value: unknown): AskUserQuestionOption[] {
  if (!Array.isArray(value)) return [];
  const options: AskUserQuestionOption[] = [];
  for (const entry of value) {
    const raw = asRecord(entry);
    if (typeof raw.id !== 'string' || typeof raw.label !== 'string') continue;
    const option: AskUserQuestionOption = { id: raw.id, label: raw.label };
    if (typeof raw.description === 'string') option.description = raw.description;
    if (typeof raw.preview === 'string') option.preview = raw.preview;
    options.push(option);
  }
  return options;
}

export function asAskUserQuestions(value: unknown): AskUserQuestionPrompt[] {
  if (!Array.isArray(value)) return [];
  const questions: AskUserQuestionPrompt[] = [];
  for (const entry of value) {
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

function asCursorAskQuestionOptions(value: unknown): CursorAskQuestionOption[] {
  if (!Array.isArray(value)) return [];
  const options: CursorAskQuestionOption[] = [];
  for (const entry of value) {
    const raw = asRecord(entry);
    if (typeof raw.id !== 'string' || typeof raw.label !== 'string') continue;
    options.push({ id: raw.id, label: raw.label });
  }
  return options;
}

export function asCursorAskQuestions(value: unknown): CursorAskQuestionPrompt[] {
  if (!Array.isArray(value)) return [];
  const questions: CursorAskQuestionPrompt[] = [];
  for (const entry of value) {
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

function asCursorPlanTodoStatus(value: unknown): CursorPlanTodoStatus {
  return value === 'completed'
    || value === 'in_progress'
    || value === 'cancelled'
    ? value
    : 'pending';
}

export function asCursorPlanTodos(value: unknown): CursorPlanTodo[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const todos: CursorPlanTodo[] = [];
  for (const entry of value) {
    const raw = asRecord(entry);
    if (typeof raw.content !== 'string') continue;
    const todo: CursorPlanTodo = {
      content: raw.content,
      status: asCursorPlanTodoStatus(raw.status),
    };
    if (typeof raw.id === 'string') todo.id = raw.id;
    todos.push(todo);
  }
  if (todos.length > 0 || value.length === 0) return todos;
  return undefined;
}

export function asCursorPlanPhases(value: unknown): CursorPlanPhase[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const phases: CursorPlanPhase[] = [];
  for (const entry of value) {
    const raw = asRecord(entry);
    if (typeof raw.name !== 'string') continue;
    phases.push({
      name: raw.name,
      todos: asCursorPlanTodos(raw.todos) ?? [],
    });
  }
  if (phases.length > 0 || value.length === 0) return phases;
  return undefined;
}

export function asOptionalChanges(value: unknown): Array<{ path?: string; kind?: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const changes: Array<{ path?: string; kind?: string }> = [];
  for (const entry of value) {
    const raw = asRecord(entry);
    const change: { path?: string; kind?: string } = {};
    if (typeof raw.path === 'string') change.path = raw.path;
    if (typeof raw.kind === 'string') change.kind = raw.kind;
    if (change.path !== undefined || change.kind !== undefined) changes.push(change);
  }
  if (changes.length > 0 || value.length === 0) return changes;
  return undefined;
}
