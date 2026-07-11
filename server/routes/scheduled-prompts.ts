import type {
  CreateScheduledPromptRequest,
  ReorderScheduledPromptsRequest,
  RemoveScheduledPromptRequest,
  ScheduleInPromptRequest,
  ScheduleInPromptResponse,
  UpdateScheduledPromptRequest,
} from '../../common/scheduled-prompts.js';
import { jsonError, jsonErrorFromUnknown } from '../lib/http-error.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { withJsonBody } from '../lib/json-route.js';
import type { ScheduledPromptScheduler } from '../scheduled-prompts/scheduler.js';
import { ScheduledPromptDomainError } from '../scheduled-prompts/store.js';

function expectedRevision(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function scheduledPromptError(error: unknown): Response {
  if (error instanceof ScheduledPromptDomainError) {
    return jsonError(error.message, error.status, error.code, error.retryable);
  }
  return jsonErrorFromUnknown(error);
}

export default function createScheduledPromptRoutes(scheduledPrompts: ScheduledPromptScheduler): RouteMap {
  async function getPrompts(): Promise<Response> {
    try {
      return Response.json(await scheduledPrompts.snapshotAfterReconciliation());
    } catch (error) {
      return scheduledPromptError(error);
    }
  }

  async function postPrompt(body: CreateScheduledPromptRequest): Promise<Response> {
    const revision = expectedRevision(body?.expectedRevision);
    if (revision === null || !body?.scheduledPrompt) {
      return jsonError('expectedRevision and scheduledPrompt are required', 400, 'SCHEDULED_PROMPT_VALIDATION_FAILED');
    }
    try {
      const snapshot = await scheduledPrompts.create({
        expectedRevision: revision,
        scheduledPrompt: body.scheduledPrompt,
      });
      return Response.json({ success: true, snapshot }, { status: 201 });
    } catch (error) {
      return scheduledPromptError(error);
    }
  }

  async function postIn(body: ScheduleInPromptRequest): Promise<Response> {
    if (!body || typeof body !== 'object') {
      return jsonError('chatId, duration, and prompt are required', 400, 'SCHEDULED_PROMPT_VALIDATION_FAILED');
    }
    try {
      const result = await scheduledPrompts.scheduleIn(body);
      return Response.json({ success: true, ...result } satisfies ScheduleInPromptResponse, { status: 201 });
    } catch (error) {
      return scheduledPromptError(error);
    }
  }

  async function putPrompt(body: UpdateScheduledPromptRequest): Promise<Response> {
    const revision = expectedRevision(body?.expectedRevision);
    const id = typeof body?.id === 'string' ? body.id.trim() : '';
    if (revision === null || !id || !body?.scheduledPrompt) {
      return jsonError(
        'expectedRevision, id, and scheduledPrompt are required',
        400,
        'SCHEDULED_PROMPT_VALIDATION_FAILED',
      );
    }
    try {
      const snapshot = await scheduledPrompts.update({
        expectedRevision: revision,
        id,
        scheduledPrompt: body.scheduledPrompt,
      });
      return Response.json({ success: true, snapshot });
    } catch (error) {
      return scheduledPromptError(error);
    }
  }

  async function deletePrompt(body: RemoveScheduledPromptRequest): Promise<Response> {
    const revision = expectedRevision(body?.expectedRevision);
    const id = typeof body?.id === 'string' ? body.id.trim() : '';
    if (revision === null || !id) {
      return jsonError('expectedRevision and id are required', 400, 'SCHEDULED_PROMPT_VALIDATION_FAILED');
    }
    try {
      const snapshot = await scheduledPrompts.remove({
        expectedRevision: revision,
        id,
      });
      return Response.json({ success: true, snapshot });
    } catch (error) {
      return scheduledPromptError(error);
    }
  }

  async function putOrder(body: ReorderScheduledPromptsRequest): Promise<Response> {
    const revision = expectedRevision(body?.expectedRevision);
    const orderedPromptIds = Array.isArray(body?.orderedPromptIds)
      ? body.orderedPromptIds.filter((id): id is string => typeof id === 'string')
      : null;
    if (revision === null || !orderedPromptIds || orderedPromptIds.length !== body.orderedPromptIds.length) {
      return jsonError('expectedRevision and orderedPromptIds are required', 400, 'SCHEDULED_PROMPT_VALIDATION_FAILED');
    }
    try {
      const snapshot = await scheduledPrompts.reorder({
        expectedRevision: revision,
        orderedPromptIds,
      });
      return Response.json({ success: true, snapshot });
    } catch (error) {
      return scheduledPromptError(error);
    }
  }

  return {
    '/api/v1/scheduled-prompts': {
      GET: getPrompts,
      POST: withJsonBody(postPrompt),
      PUT: withJsonBody(putPrompt),
      DELETE: withJsonBody(deletePrompt),
    },
    '/api/v1/scheduled-prompts/reorder': {
      PUT: withJsonBody(putOrder),
    },
    '/api/v1/scheduled-prompts/in': {
      POST: withJsonBody(postIn),
    },
  };
}
