import { describe, expect, it, mock } from 'bun:test';
import { ProjectAdmission } from '../project-admission.ts';

describe('ProjectAdmission', () => {
  it('checks the registered path freshly for each admission', async () => {
    const inspect = mock(async () => ({ kind: 'available', effectiveProjectKey: '/real/project' }));
    const admission = new ProjectAdmission({
      getChat: () => ({ projectPath: '/workspace/project' }),
    }, inspect);

    await admission.assertAvailable('1783725900000800');
    await admission.assertAvailable('1783725900000800');

    expect(inspect).toHaveBeenCalledTimes(2);
    expect(inspect).toHaveBeenCalledWith('/workspace/project');
  });

  it('preserves typed missing-chat and unavailable-project errors', async () => {
    const missing = new ProjectAdmission({ getChat: () => null });
    await expect(missing.assertAvailable('1783725900000800')).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND', status: 404,
    });

    const unavailable = new ProjectAdmission(
      { getChat: () => ({ projectPath: '/workspace/missing' }) },
      async () => ({ kind: 'unavailable', reason: 'not-found' }),
    );
    await expect(unavailable.assertAvailable('1783725900000800')).rejects.toMatchObject({
      code: 'PROJECT_UNAVAILABLE',
      status: 409,
      retryable: false,
      projectPath: '/workspace/missing',
      reason: 'not-found',
    });
  });
});
