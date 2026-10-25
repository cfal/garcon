import { test } from 'bun:test';
import { expect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { collapseCanonicalFilesWindow } from '../../support/chromium-workspace.js';
import type { ChatListEntry, ChatListResponse } from '../../../common/chat-list.js';
import type { ExecutorSnapshot } from '../../../common/executors.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const BUILD_EXECUTOR_ID = '33333333-3333-4333-8333-333333333333';

type FixtureState = 'active' | 'inactive' | 'archived' | 'pinned';

interface FixtureChat {
  executorId: string;
  projectPath: string;
  title: string;
  ageMs: number;
  state?: FixtureState;
}

function fixtureSession(live: ChatListEntry, chat: FixtureChat, id: string): ChatListEntry {
  const state = chat.state ?? 'active';
  const orderGroup = state === 'pinned' ? 'pinned' : state === 'archived' ? 'archived' : 'normal';
  const timestamp = new Date(Date.now() - chat.ageMs).toISOString();
  return {
    ...live,
    id,
    executorId: chat.executorId,
    projectPath: chat.projectPath,
    title: chat.title,
    orderGroup,
    isPinned: orderGroup === 'pinned',
    isArchived: orderGroup === 'archived',
    isUnread: false,
    activity: { createdAt: timestamp, lastActivityAt: timestamp, lastReadAt: timestamp },
  };
}

async function rowInsets(page: Page, selector: string): Promise<number[]> {
  return page.locator(selector).evaluateAll((elements) => elements.map((element) => {
    // Headers start at their disclosure chevron; chats start at their title.
    const start = element.querySelector('svg, [data-slot="chat-summary-header"]');
    return Math.round((start ?? element).getBoundingClientRect().left);
  }));
}

test('sidebar executor hierarchy separates executors, sections, projects, and chats', async () => {
  await withChromiumFixture('sidebar-executor-hierarchy', async ({ page, context, integration, assertNoBrowserErrors }, phase) => {
    const { client, directAgents, executionDirs } = integration;
    const agent = directAgents.openAi;
    await client.patch(`/api/v1/executors/${client.executorId}`, { label: 'Studio server' });
    const projectsPath = executionDirs.project;
    const gatewayPath = join(projectsPath, 'atlas', 'atlas-service-gateway');
    await mkdir(gatewayPath, { recursive: true });
    const selectedId = integration.newChatId();
    const started = await client.startDirectChat({
      chatId: selectedId,
      content: 'Synthetic executor hierarchy fixture',
      executorId: client.executorId,
      projectPath: gatewayPath,
      agent,
    });
    await client.waitForTurnTerminal(selectedId, started.turnId);

    const listed = await client.get<ChatListResponse>('/api/v1/chats');
    const live = listed.sessions.find((chat) => chat.id === selectedId)!;
    const { executors: available } = await client.get<{ executors: ExecutorSnapshot[] }>('/api/v1/executors');
    const worker = available.find((executor) => executor.id === client.executorId)!;
    const executors: ExecutorSnapshot[] = [
      ...available,
      { ...worker, id: BUILD_EXECUTOR_ID, label: 'Build server', availability: 'offline', bulk: { availability: 'offline', lastError: null } },
    ];
    const studio = client.executorId;
    const fixtures: FixtureChat[] = [
      { executorId: 'local', projectPath: '/workspace/aurora', title: 'Plan the next release', ageMs: 2 * HOUR_MS },
      { executorId: 'local', projectPath: '/workspace/aurora', title: 'Review navigation changes', ageMs: 5 * HOUR_MS },
      { executorId: 'local', projectPath: '/workspace/notes', title: 'Team workspace notes', ageMs: 26 * HOUR_MS },
      { executorId: studio, projectPath: projectsPath, title: 'Deploy smoke check', ageMs: 20 * HOUR_MS },
      { executorId: studio, projectPath: gatewayPath, title: 'Null response logging', ageMs: DAY_MS },
      { executorId: studio, projectPath: gatewayPath, title: 'Replay architecture reference', ageMs: DAY_MS + HOUR_MS },
      { executorId: studio, projectPath: gatewayPath, title: 'Evaluate trading signal validation', ageMs: 2 * DAY_MS },
      { executorId: studio, projectPath: projectsPath, title: 'Reply with the fixture keyword', ageMs: 7 * DAY_MS, state: 'inactive' },
      { executorId: studio, projectPath: gatewayPath, title: 'Disk space status check', ageMs: 7 * DAY_MS, state: 'inactive' },
      { executorId: studio, projectPath: projectsPath, title: 'Pull request validity review', ageMs: 14 * HOUR_MS, state: 'archived' },
      { executorId: studio, projectPath: projectsPath, title: 'Friendly greeting', ageMs: 60_000, state: 'archived' },
      { executorId: BUILD_EXECUTOR_ID, projectPath: '/home/demo', title: 'Deploy smoke check', ageMs: 20 * HOUR_MS, state: 'pinned' },
      { executorId: BUILD_EXECUTOR_ID, projectPath: '/home/demo', title: 'Nightly build report', ageMs: 21 * HOUR_MS },
      { executorId: BUILD_EXECUTOR_ID, projectPath: '/home/demo/projects/ledger/unified-deposit', title: 'Order path optimization', ageMs: 60_000 },
      { executorId: BUILD_EXECUTOR_ID, projectPath: '/home/demo/projects/ledger/unified-deposit', title: 'Dependency updates', ageMs: 3 * HOUR_MS },
      { executorId: BUILD_EXECUTOR_ID, projectPath: '/home/demo/forks/unified-deposit', title: 'Compare fork changes', ageMs: 4 * HOUR_MS },
    ];
    const sessions = [
      { ...live, title: 'Feed error investigation' },
      ...fixtures.map((chat, index) => fixtureSession(live, chat, String((Date.now() - chat.ageMs) * 1000 + index))),
    ];
    // Synthetic rows reproduce a dense multi-executor workspace; the live chat stays navigable.
    const snapshot: ChatListResponse = { ...listed, sessions, total: sessions.length };
    await page.route('**/api/v1/chats', (route) => route.fulfill({ json: snapshot }));
    await page.route('**/api/v1/executors', (route) => route.fulfill({ json: { executors } }));
    await context.addInitScript(() => localStorage.setItem('pref_local_settings', JSON.stringify({
      allowDirectChats: true,
      sidebarGrouping: 'project-and-activity',
      sidebarInactivityDuration: '5-days',
      sidebarChatItemLayout: 'single-line',
      sidebarSortMode: 'recent',
    })));
    const artifacts = process.env.GARCON_SCREENSHOT_DIR
      ?? join(import.meta.dirname, '../../artifacts/chromium/sidebar-executor-hierarchy');
    await mkdir(artifacts, { recursive: true });

    phase('render desktop hierarchy');
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(`${integration.garcon.baseUrl}/chat/${selectedId}`);
    await collapseCanonicalFilesWindow(page);
    const list = page.locator('[data-workspace-chat-list]');
    await expect(page.locator('[data-sidebar-executor-header]')).toHaveCount(3);
    await expect(page.locator(`[data-sidebar-virtual-row="${selectedId}"]`)).toBeVisible();

    const executorHeader = page.locator(`[data-sidebar-executor-header="${studio}"]`);
    await expect(executorHeader).toHaveAttribute('data-sidebar-row-depth', '0');
    const projectHeader = page.locator(`[data-sidebar-project-header="${gatewayPath}"]`).first();
    await expect(projectHeader).toHaveAttribute('data-sidebar-row-depth', '1');
    await expect(projectHeader.locator('[data-sidebar-group-header-label]')).toHaveText('atlas-service-gateway');
    await expect(projectHeader.locator('[data-sidebar-project-header-parent]')).toHaveCount(0);
    await expect(projectHeader.locator('[data-sidebar-group-header-count]')).toHaveCount(0);
    // Projects that share a folder name under one executor show their parents to stay distinguishable.
    await expect(page.locator('[data-sidebar-project-header="/home/demo/forks/unified-deposit"] [data-sidebar-project-header-parent]'))
      .toHaveText('/home/demo/forks');
    await expect(page.locator('[data-sidebar-project-header="/home/demo/projects/ledger/unified-deposit"] [data-sidebar-project-header-parent]'))
      .toHaveText('/home/demo/projects/ledger');
    await expect(projectHeader).toHaveAttribute('title', `Studio server: ${gatewayPath}`);
    const sectionHeader = page.locator(`[data-sidebar-section-key="executor:${studio}:section:inactive"]`);
    await expect(sectionHeader).toHaveAttribute('data-sidebar-row-depth', '1');
    await expect(page.locator(`[data-sidebar-virtual-row="${selectedId}"]`)).toHaveAttribute('data-sidebar-row-depth', '2');

    // Children start to the right of their parent header so ownership reads left to right.
    const [executorInset] = await rowInsets(page, `[data-sidebar-executor-header="${studio}"]`);
    const [projectInset] = await rowInsets(page, `[data-sidebar-project-header="${gatewayPath}"]`);
    const [chatInset] = await rowInsets(page, `[data-sidebar-virtual-row="${selectedId}"]`);
    expect(projectInset!).toBeGreaterThan(executorInset!);
    expect(chatInset!).toBeGreaterThan(projectInset!);

    await page.mouse.move(1400, 1000);
    await page.screenshot({ path: join(artifacts, 'desktop.png') });
    await list.screenshot({ path: join(artifacts, 'sidebar.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveClass(/dark/);
    await list.screenshot({ path: join(artifacts, 'sidebar-dark.png') });
    await page.emulateMedia({ colorScheme: 'light' });

    phase('collapse and restore an executor');
    await executorHeader.click();
    await expect(executorHeader).toHaveAttribute('aria-expanded', 'false');
    await expect(executorHeader.locator('[data-sidebar-group-header-count]')).toHaveText('9');
    await expect(page.getByText('Null response logging', { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(executorHeader).toHaveAttribute('aria-expanded', 'false');
    await page.mouse.move(1400, 1000);
    await list.screenshot({ path: join(artifacts, 'sidebar-collapsed.png') });
    await executorHeader.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Null response logging', { exact: true })).toBeVisible();

    phase('render mobile hierarchy');
    await page.setViewportSize({ width: 390, height: 900 });
    await page.reload();
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Chats', exact: true });
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(`[data-sidebar-executor-header="${studio}"]`)).toBeVisible();
    await page.mouse.move(385, 5);
    await page.screenshot({ path: join(artifacts, 'mobile.png') });
    assertNoBrowserErrors();
  }, undefined, { executionBackend: 'remote-controller-dials', projectRoots: 'shared' });
}, 180_000);
