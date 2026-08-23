import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PROMPT_REFINEMENT_PROMPT,
  PROMPT_REFINEMENT_USER_PROMPT_TOKEN,
} from '../../../common/generation-prompts.js';
import {
  assertSensitiveValuesNotPersisted,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';

describe('prompt refinement', () => {
  test('uses the saved direct target and renders the complete refinement template', async () => {
    const draft = 'private-refinement-draft-$&-must-not-persist';
    const refinedPrompt = 'Make the request precise and actionable.';

    await withIntegrationFixture(
      'prompt-refinement',
      async (fixture) => {
        const target = fixture.directAgents.openAi;
        await fixture.client.updateSettings({
          ui: {
            promptRefinement: {
              agentId: target.agentId,
              model: target.provider.model,
              apiProviderId: target.provider.providerId,
              modelEndpointId: target.provider.endpointId,
              modelProtocol: target.provider.protocol,
              thinkingMode: 'none',
            },
          },
        });

        const expectedModelPrompt = DEFAULT_PROMPT_REFINEMENT_PROMPT.replaceAll(
          PROMPT_REFINEMENT_USER_PROMPT_TOKEN,
          () => draft,
        );
        const held = fixture.fakeProviders.openAi.holdNext({
          model: target.provider.model,
          lastUserText: expectedModelPrompt,
        });
        const response = fixture.client.refinePrompt({ draft, target: 'prompt' });

        expect((await held.received).lastUserText).toBe(expectedModelPrompt);
        expect(held.releaseText(`  ${refinedPrompt}  `)).toBe(true);
        expect(await response).toEqual({ success: true, refinedPrompt });
      },
      {
        afterGarconStop: (directories) =>
          assertSensitiveValuesNotPersisted({
            directory: directories.root,
            diagnostics: {},
            values: [draft, refinedPrompt],
          }),
        redactSensitiveDiagnostics: true,
      },
    );
  });
});
