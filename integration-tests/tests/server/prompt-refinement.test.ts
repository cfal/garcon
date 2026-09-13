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
  test.each(['prompt', 'ticket-description', 'ticket-comment'] as const)('refines %s using the saved target and complete template', async (refinementTarget) => {
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

        const renderedPrompt = DEFAULT_PROMPT_REFINEMENT_PROMPT.replaceAll(
          PROMPT_REFINEMENT_USER_PROMPT_TOKEN,
          () => draft,
        );
        let expectedModelPrompt = renderedPrompt;
        if (refinementTarget === 'ticket-description') {
          expectedModelPrompt += '\n\nThe draft is a ticket description, not a chat prompt. Improve its clarity and organization while preserving its facts, requirements, Markdown, and ticket references. Do not invent requirements, claim completed work, or execute the described task. Return only the revised description.';
        } else if (refinementTarget === 'ticket-comment') {
          expectedModelPrompt += '\n\nThe draft is a ticket comment, not a chat prompt. Improve its clarity and organization while preserving its facts, progress, Markdown, and ticket references. Do not invent facts, claim completed work, or execute the described task. Return only the revised comment.';
        }
        const held = fixture.fakeProviders.openAi.holdNext({
          model: target.provider.model,
          lastUserText: expectedModelPrompt,
        });
        const response = fixture.client.refinePrompt({ draft, target: refinementTarget });

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

  test('constrains snippet refinement and rejects changed template tokens', async () => {
    const draft = 'Review {{arguments}} in {{project_path}}.';
    const constraint = [
      'The draft is a Garcon snippet template. Preserve every supported template token verbatim, in the same order and with the same count.',
      'Supported tokens are {{arguments}}, {{project_path}}, and {{chat_id}}, including their escaped forms \\{{arguments}}, \\{{project_path}}, and \\{{chat_id}}.',
      'Do not add, remove, reorder, escape, or unescape these tokens.',
    ].join(' ');

    await withIntegrationFixture('snippet-prompt-refinement', async (fixture) => {
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

      const renderedPrompt = DEFAULT_PROMPT_REFINEMENT_PROMPT.replaceAll(
        PROMPT_REFINEMENT_USER_PROMPT_TOKEN,
        () => draft,
      );
      const expectedModelPrompt = `${renderedPrompt}\n\n${constraint}`;
      const held = fixture.fakeProviders.openAi.holdNext({
        model: target.provider.model,
        lastUserText: expectedModelPrompt,
      });
      const response = fixture.client.refinePrompt({ draft, target: 'snippet-template' });

      expect((await held.received).lastUserText).toBe(expectedModelPrompt);
      expect(held.releaseText('Review {{chat_id}} in {{project_path}}.')).toBe(true);
      await expect(response).rejects.toMatchObject({
        status: 502,
        body: { errorCode: 'PROMPT_REFINEMENT_TOKEN_SIGNATURE_CHANGED' },
      });
    });
  });
});
