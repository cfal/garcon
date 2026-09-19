import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

test('simultaneous Local and remote panels never use the selected chat for file links', async () => {
  await withE2eFixture('execution-node-panel-files', async (fixture) => {
    const { client, directAgents, dirs } = fixture.integration;
    await writeFile(join(dirs.project, 'panel-file.txt'), 'Synthetic controller file');
    const chats = [];
    for (const nodeId of ['local', client.nodeId]) {
      const chatId = fixture.integration.newChatId();
      const started = await client.startChat({
        ...client.directStartRequest({ chatId, content: '[Panel file](./panel-file.txt)', projectPath: dirs.project, agent: directAgents.openAi }),
        nodeId,
      });
      await client.waitForTurnTerminal(chatId, started.turnId);
      chats.push(chatId);
    }
    const [localId, remoteId] = chats;
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.setViewport(1_440, 900);
    await app.openChat(remoteId);
    await fixture.waitForSpaWebSocket();
    const remoteWindow = await app.currentWorkspaceWindowId();
    await app.openSidebarChatInNewWindowById(localId);
    await app.waitForSelectedChat(localId);

    const fileRequests: string[] = [];
    fixture.page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/v1/files')) fileRequests.push(request.url());
    });
    const fileLink = (chatId: string) => `[data-conversation-panel-chat-id="${chatId}"] [data-chat-message-type="assistant-message"] a[href="./panel-file.txt"]`;
    await fixture.page.waitForSelector(fileLink(remoteId));
    await fixture.page.$eval(fileLink(remoteId), (element) => (element as HTMLElement).click());
    expect(fileRequests).toEqual([]);
    expect(await fixture.page.$('[data-file-view-session]')).toBeNull();

    await app.focusWorkspaceWindow(remoteWindow);
    await app.waitForSelectedChat(remoteId);
    await fixture.page.waitForSelector(fileLink(localId));
    await fixture.page.$eval(fileLink(localId), (element) => (element as HTMLElement).click());
    await app.waitForText('Synthetic controller file');
    expect(fileRequests.length).toBeGreaterThan(0);
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'remote-controller-dials' });
}, 60_000);
