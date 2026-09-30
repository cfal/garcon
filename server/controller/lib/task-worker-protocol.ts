import { isRecord } from '../../../common/json.js';

// A task's parameters travel in `begin`; its transcript items follow in bounded batches, so
// no single structured clone holds the main thread for long; `run` starts it.
export type TaskWorkerRequest<Task> =
  | { readonly type: 'begin'; readonly taskId: number; readonly task: Task }
  | { readonly type: 'items'; readonly taskId: number; readonly items: readonly unknown[] }
  | { readonly type: 'run'; readonly taskId: number };

export type TaskWorkerEvent =
  | { readonly type: 'result'; readonly taskId: number; readonly result: unknown }
  | { readonly type: 'failed'; readonly taskId: number; readonly message: string; readonly code?: string };

export function isTaskWorkerRequest<Task extends { readonly kind: string }>(
  value: unknown,
  kinds: readonly Task['kind'][],
): value is TaskWorkerRequest<Task> {
  if (!isRecord(value) || !Number.isSafeInteger(value.taskId)) return false;
  switch (value.type) {
    case 'begin':
      return isRecord(value.task) && kinds.includes(value.task.kind as Task['kind']);
    case 'items':
      return Array.isArray(value.items);
    case 'run':
      return true;
    default:
      return false;
  }
}

export function isTaskWorkerEvent(value: unknown): value is TaskWorkerEvent {
  if (!isRecord(value) || !Number.isSafeInteger(value.taskId)) return false;
  switch (value.type) {
    case 'result':
      return 'result' in value;
    case 'failed':
      return typeof value.message === 'string' && (value.code === undefined || typeof value.code === 'string');
    default:
      return false;
  }
}
