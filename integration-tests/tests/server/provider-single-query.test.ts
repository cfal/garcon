import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('instance-bound one-shot cancellation through HTTP', () => {
  for (const mode of ['validation', 'result'] as const) {
    test(`rejects cancellation after ${mode} without leaking a successful result or retrying`, async () => {
      await withIntegrationFixture(`single-query-${mode}`, async (fixture) => {
        const agent = fixture.directAgents.openAi;
        await fixture.client.updateSettings({ ui: { promptRefinement: {
          agentId: agent.agentId, model: agent.provider.model,
          apiProviderId: agent.provider.providerId, modelEndpointId: agent.provider.endpointId,
          modelProtocol: agent.provider.protocol, thinkingMode: 'none',
        } } });
        const chats = await fixture.client.listChats();
        const held = mode === 'result' ? fixture.fakeProviders.openAi.holdNext({ model: agent.provider.model }) : null;
        const pending = fixture.client.refinePrompt({ draft: 'Synthetic cancelled draft', target: 'prompt' })
          .then((value) => value, (error: unknown) => error);
        if (held) {
          await held.received;
          expect(held.releaseText('Synthetic stale result')).toBe(true);
        }
        expect(await pending).toMatchObject({ status: 502, body: { errorCode: 'PROMPT_REFINEMENT_FAILED' } });
        expect(fixture.fakeProviders.openAi.requests()).toHaveLength(mode === 'result' ? 1 : 0);
        expect(await fixture.client.listChats()).toEqual(chats);

        const successor = fixture.fakeProviders.openAi.holdNext({ model: agent.provider.model });
        const response = fixture.client.refinePrompt({ draft: 'Synthetic successor draft', target: 'prompt' });
        await successor.received;
        expect(successor.releaseText('Synthetic successor result')).toBe(true);
        expect(await response).toEqual({ success: true, refinedPrompt: 'Synthetic successor result' });
        expect(fixture.fakeProviders.openAi.requests()).toHaveLength(mode === 'result' ? 2 : 1);
        expect(await fixture.client.listChats()).toEqual(chats);
      }, {
        bindAddress: '0.0.0.0', authentication: 'account',
        preloadModules: [fileURLToPath(new URL('../../support/provider-single-query-preload.ts', import.meta.url))],
        serverEnvironment: { GARCON_TEST_SINGLE_QUERY_CANCEL: mode },
      });
    }, 30_000);
  }
});
