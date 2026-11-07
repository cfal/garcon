import { expect } from 'bun:test';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect as browserExpect } from 'playwright/test';
import type { ChromiumFixture } from './chromium-fixture.js';
import { collapseCanonicalFilesWindow } from './chromium-workspace.js';
import { claudeText, claudeToolUse } from './fake-claude-model.js';
import { liveClaudeRunRequest, liveClaudeStartRequest } from './live-claude.js';
import type { ScriptedClaudeTestEnvironment } from './scripted-claude.js';
import { appendDisplayHistory } from './transcript-display-fixture.js';
import { DISPLAY_FEED, observeDisplayWire, waitForDisplayIdle } from './transcript-display-browser.js';

export async function verifyCombinedAppend(
  { page, integration }: ChromiumFixture,
  environment: ScriptedClaudeTestEnvironment,
  browser: 'chromium' | 'webkit',
  width: number,
) {
  await page.setViewportSize({ width, height: 900 });
  const chatId = integration.newChatId();
  environment.model.scriptTurn([claudeText('Synthetic initial answer')]);
  const started = await integration.client.startChat(liveClaudeStartRequest({ chatId,
    projectPath: integration.dirs.project, command: 'Synthetic combined append setup', permissionMode: 'bypassPermissions' }));
  await integration.client.waitForTurnTerminal(chatId, started.turnId);
  await integration.restartGarcon({ beforeStart: async () => {
    await appendDisplayHistory(integration.dirs.workspace, chatId, 100);
  } });
  const wire = await observeDisplayWire(page);
  await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
  if (width >= 1024) await collapseCanonicalFilesWindow(page);
  await waitForDisplayIdle(page);

  const edit = (index: number) => claudeToolUse(`synthetic-write-${index}`, 'Write', {
    file_path: join(integration.dirs.project, `synthetic-${index}.txt`), content: `Synthetic file ${index}\n`,
  });
  environment.model.scriptTurn([edit(1), edit(2)]);
  const third = environment.model.scriptHeldTurn([edit(3)]);
  const completion = environment.model.scriptHeldTurn([claudeText('Synthetic final answer')]);
  try {
    const turn = await integration.client.runChat(liveClaudeRunRequest({ chatId,
      command: 'Write three synthetic files', permissionMode: 'bypassPermissions' }));
    await third.requested;
    const feed = page.locator(DISPLAY_FEED);
    const group = feed.locator('[data-chat-tool-group]');
    await browserExpect(group).toHaveCount(1);
    await browserExpect(group).toHaveText('Edit 2 files');
    await waitForDisplayIdle(page);
    await browserExpect(group).toBeInViewport();
    await browserExpect(feed).toHaveAttribute('data-chat-pinned-to-bottom', 'true');
    expect(await feed.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    const artifacts = join(import.meta.dirname, '../artifacts', browser);
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: join(artifacts, `combined-append-${width}-before.png`) });
    await feed.evaluate(element => {
      const group = element.querySelector('[data-chat-tool-group]')!;
      const rows = [...element.querySelectorAll('[data-chat-virtual-item]')].map(node => ({
        node, top: node.getBoundingClientRect().top, height: node.getBoundingClientRect().height,
        text: node.textContent, growing: node.contains(group),
      }));
      const scrollTop = element.scrollTop, scrollHeight = element.scrollHeight;
      const capture = { active: true, frames: 0, failures: [] as string[], labels: [] as string[] };
      Object.assign(window, { __combinedAppend: capture });
      const sample = () => {
        if (!capture.active) return;
        capture.frames++;
        const label = group.textContent?.trim() ?? '';
        if (capture.labels.at(-1) !== label) capture.labels.push(label);
        if (element.getAttribute('data-chat-pinned-to-bottom') !== 'true') capture.failures.push('Lost bottom-follow intent');
        if (Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) > 1) capture.failures.push('Left the bottom edge');
        if (Math.abs(element.scrollTop - scrollTop) > 1 || Math.abs(element.scrollHeight - scrollHeight) > 1)
          capture.failures.push(`Scroll geometry moved: ${scrollTop}/${scrollHeight} -> ${element.scrollTop}/${element.scrollHeight}`);
        if (element.querySelector('[data-chat-tool-group]') !== group) capture.failures.push('Replaced the combined row');
        if (element.querySelectorAll('[data-chat-virtual-item]').length !== rows.length) capture.failures.push('Changed the rendered row count');
        if (element.querySelector('[data-transcript-page-boundary="later"]')) capture.failures.push('Flashed later history');
        for (const row of rows) {
          const rect = row.node.getBoundingClientRect();
          if (!row.node.isConnected) capture.failures.push('Replaced a resident row');
          if (Math.abs(rect.top - row.top) > 1 || Math.abs(rect.height - row.height) > 1) capture.failures.push('Moved a resident row');
          if (!row.growing && row.node.textContent !== row.text) capture.failures.push('Changed another row');
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    third.release();
    await completion.requested;
    await browserExpect(group).toHaveText('Edit 3 files');
    await waitForDisplayIdle(page);
    await browserExpect(group).toBeInViewport();
    const capture = await page.evaluate(() => {
      const capture = (window as unknown as { __combinedAppend: { active: boolean; frames: number; failures: string[]; labels: string[] } }).__combinedAppend;
      capture.active = false;
      return capture;
    });
    await page.screenshot({ path: join(artifacts, `combined-append-${width}-after.png`) });
    expect(capture.frames).toBeGreaterThan(10);
    expect(capture.labels).toEqual(['Edit 2 files', 'Edit 3 files']);
    expect(capture.failures).toEqual([]);
    for (const index of [1, 2, 3]) expect(await readFile(join(integration.dirs.project, `synthetic-${index}.txt`), 'utf8')).toBe(`Synthetic file ${index}\n`);
    completion.release();
    await integration.client.waitForTurnTerminal(chatId, turn.turnId);
    await browserExpect(feed.getByText('Synthetic final answer', { exact: true })).toBeVisible();
    await waitForDisplayIdle(page);
    await browserExpect(feed).toHaveAttribute('data-chat-pinned-to-bottom', 'true');
    expect(await feed.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(1);
    await wire.settle();
    expect(wire.bodies().filter(row => row.message.type === 'write-tool-use' || row.message.type === 'tool-result')).toEqual([]);
    expect(wire.requests).not.toContain('/api/v1/chats/messages');
    expect(wire.requests).not.toContain('/api/v1/chats/transcript-display/members');
    environment.model.assertSettled();
  } finally { third.release(); completion.release(); }
}
