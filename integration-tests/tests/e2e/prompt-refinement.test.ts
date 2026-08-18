import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PROMPT_REFINEMENT_PROMPT,
  PROMPT_REFINEMENT_USER_PROMPT_TOKEN,
} from '../../../common/generation-prompts.js';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

const COMPOSER_SELECTOR = 'textarea[placeholder="Reply..."]';
const NEW_CHAT_COMPOSER_SELECTOR =
  '[role="dialog"] textarea[placeholder="How can I help you today?"]';

describe('Lightpanda prompt refinement', () => {
  test('locks and atomically replaces the compact composer draft', async () => {
    await withE2eFixture('prompt-refinement', async (fixture) => {
      const target = fixture.integration.directAgents.openAi;
      await fixture.integration.client.updateSettings({
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

      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('ui-refinement-seed');
      await app.waitForText('echo:ui-refinement-seed');

      const draft = 'make this request clearer';
      const refinedPrompt = 'Make this request clear, specific, and actionable.';
      const expectedModelPrompt = DEFAULT_PROMPT_REFINEMENT_PROMPT.replaceAll(
        PROMPT_REFINEMENT_USER_PROMPT_TOKEN,
        () => draft,
      );
      const held = fixture.integration.fakeProviders.openAi.holdNext({
        model: target.provider.model,
        lastUserText: expectedModelPrompt,
      });

      await app.fill(COMPOSER_SELECTOR, draft);
      await app.clickResponsiveAction('Refine prompt');
      await held.received;

      expect(
        await fixture.page.evaluate((selector) => {
          const composer = document.querySelector<HTMLTextAreaElement>(selector);
          const cancel = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
            (button) => button.getAttribute('aria-label') === 'Cancel prompt refinement',
          );
          const pendingSubmit = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
            (button) => button.getAttribute('aria-label') === 'Refining prompt...',
          );
          return {
            value: composer?.value,
            readOnly: composer?.readOnly,
            busy: composer?.getAttribute('aria-busy'),
            cancelEnabled: cancel !== undefined && !cancel.disabled,
            submitDisabled: pendingSubmit?.disabled,
          };
        }, COMPOSER_SELECTOR),
      ).toEqual({
        value: draft,
        readOnly: true,
        busy: 'true',
        cancelEnabled: true,
        submitDisabled: true,
      });

      expect(held.releaseText(`  ${refinedPrompt}  `)).toBe(true);
      await fixture.page.waitForFunction(
        (selector, expected) => {
          const composer = document.querySelector<HTMLTextAreaElement>(selector);
          return (
            composer?.value === expected &&
            composer.readOnly === false &&
            composer.getAttribute('aria-busy') === 'false' &&
            document.activeElement === composer &&
            composer.selectionStart === expected.length &&
            composer.selectionEnd === expected.length
          );
        },
        { timeout: 20_000 },
        COMPOSER_SELECTOR,
        refinedPrompt,
      );
      await app.waitForButtonEnabled('Refine prompt');

      expect(
        await fixture.page.$eval(COMPOSER_SELECTOR, (element) => ({
          value: (element as HTMLTextAreaElement).value,
          readOnly: (element as HTMLTextAreaElement).readOnly,
        })),
      ).toEqual({ value: refinedPrompt, readOnly: false });
      fixture.assertNoBrowserErrors();
    });
  });

  test('refines a New Chat draft without submitting it', async () => {
    await withE2eFixture('new-chat-prompt-refinement', async (fixture) => {
      const target = fixture.integration.directAgents.openAi;
      await fixture.integration.client.updateSettings({
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

      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.clickButton('New Chat');
      await fixture.page.waitForFunction(
        (selector) => {
          const composer = document.querySelector<HTMLTextAreaElement>(selector);
          const dialog = composer?.closest('[role="dialog"]');
          return (
            composer !== null &&
            dialog?.querySelector('[role="status"][aria-label="Loading chat defaults..."]') === null
          );
        },
        { timeout: 20_000 },
        NEW_CHAT_COMPOSER_SELECTOR,
      );

      const draft = 'turn this into a useful request';
      const refinedPrompt = 'Turn this into a clear, useful, and actionable request.';
      const expectedModelPrompt = DEFAULT_PROMPT_REFINEMENT_PROMPT.replaceAll(
        PROMPT_REFINEMENT_USER_PROMPT_TOKEN,
        () => draft,
      );
      const held = fixture.integration.fakeProviders.openAi.holdNext({
        model: target.provider.model,
        lastUserText: expectedModelPrompt,
      });

      await app.fill(NEW_CHAT_COMPOSER_SELECTOR, draft);
      await app.clickResponsiveAction('Refine prompt');
      await held.received;

      expect(
        await fixture.page.$eval(NEW_CHAT_COMPOSER_SELECTOR, (element) => ({
          value: (element as HTMLTextAreaElement).value,
          readOnly: (element as HTMLTextAreaElement).readOnly,
          busy: element.getAttribute('aria-busy'),
        })),
      ).toEqual({ value: draft, readOnly: true, busy: 'true' });

      expect(held.releaseText(refinedPrompt)).toBe(true);
      await fixture.page.waitForFunction(
        (selector, expected) => {
          const composer = document.querySelector<HTMLTextAreaElement>(selector);
          return (
            composer?.value === expected &&
            composer.readOnly === false &&
            composer.getAttribute('aria-busy') === 'false' &&
            document.activeElement === composer
          );
        },
        { timeout: 20_000 },
        NEW_CHAT_COMPOSER_SELECTOR,
        refinedPrompt,
      );
      expect(await fixture.page.$$('[role="dialog"]')).toHaveLength(1);
      fixture.assertNoBrowserErrors();
    });
  });
});
