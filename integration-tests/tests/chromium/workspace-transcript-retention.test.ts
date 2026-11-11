import { expect, test } from 'bun:test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { canonicalWorkspaceSnapshot } from '../../../web/src/lib/workspace/canonical-layout.js';
import { reduceWorkspaceLayout } from '../../../web/src/lib/workspace/workspace-layout.svelte.js';
import { serializeWorkspaceLayout } from '../../../web/src/lib/workspace/layout-schema.js';

test('updates an idle visible chat without a snapshot refetch after hidden-cache churn', async () => {
  await withChromiumFixture('workspace-visible-transcript-retention', async ({ page, integration }, markPhase) => {
    markPhase('creating more conversations than the hidden and disk caches retain');
    const chatIds: string[] = [];
    for (let index = 0; index < 28; index++) {
      const chatId = integration.newChatId();
      chatIds.push(chatId);
      const started = await integration.client.startDirectChat({
        chatId,
        content: `retention-fixture-${index}`,
        projectPath: integration.dirs.project,
        agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(chatId, started.turnId);
    }
    const idleChatId = chatIds[0]!;
    const snapshot = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
      { type: 'close-window', windowId: 'window-files' },
      { type: 'set-window-chat', windowId: 'window-main', chatId: idleChatId },
      {
        type: 'open-chat-in-new-window',
        chatId: chatIds[1]!,
        targetWindowId: 'window-main',
        edge: 'right',
        newWindowId: 'window-switching',
        partitionId: 'partition-switching',
      },
    ]);
    await page.addInitScript((layout) => {
      localStorage.setItem('workspace_layout_v2', JSON.stringify(layout));
    }, serializeWorkspaceLayout(snapshot));
    await page.setViewportSize({ width: 1920, height: 2160 });
    await page.goto(`${integration.garcon.baseUrl}/chat/${idleChatId}`, {
      waitUntil: 'domcontentloaded',
    });
    const idlePanel = page.locator('[data-conversation-panel="chat-view:window-main"]');
    const switchingPanel = page.locator('[data-conversation-panel="chat-view:window-switching"]');
    await idlePanel.getByText('echo:retention-fixture-0', { exact: true }).waitFor();
    await switchingPanel.getByText('echo:retention-fixture-1', { exact: true }).waitFor();
    await page.waitForFunction(
      (chatId) => localStorage.getItem(`chat_snapshot_${chatId}`) !== null,
      idleChatId,
    );
    await page.locator('[data-workspace-window-titlebar="window-switching"]')
      .click({ position: { x: 20, y: 3 } });

    markPhase('switching the second pane while the first stays visible and idle');
    for (let index = 2; index < chatIds.length; index++) {
      const chatId = chatIds[index]!;
      await page.locator(`[data-sidebar-virtual-row="${chatId}"]`).click();
      await switchingPanel.getByText(`echo:retention-fixture-${index}`, { exact: true }).waitFor();
      await page.waitForFunction(
        (id) => localStorage.getItem(`chat_snapshot_${id}`) !== null,
        chatId,
      );
    }
    // Disk fallback must not mask eviction of the idle panel's in-memory base.
    expect(await page.evaluate(
      (chatId) => localStorage.getItem(`chat_snapshot_${chatId}`), idleChatId,
    )).toBeNull();
    expect(await page.locator('[data-workspace-window-id]').count()).toBe(2);
    await idlePanel.getByText('echo:retention-fixture-0', { exact: true }).waitFor();

    const snapshotReads: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (!/\/chats\/(?:combined-)?messages$/.test(url.pathname)) return;
      const chatId = request.method() === 'POST'
        ? request.postDataJSON()?.chatId
        : url.searchParams.get('chatId');
      if (chatId === idleChatId) snapshotReads.push(url.pathname);
    });
    markPhase('applying live messages to the idle panel without recovery');
    const updated = await integration.client.runDirectChat({
      chatId: idleChatId,
      content: 'retention-live-update',
      agent: integration.directAgents.openAi,
    });
    await integration.client.waitForTurnTerminal(idleChatId, updated.turnId);
    await idlePanel.getByText('echo:retention-live-update', { exact: true }).waitFor();
    expect(snapshotReads).toEqual([]);
  });
}, 180_000);
