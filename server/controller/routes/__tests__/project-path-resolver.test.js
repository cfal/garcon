import { describe, expect, it, mock } from 'bun:test';
import { resolveAccessibleProjectPath, resolveProjectPathFromUrl } from '../project-path-resolver.ts';
import createCommandsRoutes from '../commands.ts';

const PROJECT_PATH = '/workspace/project';

describe('resolveAccessibleProjectPath', () => {
  it.each(['projectPath=%2Fworkspace%2Fproject', 'chatId=1787471053739199'])('cancels command project inspection for %s', async (target) => {
    const cancellation = new AbortController();
    let inspectedSignal;
    const getSlashCommands = mock(async () => []);
    const routes = createCommandsRoutes({
      registry: { getChat: () => ({ projectPath: PROJECT_PATH }) },
      agents: { getSlashCommands },
      inspectProject: async (_path, _executorId, options) => {
        inspectedSignal = options?.signal;
        cancellation.abort();
        throw new DOMException('Aborted inspection', 'AbortError');
      },
    });
    const url = new URL(`http://localhost/api/v1/commands?${target}&agent=codex`);
    const request = new Request(url, { signal: cancellation.signal });
    const response = await routes['/api/v1/commands'].GET(request, url);
    expect(inspectedSignal).toBe(request.signal);
    expect(response.status).toBe(499);
    expect(getSlashCommands).not.toHaveBeenCalled();
  });

  it('rejects inspection crossing a same-path executor handoff', async () => {
    const chat = { projectPath: PROJECT_PATH, executorId: 'local' };
    const result = await resolveProjectPathFromUrl({ getChat: () => chat },
      new URL('http://localhost/api/v1/commands?chatId=1787471053739199'), async () => {
        chat.executorId = '11111111-1111-4111-8111-111111111111';
        return { kind: 'available', effectiveProjectKey: '/canonical/project' };
      });
    expect(result.error.status).toBe(409);
    expect((await result.error.json()).errorCode).toBe('PROJECT_PATH_CHANGED');
  });

  it('discovers commands for the selected agent on the fenced chat executor', async () => {
    const calls = [];
    const executorId = '11111111-1111-4111-8111-111111111111';
    const routes = createCommandsRoutes({
      registry: { getChat: () => ({ agentId: 'claude', projectPath: PROJECT_PATH, executorId }) },
      agents: { getSlashCommands: async (...args) => { calls.push(args); return []; } },
      inspectProject: async () => ({ kind: 'available', effectiveProjectKey: PROJECT_PATH }),
    });
    const url = new URL('http://localhost/api/v1/commands?chatId=1787471053739199&agent=codex');
    expect((await routes['/api/v1/commands'].GET(new Request(url), url)).status).toBe(200);
    expect(calls).toEqual([['codex', PROJECT_PATH, executorId]]);
  });
  it('rejects non-directory project roots with a typed response', async () => {
    const result = await resolveAccessibleProjectPath(
      PROJECT_PATH,
      async () => ({ kind: 'unavailable', reason: 'not-a-directory' }),
    );

    expect(result.error?.status).toBe(400);
    await expect(result.error?.json()).resolves.toMatchObject({
      errorCode: 'PROJECT_PATH_NOT_DIRECTORY',
      retryable: false,
    });
  });

  it('preserves the permission-denied response contract', async () => {
    const result = await resolveAccessibleProjectPath(
      PROJECT_PATH,
      async () => ({ kind: 'unavailable', reason: 'permission-denied' }),
    );

    expect(result.error?.status).toBe(403);
    await expect(result.error?.json()).resolves.toMatchObject({
      error: `Project folder cannot be accessed: ${PROJECT_PATH}`,
      errorCode: 'VALIDATION_FAILED',
      retryable: false,
    });
  });
});
