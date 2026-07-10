import { beforeEach, describe, expect, it, mock } from 'bun:test';

class MalformedJsonError extends Error {
  constructor() {
    super('Malformed JSON');
    this.name = 'MalformedJsonError';
  }
}

mock.module('../../lib/http-request.js', () => ({
  parseJsonBody: mock(() => Promise.resolve({})),
  MalformedJsonError,
}));

import { parseJsonBody } from '../../lib/http-request.js';
import createScheduledTaskRoutes from '../scheduled-tasks.ts';
import { ScheduledTaskDomainError } from '../../scheduled-tasks/store.ts';

const emptySnapshot = { revision: 0, tasks: [], runLog: [] };

async function call(handler, body, method) {
  parseJsonBody.mockResolvedValueOnce(body);
  const response = await handler(new Request('http://localhost/test', { method }));
  return { response, body: await response.json() };
}

function scheduler() {
  return {
    snapshotAfterReconciliation: mock(() => Promise.resolve(emptySnapshot)),
    create: mock(() => Promise.resolve({ ...emptySnapshot, revision: 1 })),
    update: mock(() => Promise.resolve({ ...emptySnapshot, revision: 1 })),
    remove: mock(() => Promise.resolve({ ...emptySnapshot, revision: 1 })),
    reorder: mock(() => Promise.resolve({ ...emptySnapshot, revision: 1 })),
  };
}

describe('scheduled task routes', () => {
  beforeEach(() => parseJsonBody.mockClear());

  it('returns the reconciled snapshot and typed mutation envelopes', async () => {
    const service = scheduler();
    const routes = createScheduledTaskRoutes(service);
    const get = await routes['/api/v1/scheduled-tasks'].GET(new Request('http://localhost/api/v1/scheduled-tasks'));
    expect(await get.json()).toEqual(emptySnapshot);

    const definition = {
      schedule: { type: 'once', runAtUtc: '2030-01-01T09:00:00.000Z' },
      target: { type: 'existing-chat', chatId: '123', busyBehavior: 'queue' },
      prompt: 'Continue the work',
    };
    const created = await call(
      routes['/api/v1/scheduled-tasks'].POST,
      { expectedRevision: 0, task: definition },
      'POST',
    );
    expect(created.response.status).toBe(201);
    expect(created.body).toEqual({
      success: true,
      snapshot: { ...emptySnapshot, revision: 1 },
    });
    expect(service.create).toHaveBeenCalledWith({
      expectedRevision: 0,
      task: definition,
    });
  });

  it('validates request shells before calling the scheduler', async () => {
    const service = scheduler();
    const routes = createScheduledTaskRoutes(service);
    const invalid = await call(routes['/api/v1/scheduled-tasks'].DELETE, { id: '' }, 'DELETE');
    expect(invalid.response.status).toBe(400);
    expect(invalid.body.errorCode).toBe('SCHEDULED_TASK_VALIDATION_FAILED');
    expect(service.remove).not.toHaveBeenCalled();
  });

  it('preserves domain status, error code, and retryability', async () => {
    const service = scheduler();
    service.update.mockRejectedValueOnce(
      new ScheduledTaskDomainError('SCHEDULED_TASK_REVISION_CONFLICT', 'Refresh and try again', 409, true),
    );
    const routes = createScheduledTaskRoutes(service);
    const result = await call(
      routes['/api/v1/scheduled-tasks'].PUT,
      {
        expectedRevision: 1,
        id: 'task-a',
        task: { invalid: true },
      },
      'PUT',
    );

    expect(result.response.status).toBe(409);
    expect(result.body).toMatchObject({
      errorCode: 'SCHEDULED_TASK_REVISION_CONFLICT',
      retryable: true,
    });
  });

  it('forwards exact full-order mutations', async () => {
    const service = scheduler();
    const routes = createScheduledTaskRoutes(service);
    const result = await call(
      routes['/api/v1/scheduled-tasks/reorder'].PUT,
      {
        expectedRevision: 4,
        orderedTaskIds: ['b', 'a'],
      },
      'PUT',
    );

    expect(result.response.status).toBe(200);
    expect(service.reorder).toHaveBeenCalledWith({
      expectedRevision: 4,
      orderedTaskIds: ['b', 'a'],
    });
  });
});
