import { isTokenFittingRequest, type TokenFittingEvent } from './protocol.js';
import { runTokenFittingTask, type TokenFittingTask } from './tasks.js';

let pending: { readonly taskId: number; readonly task: TokenFittingTask; readonly items: unknown[] } | null = null;

function post(event: TokenFittingEvent): void {
  self.postMessage(event);
}

// Protocol violations throw so the owning client retires this Worker.
self.onmessage = (message: MessageEvent<unknown>) => {
  const request = message.data;
  if (!isTokenFittingRequest(request)) throw new Error('Token fitting received an invalid request');
  if (request.type === 'begin') {
    if (pending) throw new Error('Token fitting task is already pending');
    pending = { taskId: request.taskId, task: request.task, items: [] };
    return;
  }
  if (pending?.taskId !== request.taskId) throw new Error('Token fitting task is not pending');
  if (request.type === 'items') {
    for (const item of request.items) pending.items.push(item);
    return;
  }
  const { taskId, task, items } = pending;
  pending = null;
  try {
    post({ type: 'result', taskId, result: runTokenFittingTask(task, items) });
  } catch (error) {
    post({ type: 'failed', taskId, message: error instanceof Error ? error.message : String(error) });
  }
};
