import { describe, expect, it, mock } from 'bun:test';
import { GIT_NAME_DESCRIPTION_LIMIT } from '../../../../common/git-name.js';
import { createGitNameRoute } from '../git-name.js';

type GitNameAgents = Parameters<typeof createGitNameRoute>[0];

const target = {
  executorId: '22222222-2222-4222-8222-222222222222',
  agentId: 'codex', model: 'test-model', apiProviderId: 'test-provider',
  modelEndpointId: 'test-endpoint', modelProtocol: 'openai-compatible', thinkingMode: 'high',
};
function fixture(output = 'worktree-picker', chatTitle: unknown = { ...target, enabled: false }) {
  const agents = {
    getAgentAuthStatusMap: mock(async () => ({})),
    getAgentReadinessMap: async () => ({}),
    getAgentCatalogEntries: async () => [],
    singleQueryRunsToolsWithoutPermission: mock<GitNameAgents['singleQueryRunsToolsWithoutPermission']>(() => false),
    runSingleQuery: mock<GitNameAgents['runSingleQuery']>(async () => output),
  } satisfies GitNameAgents;
  const handler = createGitNameRoute(agents, { getUiSettings: () => ({ chatTitle }) });
  const url = new URL('http://localhost/api/v1/git/generate-name');
  const post = (body: unknown) => handler(new Request(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), url);
  return { agents, post };
}

describe('Git name suggestions', () => {
  it('uses the saved title target even when automatic titles are disabled', async () => {
    const { agents, post } = fixture();
    const response = await post({ description: 'Improve the picker', previousName: '' });
    expect(await response.json()).toEqual({ name: 'worktree-picker' });
    expect(agents.runSingleQuery.mock.calls[0]?.[0]).toContain('Improve the picker');
    expect(agents.runSingleQuery.mock.calls[0]?.[1]).toMatchObject({ ...target, signal: expect.any(AbortSignal) });
    expect(agents.getAgentAuthStatusMap).not.toHaveBeenCalled();
  });
  it('rejects invalid inputs and routing overrides before spending tokens', async () => {
    const { agents, post } = fixture();
    for (const body of [null, {}, { description: 'x'.repeat(GIT_NAME_DESCRIPTION_LIMIT + 1), previousName: '' },
      { description: '', previousName: '', executorId: 'local' }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(agents.runSingleQuery).not.toHaveBeenCalled();
  });
  it.each(['local', target.executorId])('refuses unrestricted tools on the generation executor %s', async (executorId) => {
    const { agents, post } = fixture('unused-name', { ...target, executorId });
    agents.singleQueryRunsToolsWithoutPermission.mockReturnValue(true);
    const response = await post({ description: 'Routine UI task', previousName: '' });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ errorCode: 'UNSUPPORTED_AGENT', retryable: false });
    expect(agents.singleQueryRunsToolsWithoutPermission).toHaveBeenCalledWith(target.agentId, executorId);
    expect(agents.runSingleQuery).not.toHaveBeenCalled();
  });
  it('accepts a single clearly formatted suggestion without an extra model request', async () => {
    for (const output of ['Picker-Review', '"Picker-Review".', '`picker-review`', 'picker-review.']) {
      const { agents, post } = fixture(output);
      expect(await (await post({ description: '', previousName: '' })).json()).toEqual({ name: 'picker-review' });
      expect(agents.runSingleQuery).toHaveBeenCalledTimes(1);
    }
  });
  it('fails explicitly for unavailable models, invalid output or a repeated suggestion', async () => {
    expect((await fixture('', {}).post({ description: '', previousName: '' })).status).toBe(409);
    const invalid = [
      '', '../unsafe', 'my-name\nother-name', 'Name: picker-review', '"Previous-Name".', '\u212Aey-review',
    ];
    for (const output of invalid) {
      expect((await fixture(output).post({ description: '', previousName: 'previous-name' })).status).toBe(422);
    }
  });
});
