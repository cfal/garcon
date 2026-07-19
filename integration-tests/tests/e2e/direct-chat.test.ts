import { describe, expect, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';
import {
  acceptedResponseRequestBodies,
  replaceFirstAcceptedResponse,
} from '../../support/accepted-response-loss.js';

describe('Lightpanda direct chat', () => {
  test('creates a direct chat and renders one user and assistant row', async () => {
    await withE2eFixture('direct-chat', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('ui-direct-hello');
      await app.waitForText('echo:ui-direct-hello');

      expect(await app.exactTextCount('ui-direct-hello')).toBe(1);
      expect(await app.exactTextCount('echo:ui-direct-hello')).toBe(1);
      expect(fixture.integration.fakeProviders.openAi.requests().filter((request) =>
        request.lastUserText === 'ui-direct-hello')).toHaveLength(1);
      fixture.assertNoBrowserErrors();
    });
  });

  test('selects and runs a direct Anthropic chat', async () => {
    await withE2eFixture('direct-anthropic-chat', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.open();
      await fixture.waitForSpaWebSocket();
      const request = await app.startAnthropicDirectChat('ui-anthropic-hello');
      await app.waitForText('echo:ui-anthropic-hello');

      expect(request.body).toMatchObject({
        model: 'integration-anthropic-echo',
        stream: true,
      });
      expect(await app.exactTextCount('ui-anthropic-hello')).toBe(1);
		expect(await app.exactTextCount('echo:ui-anthropic-hello')).toBe(1);
		expect(fixture.integration.fakeProviders.openAi.requests()).toEqual([]);
		fixture.assertNoBrowserErrors();
    });
  });

  test('retries a lost accepted response with the same identity and executes once', async () => {
    await withE2eFixture('direct-chat-lost-response', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('ui-lost-response-seed');
      await app.waitForText('echo:ui-lost-response-seed');

      await replaceFirstAcceptedResponse(fixture.page, '/api/v1/chats/run');

      await app.sendComposer('ui-lost-response-followup');
      await app.waitForText('echo:ui-lost-response-followup');

      const interceptedBodies = await acceptedResponseRequestBodies(fixture.page);
      expect(interceptedBodies).toHaveLength(2);
      expect(interceptedBodies[1]).toMatchObject({
        clientRequestId: interceptedBodies[0].clientRequestId,
        clientMessageId: interceptedBodies[0].clientMessageId,
      });
      expect(await app.exactTextCount('ui-lost-response-followup')).toBe(1);
      expect(await app.exactTextCount('echo:ui-lost-response-followup')).toBe(1);
		expect(fixture.integration.fakeProviders.openAi.requests().filter((request) => (
			request.lastUserText === 'ui-lost-response-followup'
		))).toHaveLength(1);
		fixture.assertNoBrowserErrors();
    });
  });
});
