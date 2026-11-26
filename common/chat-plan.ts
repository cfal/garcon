import { asRecord } from './chat-message-coercion.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

export interface PlanStep {
  content: string;
  status: TodoStatus | 'skipped' | 'failed';
}

export class UpdatePlanToolUseMessage {
  readonly type = 'update-plan-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public todos?: PlanStep[],
  ) {}
}

export class EnterPlanModeToolUseMessage {
  readonly type = 'enter-plan-mode-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
  ) {}
}

// Antigravity reports its own planning activity; these calls do not request a Garcon mode change.
export class AntigravityEnterPlanModeToolUseMessage {
  readonly type = 'antigravity-enter-plan-mode-tool-use' as const;
  constructor(public timestamp: string, public toolId: string, public reason: string) {}
}

export class AntigravityExitPlanModeToolUseMessage {
  readonly type = 'antigravity-exit-plan-mode-tool-use' as const;
  constructor(public timestamp: string, public toolId: string, public plan: string) {}
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

function todoStatus(obj: Record<string, unknown>): TodoStatus {
  if (obj.completed === true || obj.status === 'completed' || obj.status === 'done') return 'completed';
  if (obj.status === 'in_progress' || obj.status === 'in-progress') return 'in_progress';
  return 'pending';
}

function checklistItems<S extends PlanStep['status']>(raw: unknown, statusOf: (obj: Record<string, unknown>) => S) {
  if (!Array.isArray(raw)) return undefined;
  const items: Array<{ content: string; status: S }> = [];
  for (const entry of raw) {
    if (entry == null || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const content = obj.content ?? obj.text ?? obj.step;
    if (typeof content !== 'string') continue;
    items.push({ content, status: statusOf(obj) });
  }
  return items.length > 0 ? items : undefined;
}

export function coerceTodoItems(raw: unknown): TodoItem[] | undefined {
  return checklistItems(raw, todoStatus);
}

export function coercePlanSteps(raw: unknown): PlanStep[] | undefined {
  if (Array.isArray(raw) && raw.length === 0) return [];
  return checklistItems(raw, item => {
    if (item.status === 'failed' || item.status === 'skipped') return item.status;
    return todoStatus(item);
  });
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
