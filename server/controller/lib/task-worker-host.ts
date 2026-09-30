import { isTaskWorkerRequest, type TaskWorkerEvent } from './task-worker-protocol.js';

// Serves one task at a time inside a Worker. Protocol violations throw, so the owning
// client retires the Worker. A task failure reports the error's message and string code.
// Byte buffers at the top level of a result move to the main thread without a copy.
export function serveTaskWorker<Task extends { readonly kind: string }>(
  label: string,
  kinds: readonly Task['kind'][],
  runTask: (task: Task, items: readonly unknown[]) => unknown,
): void {
  let pending: { readonly taskId: number; readonly task: Task; readonly items: unknown[] } | null = null;
  self.onmessage = (message: MessageEvent<unknown>) => {
    const request = message.data;
    if (!isTaskWorkerRequest<Task>(request, kinds)) throw new Error(`${label} received an invalid request`);
    if (request.type === 'begin') {
      if (pending) throw new Error(`${label} task is already pending`);
      pending = { taskId: request.taskId, task: request.task, items: [] };
      return;
    }
    if (pending?.taskId !== request.taskId) throw new Error(`${label} task is not pending`);
    if (request.type === 'items') {
      for (const item of request.items) pending.items.push(item);
      return;
    }
    const { taskId, task, items } = pending;
    pending = null;
    let event: TaskWorkerEvent;
    try {
      event = { type: 'result', taskId, result: runTask(task, items) };
    } catch (error) {
      const code = (error as { readonly code?: unknown } | null)?.code;
      event = {
        type: 'failed',
        taskId,
        message: error instanceof Error ? error.message : String(error),
        ...(typeof code === 'string' ? { code } : {}),
      };
    }
    self.postMessage(event, event.type === 'result' ? transferables(event.result) : []);
  };
}

function transferables(result: unknown): ArrayBuffer[] {
  if (result instanceof Uint8Array) return [result.buffer as ArrayBuffer];
  if (!result || typeof result !== 'object') return [];
  return Object.values(result)
    .filter((value): value is Uint8Array => value instanceof Uint8Array)
    .map((value) => value.buffer as ArrayBuffer);
}
