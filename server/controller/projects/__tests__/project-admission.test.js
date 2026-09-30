import { describe, expect, it, mock, spyOn } from 'bun:test';
import { INTERACTIVE_EXECUTOR_WAIT_MS, SENT_READ_GRACE_MS } from '../../../common/interactive-deadline.ts';
import { ProjectAdmission } from '../project-admission.ts';

describe('ProjectAdmission', () => {
  it('checks the registered path freshly for each admission', async () => {
    const inspect = mock(async () => ({ kind: 'available', effectiveProjectKey: '/real/project' }));
    const admission = new ProjectAdmission({
      getChat: () => ({ projectPath: '/workspace/project' }),
    }, inspect);

    await admission.assertAvailable('1783725900000800', null);
    await admission.assertAvailable('1783725900000800', null);

    expect(inspect).toHaveBeenCalledTimes(2);
    expect(inspect).toHaveBeenCalledWith('/workspace/project', undefined, { signal: undefined });
  });

  // An operation holding a chat or queue-control lock bounds the inspection by its
  // interactive deadline; background work keeps the call's own deadline.
  it('bounds the inspection by the caller\'s interactive deadline', async () => {
    let now = 1_000;
    const clock = spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const inspect = mock(async () => ({ kind: 'available', effectiveProjectKey: '/real/project' }));
      const admission = new ProjectAdmission({ getChat: () => ({ projectPath: '/workspace/project' }) }, inspect);
      const deadline = now + INTERACTIVE_EXECUTOR_WAIT_MS;

      await admission.assertAvailable('1783725900000800', deadline);
      await admission.assertAvailable('1783725900000800', null);

      expect(inspect.mock.calls.map((call) => call[2])).toEqual([
        { signal: undefined, dispatchDeadline: deadline, timeoutMs: INTERACTIVE_EXECUTOR_WAIT_MS + SENT_READ_GRACE_MS },
        { signal: undefined },
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  it('preserves typed missing-chat and unavailable-project errors', async () => {
    const missing = new ProjectAdmission({ getChat: () => null }, async () => {
      throw new Error('Missing chats must not inspect a project');
    });
    await expect(missing.assertAvailable('1783725900000800', null)).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND', status: 404,
    });

    const unavailable = new ProjectAdmission(
      { getChat: () => ({ projectPath: '/workspace/missing' }) },
      async () => ({ kind: 'unavailable', reason: 'not-found' }),
    );
    await expect(unavailable.assertAvailable('1783725900000800', null)).rejects.toMatchObject({
      code: 'PROJECT_UNAVAILABLE',
      status: 409,
      retryable: false,
      projectPath: '/workspace/missing',
      reason: 'not-found',
    });
  });

  it('passes through unexpected inspection failures', async () => {
    const failure = new Error('device failed');
    const admission = new ProjectAdmission(
      { getChat: () => ({ projectPath: '/workspace/project' }) },
      async () => { throw failure; },
    );

    await expect(admission.assertAvailable('1783725900000800', null)).rejects.toBe(failure);
  });
});
