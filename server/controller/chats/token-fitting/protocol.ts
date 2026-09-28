import { isRecord } from '../../../../common/json.js';
import { TOKEN_FITTING_TASK_KINDS, type TokenFittingTask } from './tasks.js';

export type TokenFittingRequest =
  | { readonly type: 'begin'; readonly taskId: number; readonly task: TokenFittingTask }
  | { readonly type: 'items'; readonly taskId: number; readonly items: readonly unknown[] }
  | { readonly type: 'run'; readonly taskId: number };

export type TokenFittingEvent =
  | { readonly type: 'result'; readonly taskId: number; readonly result: unknown }
  | { readonly type: 'failed'; readonly taskId: number; readonly message: string };

export function isTokenFittingRequest(value: unknown): value is TokenFittingRequest {
  if (!isRecord(value) || !Number.isSafeInteger(value.taskId)) return false;
  switch (value.type) {
    case 'begin':
      return isRecord(value.task)
        && TOKEN_FITTING_TASK_KINDS.includes(value.task.kind as TokenFittingTask['kind']);
    case 'items':
      return Array.isArray(value.items);
    case 'run':
      return true;
    default:
      return false;
  }
}

export function isTokenFittingEvent(value: unknown): value is TokenFittingEvent {
  if (!isRecord(value) || !Number.isSafeInteger(value.taskId)) return false;
  return value.type === 'result'
    ? 'result' in value
    : value.type === 'failed' && typeof value.message === 'string';
}
