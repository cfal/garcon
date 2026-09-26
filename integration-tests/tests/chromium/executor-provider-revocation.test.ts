import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('remote provider revocation preserves composer text and attachments until explicit resubmission', async () => {
  await withChromiumFixture('remote-provider-revocation', async ({ page, integration, assertNoBrowserErrors }, phase) => {
    const { client, directAgents, fakeProviders } = integration;
    const agent = directAgents.openAi;
    await client.put(`/api/v1/api-providers?id=${agent.provider.providerId}`, {
      endpoint: { id: agent.provider.endpointId, supportsImages: true },
    });
    const chatId = integration.newChatId();
    const initial = await client.startDirectChat({
      chatId, content: 'Synthetic initial remote input', projectPath: integration.dirs.project, agent,
    });
    await client.waitForTurnTerminal(chatId, initial.turnId);
    await client.waitForProcessing(chatId, false);
    phase('opening a remote composer with an image draft');
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    const composer = page.getByPlaceholder('Reply...', { exact: true });
    const send = page.getByRole('button', { name: 'Send message', exact: true });
    const content = 'Synthetic preserved remote draft';
    await composer.fill(content);
    await browserExpect(send).toBeEnabled();
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const attachments = page.locator('input[type="file"]');
    await browserExpect(attachments).toHaveAttribute('accept', /image\/\*/);
    await attachments.setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: image });
    const attachment = page.getByRole('button', { name: 'Remove attachment synthetic.png', exact: true });
    await browserExpect(attachment).toBeVisible();
    await browserExpect(send).toBeEnabled();
    const requests: unknown[] = [];
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/api/v1/chats/run') requests.push(request.postDataJSON());
    });
    const modelRequests = fakeProviders.openAi.requests().length;
    const assignment = `/api/v1/api-provider-assignments?executorId=${client.executorId}&apiProviderId=${agent.provider.providerId}`;
    phase('revoking the remote assignment with an unsent image draft');
    await client.delete(assignment);
    await browserExpect(page.getByText('The selected provider or model is unavailable on this executor.', { exact: true })).toBeVisible();
    await browserExpect(send).toBeDisabled();
    await composer.press('Enter');
    await composer.press('Control+Enter');
    await browserExpect(composer).toHaveValue(content);
    await browserExpect(attachment).toBeVisible();
    expect(requests).toEqual([]);
    expect(fakeProviders.openAi.requests()).toHaveLength(modelRequests);
    phase('regranting without automatically sending the retained draft');
    await client.put(assignment, {});
    await browserExpect(send).toBeEnabled();
    expect(requests).toEqual([]);
    await browserExpect(composer).toHaveValue(content);
    await browserExpect(attachment).toBeVisible();
    await send.click();
    const received = await fakeProviders.openAi.waitForRequest({ lastUserText: content });
    const message = received.body.messages.findLast(entry => entry.role === 'user');
    expect(message?.content).toEqual([
      { type: 'text', text: content },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${image.toString('base64')}` } },
    ]);
    expect(requests).toHaveLength(1);
    expect(fakeProviders.openAi.requests()).toHaveLength(modelRequests + 1);
    await browserExpect(attachment).toHaveCount(0);
    await browserExpect(composer).toHaveValue('');
    assertNoBrowserErrors();
  }, undefined, { executionBackend: 'remote-controller-dials' });
}, 120_000);
