import { expect, test } from 'bun:test';
import type { ApiProviderManagement } from '../../../common/api-providers.js';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

test('provider settings support offline grants and independent profiles; remote edits preserve composer input', async () => {
  await withE2eFixture('provider-assignments-browser', async (fixture) => {
    const { client, directAgents } = fixture.integration;
    const node = await client.post<{ id: string }>('/api/v1/execution-nodes', { label: 'Offline worker', direction: 'node-connects' });
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.open();
    await fixture.waitForSpaWebSocket();
    await app.startOpenAiDirectChat('Synthetic assigned browser input');
    await app.waitForChatProcessing(false);
    await app.fill('textarea[placeholder="Reply..."]', 'Synthetic preserved draft');
    const providerId = directAgents.openAi.provider.providerId;
    const assignment = `/api/v1/api-provider-assignments?nodeId=local&apiProviderId=${providerId}`;
    await client.delete(assignment);
    await app.waitForText('The selected provider or model is unavailable on this node.');
    expect(await fixture.page.$eval('textarea[placeholder="Reply..."]', (element) => (element as HTMLTextAreaElement).value)).toBe('Synthetic preserved draft');
    const requests = fixture.integration.fakeProviders.openAi.requests().length;
    await fixture.page.$eval('textarea[placeholder="Reply..."]', (element) => {
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(fixture.integration.fakeProviders.openAi.requests()).toHaveLength(requests);
    expect(await fixture.page.$eval('button[aria-label="Send message"]', (element) => (element as HTMLButtonElement).disabled)).toBe(true);
    await client.put(assignment, {});
    await app.waitForButtonEnabled('Send message');
    await app.submitComposerWithEnter('Synthetic preserved draft', 'Send message');
    await app.waitForChatProcessing(false);
    await app.waitForText('echo:Synthetic preserved draft');

    await app.clickButton('More actions');
    await app.waitForMenuItemEnabled('Settings');
    await app.clickMenuItem('Settings');
    await app.waitForText('Integration Fake OpenAI');
    await fixture.page.$eval(`[data-api-provider-id="${providerId}"]`, (element) => {
      const label = [...element.querySelectorAll('label')].find((item) => item.textContent?.trim() === 'Offline worker');
      if (!label) throw new Error('Missing offline assignment');
      label.querySelector<HTMLInputElement>('input')!.click();
    });
    await fixture.page.waitForFunction((id) => {
      const fieldset = document.querySelector<HTMLFieldSetElement>(`[data-api-provider-id="${id}"] fieldset`);
      const label = [...fieldset?.querySelectorAll('label') ?? []]
        .find((item) => item.textContent?.trim() === 'Offline worker');
      return fieldset && !fieldset.disabled && label?.querySelector<HTMLInputElement>('input')?.checked;
    }, {}, providerId);
    expect((await client.get<ApiProviderManagement>('/api/v1/api-providers')).assignments.assignments[node.id]).toContain(providerId);
    await app.clickButton('Duplicate Integration Fake OpenAI');
    await fixture.page.waitForSelector('#api-provider-label');
    expect(await fixture.page.$eval('#api-provider-api-key', (element) => (element as HTMLInputElement).value)).toBe('');
    await app.fill('#api-provider-label', 'Independent account');
    await app.fill('#api-provider-api-key', 'synthetic-independent-key');
    await app.clickButton('Save', { last: true });
    await fixture.page.waitForFunction(() => document.querySelector('#api-provider-label') === null);
    const management = await client.get<ApiProviderManagement>('/api/v1/api-providers');
    const duplicate = management.providers.find((profile) => profile.label === 'Independent account')!;
    expect(duplicate.id).not.toBe(providerId);
    expect(management.assignments.assignments.local).toContain(duplicate.id);
    expect(management.assignments.assignments[node.id]).not.toContain(duplicate.id);
    await app.clickButton('Delete Independent account');
    await app.clickButton('Delete shared profile');
    await fixture.page.waitForFunction((id) => document.querySelector(`[data-api-provider-id="${id}"]`) === null, {}, duplicate.id);
    await app.clickDialogButton('Close');
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'in-process' });
}, 60_000);
