import type {
  CreateScheduledTaskRequest,
  ReorderScheduledTasksRequest,
  RemoveScheduledTaskRequest,
  UpdateScheduledTaskRequest,
} from '../../common/scheduled-tasks.js';
import { jsonError, jsonErrorFromUnknown } from '../lib/http-error.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { withJsonBody } from '../lib/json-route.js';
import type { ScheduledTaskScheduler } from '../scheduled-tasks/scheduler.js';
import { ScheduledTaskDomainError } from '../scheduled-tasks/store.js';

function expectedRevision(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function scheduledTaskError(error: unknown): Response {
  if (error instanceof ScheduledTaskDomainError) {
    return jsonError(error.message, error.status, error.code, error.retryable);
  }
  return jsonErrorFromUnknown(error);
}

export default function createScheduledTaskRoutes(scheduledTasks: ScheduledTaskScheduler): RouteMap {
  async function getTasks(): Promise<Response> {
    try {
      return Response.json(await scheduledTasks.snapshotAfterReconciliation());
    } catch (error) {
      return scheduledTaskError(error);
    }
  }

  async function postTask(body: CreateScheduledTaskRequest): Promise<Response> {
    const revision = expectedRevision(body?.expectedRevision);
    if (revision === null || !body?.task) {
      return jsonError('expectedRevision and task are required', 400, 'SCHEDULED_TASK_VALIDATION_FAILED');
    }
    try {
      const snapshot = await scheduledTasks.create({
        expectedRevision: revision,
        task: body.task,
      });
      return Response.json({ success: true, snapshot }, { status: 201 });
    } catch (error) {
      return scheduledTaskError(error);
    }
  }

  async function putTask(body: UpdateScheduledTaskRequest): Promise<Response> {
    const revision = expectedRevision(body?.expectedRevision);
    const id = typeof body?.id === 'string' ? body.id.trim() : '';
    if (revision === null || !id || !body?.task) {
      return jsonError('expectedRevision, id, and task are required', 400, 'SCHEDULED_TASK_VALIDATION_FAILED');
    }
    try {
      const snapshot = await scheduledTasks.update({
        expectedRevision: revision,
        id,
        task: body.task,
      });
      return Response.json({ success: true, snapshot });
    } catch (error) {
      return scheduledTaskError(error);
    }
  }

  async function deleteTask(body: RemoveScheduledTaskRequest): Promise<Response> {
    const revision = expectedRevision(body?.expectedRevision);
    const id = typeof body?.id === 'string' ? body.id.trim() : '';
    if (revision === null || !id) {
      return jsonError('expectedRevision and id are required', 400, 'SCHEDULED_TASK_VALIDATION_FAILED');
    }
    try {
      const snapshot = await scheduledTasks.remove({
        expectedRevision: revision,
        id,
      });
      return Response.json({ success: true, snapshot });
    } catch (error) {
      return scheduledTaskError(error);
    }
  }

  async function putOrder(body: ReorderScheduledTasksRequest): Promise<Response> {
    const revision = expectedRevision(body?.expectedRevision);
    const orderedTaskIds = Array.isArray(body?.orderedTaskIds)
      ? body.orderedTaskIds.filter((id): id is string => typeof id === 'string')
      : null;
    if (revision === null || !orderedTaskIds || orderedTaskIds.length !== body.orderedTaskIds.length) {
      return jsonError('expectedRevision and orderedTaskIds are required', 400, 'SCHEDULED_TASK_VALIDATION_FAILED');
    }
    try {
      const snapshot = await scheduledTasks.reorder({
        expectedRevision: revision,
        orderedTaskIds,
      });
      return Response.json({ success: true, snapshot });
    } catch (error) {
      return scheduledTaskError(error);
    }
  }

  return {
    '/api/v1/scheduled-tasks': {
      GET: getTasks,
      POST: withJsonBody(postTask),
      PUT: withJsonBody(putTask),
      DELETE: withJsonBody(deleteTask),
    },
    '/api/v1/scheduled-tasks/reorder': {
      PUT: withJsonBody(putOrder),
    },
  };
}
