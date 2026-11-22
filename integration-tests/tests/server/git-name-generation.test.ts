import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { rejectionOf } from '../../support/promise-assertions.js';

test('Git names use the title executor and refuse agents with unrestricted tools', async () => {
  await withIntegrationFixture('git-name-generation', async ({ client, directAgents, fakeProviders }) => {
    const suggest = () => client.post<{ name: string }>('/api/v1/git/generate-name', {
      description: 'Rename the settings label', previousName: '',
    });
    const held = fakeProviders.openAi.holdNext({ model: directAgents.openAi.provider.model });
    const pending = suggest();
    const request = await held.received;
    expect(request.lastUserText).toContain('Rename the settings label');
    held.releaseText('settings-label');
    expect(await pending).toEqual({ name: 'settings-label' });

    await client.updateSettings({ ui: { chatTitle: {
      enabled: false, executorId: client.executorId, agentId: 'amp', model: 'low',
    } } });
    expect(await rejectionOf(suggest())).toMatchObject({
      status: 422, body: { errorCode: 'UNSUPPORTED_AGENT', retryable: false },
    });
    expect(fakeProviders.openAi.requests()).toHaveLength(1);
  }, {
    chatTitleAgent: 'openAi',
    chatTitleEnabled: false,
    resolveServerEnvironment: ({ root }) => ({ AMP_BINARY: join(root, 'not-installed-amp') }),
  });
}, 30_000);
