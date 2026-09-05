import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { canonicalWorkspaceSnapshot } from '../../../web/src/lib/workspace/canonical-layout.js';
import { reduceWorkspaceLayout } from '../../../web/src/lib/workspace/workspace-layout.svelte.js';
import { serializeWorkspaceLayout } from '../../../web/src/lib/workspace/layout-schema.js';
import { collectWindowNodes } from '../../../web/src/lib/workspace/window-tree.js';
import {
  portableSingletonDescriptor,
  type WorkspaceWindowId,
} from '../../../web/src/lib/workspace/surface-types.js';
import { parseTerminalStreamServerMessage } from '../../../common/terminal.js';
import { withTimeout } from '../../support/deferred.js';

declare global {
  interface Window {
    capacityInputToPaintMs: number | null;
  }
}

async function initializeCapacityProject(project: string): Promise<void> {
  await writeFile(
    join(project, 'capacity.txt'),
    'Synthetic capacity editor fixture.\n'.repeat(1000),
  );
  for (const args of [
    ['init'],
    ['config', 'user.name', 'Fixture'],
    ['config', 'user.email', 'fixture@example.test'],
    ['add', '.'],
    ['commit', '-m', 'Synthetic baseline'],
  ]) {
    const command = Bun.spawn(['git', ...args], {
      cwd: project,
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const [exitCode, stderr] = await Promise.all([
      command.exited,
      new Response(command.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(stderr);
  }
}

test('opens generic commands as tabs when compact geometry blocks new windows', async () => {
  await withChromiumFixture(
    'workspace-compact-generic-placement',
    async (fixture) => {
      const { page, integration } = fixture;
      await initializeCapacityProject(integration.dirs.project);
      const chatId = integration.newChatId();
      const started = await integration.client.startDirectChat({
        chatId,
        content: 'Synthetic compact placement fixture',
        projectPath: integration.dirs.project,
        agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(chatId, started.turnId);
      await page.setViewportSize({ width: 800, height: 900 });
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`, {
        waitUntil: 'domcontentloaded',
      });
      await page.locator('[data-workspace-compact="true"]').waitFor();
      const currentWindow = page.locator('[data-workspace-window-current="true"]');
      const windowId = await currentWindow.getAttribute('data-workspace-window-id');

      for (const [command, surfacePrefix] of [
        ['Switch to Git', 'singleton:git'],
        ['New terminal', 'terminal:'],
      ] as const) {
        await page.keyboard.press('Control+p');
        await page.getByRole('combobox').fill(command);
        await page.getByRole('option', { name: command }).click();
        await page.waitForFunction(
          ({ id, prefix }) =>
            document
              .querySelector(`[data-workspace-window-id="${id}"]`)
              ?.getAttribute('data-workspace-window-active-surface')
              ?.startsWith(prefix),
          { id: windowId, prefix: surfacePrefix },
        );
        expect(await page.locator('[data-workspace-window-id]').count()).toBe(2);
        expect(await currentWindow.getAttribute('data-workspace-window-id')).toBe(
          windowId,
        );
        expect(
          await page
            .getByText('Not enough space to split this window.', { exact: true })
            .count(),
        ).toBe(0);
      }
      await page.locator('.xterm-helper-textarea').waitFor({ state: 'attached' });
      fixture.assertNoBrowserErrors();
    },
    undefined,
    { serverEnvironment: { GARCON_TERMINAL_SHELL: '/bin/sh' } },
  );
}, 60_000);

function capacityLayout(count: number, chatIds: string[]) {
  let snapshot = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
    { type: 'close-window', windowId: 'window-files' },
    { type: 'set-window-chat', windowId: 'window-main', chatId: chatIds[0]! },
  ]);
  const columns = count / 2;
  const columnIds: WorkspaceWindowId[] = ['window-main'];
  for (let index = 1; index < columns; index++) {
    const windowId: WorkspaceWindowId = `window-column-${index}`;
    snapshot = reduceWorkspaceLayout(snapshot, [
      {
        type: 'open-chat-in-new-window',
        chatId: chatIds[0]!,
        targetWindowId: columnIds[index - 1]!,
        edge: 'right',
        newWindowId: windowId,
        partitionId: `partition-column-${index}`,
      },
      {
        type: 'set-partition-ratio',
        partitionId: `partition-column-${index}`,
        ratio: 1 / (columns - index + 1),
      },
    ]);
    columnIds.push(windowId);
  }
  for (const [index, windowId] of columnIds.entries()) {
    snapshot = reduceWorkspaceLayout(snapshot, [
      {
        type: 'open-chat-in-new-window',
        chatId: chatIds[0]!,
        targetWindowId: windowId,
        edge: 'bottom',
        newWindowId: `window-row-${index}`,
        partitionId: `partition-row-${index}`,
      },
    ]);
  }
  const windows = collectWindowNodes(snapshot.desktopRoot);
  for (const [index, window] of windows.entries()) {
    if (index < count - 3) {
      snapshot = reduceWorkspaceLayout(snapshot, [
        {
          type: 'set-window-chat',
          windowId: window.id,
          chatId: chatIds[index]!,
        },
      ]);
    } else if (index < count - 1) {
      const surface = portableSingletonDescriptor(index === count - 3 ? 'files' : 'git');
      snapshot = reduceWorkspaceLayout(snapshot, [
        { type: 'register-surface', surface, windowId: window.id },
        { type: 'remove-surface', surfaceId: window.tabs.activeId },
        {
          type: 'activate-window-tab',
          windowId: window.id,
          surfaceId: surface.id,
        },
      ]);
    }
  }
  // The final window is created through the UI, exercising real admission above four.
  snapshot = reduceWorkspaceLayout(snapshot, [
    { type: 'close-window', windowId: windows.at(-1)!.id },
  ]);
  return {
    persisted: serializeWorkspaceLayout(snapshot),
    anchor: windows.at(-2)!.id,
  };
}

for (const count of [4, 6, 8]) {
  test(`retains and exercises ${count} populated workspace windows`, async () => {
    await withChromiumFixture(
      `workspace-capacity-${count}`,
      async (fixture, markPhase) => {
        const { page, integration } = fixture;
        await page.addInitScript(() => {
          window.capacityInputToPaintMs = null;
          document.addEventListener(
            'pointerdown',
            () => {
              const started = performance.now();
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  window.capacityInputToPaintMs = performance.now() - started;
                }),
              );
            },
            { capture: true },
          );
        });
        const project = integration.dirs.project;
        await initializeCapacityProject(project);
        let output = '';
        let terminalReady!: () => void;
        const terminalEcho = new Promise<void>((resolve) => {
          terminalReady = resolve;
        });
        page.on('websocket', (socket) =>
          socket.on('framereceived', ({ payload }) => {
            const message = parseTerminalStreamServerMessage(
              JSON.parse(payload.toString()),
            );
            if (message?.type !== 'terminal-output') return;
            output = (output + message.data).slice(-8192);
            if (output.includes('capacity-terminal-ready\r\n')) terminalReady();
          }),
        );
        await page.setViewportSize({ width: 2560, height: 1440 });
        markPhase('populating independent conversations');
        const chatIds: string[] = [];
        for (let chatIndex = 0; chatIndex < count - 3; chatIndex++) {
          const chatId = integration.newChatId();
          chatIds.push(chatId);
          for (let turn = 0; turn < 24; turn++) {
            const content =
              `capacity-${chatIndex}-${turn}\n` +
              Array.from(
                { length: 12 },
                (_, line) =>
                  `Synthetic example ${line}: a deterministic paragraph for transcript rendering.`,
              ).join('\n');
            const accepted =
              turn === 0
                ? await integration.client.startDirectChat({
                    chatId,
                    content,
                    projectPath: integration.dirs.project,
                    agent: integration.directAgents.openAi,
                  })
                : await integration.client.runDirectChat({
                    chatId,
                    content,
                    agent: integration.directAgents.openAi,
                  });
            await integration.client.waitForTurnTerminal(chatId, accepted.turnId);
          }
        }
        const { persisted, anchor } = capacityLayout(count, chatIds);
        await page.addInitScript((layout) => {
          if (!localStorage.getItem('capacity-seeded')) {
            localStorage.setItem('workspace_layout_v2', JSON.stringify(layout));
            localStorage.setItem('capacity-seeded', 'true');
          }
        }, persisted);
        await page.goto(`${integration.garcon.baseUrl}/chat/${chatIds[0]}`, {
          waitUntil: 'domcontentloaded',
        });
        await page.locator('[data-chat-scroll-viewport]').first().waitFor();
        await page
          .locator(`[data-workspace-window-titlebar="${anchor}"]`)
          .click({ position: { x: 20, y: 3 } });
        markPhase('creating the final window through automatic directional placement');
        await page.keyboard.press('Control+p');
        await page.getByRole('combobox').fill('New terminal');
        await page.getByRole('option', { name: /New terminal/i }).click();
        await page.waitForFunction(
          (expected) =>
            document.querySelectorAll('[data-workspace-window-id]').length === expected,
          count,
        );
        await page.locator('.xterm-helper-textarea').waitFor({ state: 'attached' });
        const terminalInput = page.locator('.xterm-helper-textarea');
        await terminalInput.focus();
        await page.keyboard.type('printf "capacity-terminal-ready\\n"');
        await page.keyboard.press('Enter');
        await withTimeout(terminalEcho, 10_000, () => 'Terminal did not echo input.');

        const hostSize = await page
          .locator('.workspace-host-region')
          .evaluate((element) => {
            const { width, height } = element.getBoundingClientRect();
            return { width, height };
          });
        expect(hostSize).toEqual({ width: 2240, height: 1440 });
        const dimensions = await page
          .locator('[data-workspace-window-id]')
          .evaluateAll((windows) =>
            windows.map((element) => {
              const { width, height } = element.getBoundingClientRect();
              return { width, height };
            }),
          );
        expect(
          dimensions.every(({ width, height }) => width >= 360 && height >= 240),
        ).toBe(true);
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Performance.enable');
        await cdp.send('HeapProfiler.collectGarbage');
        const beforeMetrics = await cdp.send('Performance.getMetrics');

        await page
          .locator(
            `[data-file-tree-row] [role="rowheader"][title="${join(project, 'capacity.txt')}"]`,
          )
          .locator('..')
          .click();
        const editor = page.locator('.cm-content[contenteditable="true"]');
        await editor.waitFor();
        await editor.fill('Unsaved synthetic capacity edit');

        markPhase('cycling populated tiled windows while a conversation is processing');
        const held = integration.fakeProviders.openAi.holdNext({
          lastUserText: 'capacity-processing',
        });
        const turn = await integration.client.runDirectChat({
          chatId: chatIds[0]!,
          content: 'capacity-processing',
          agent: integration.directAgents.openAi,
        });
        await held.received;
        const windowIds = await page
          .locator('[data-workspace-window-id]')
          .evaluateAll((windows) =>
            windows.map((window) => window.getAttribute('data-workspace-window-id')!),
          );
        const samples: number[] = [];
        const paintSamples: number[] = [];
        try {
          for (let iteration = 0; iteration < 100; iteration++) {
            const windowId = windowIds[iteration % count]!;
            await page.evaluate(() => {
              window.capacityInputToPaintMs = null;
            });
            const started = performance.now();
            await page
              .locator(`[data-workspace-window-titlebar="${windowId}"]`)
              .click({ position: { x: 20, y: 3 } });
            await page.waitForFunction(
              (id) =>
                document
                  .querySelector(`[data-workspace-window-id="${id}"]`)
                  ?.getAttribute('data-workspace-window-current') === 'true',
              windowId,
            );
            samples.push(performance.now() - started);
            await page.waitForFunction(() => window.capacityInputToPaintMs !== null);
            paintSamples.push(await page.evaluate(() => window.capacityInputToPaintMs!));
          }
        } finally {
          held.releaseEcho();
          await integration.client.waitForTurnTerminal(chatIds[0]!, turn.turnId);
        }

        markPhase('retaining compact navigation identity, focus, and drafts');
        await page
          .locator('[data-workspace-window-titlebar="window-main"]')
          .click({ position: { x: 20, y: 3 } });
        await page
          .locator('textarea[placeholder="Reply..."]')
          .fill('capacity draft retained');
        await page.setViewportSize({ width: 800, height: 900 });
        await page.locator('[data-workspace-compact="true"]').waitFor();
        const next = page.getByRole('button', { name: 'Next window' });
        await next.evaluate((element) => {
          element.setAttribute('data-capacity-retained', 'true');
        });
        await next.focus();
        for (let index = 0; index < count * 2; index++) {
          await page.keyboard.press('Enter');
          await page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
              ),
          );
          await page.waitForFunction(
            () =>
              document.activeElement?.getAttribute('data-capacity-retained') === 'true',
          );
        }
        expect(
          await page
            .locator('[data-workspace-window-current="true"]')
            .getAttribute('data-workspace-window-id'),
        ).toBe('window-main');
        expect(await page.locator('textarea[placeholder="Reply..."]').inputValue()).toBe(
          'capacity draft retained',
        );
        expect(await page.locator('[data-capacity-retained="true"]').count()).toBe(1);
        await page.setViewportSize({ width: 2560, height: 1440 });
        await page.waitForFunction(
          () =>
            !document.querySelector('[data-workspace-single-window-projection="true"]'),
        );
        expect(await page.locator('[data-workspace-window-id]:visible').count()).toBe(
          count,
        );
        expect(await editor.textContent()).toContain('Unsaved synthetic capacity edit');
        await editor.focus();
        await page.keyboard.press('Control+s');
        await page.locator('[aria-label="Unsaved"]').waitFor({ state: 'hidden' });
        const stressMetrics = await cdp.send('Performance.getMetrics');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(
          (expected) =>
            document.querySelectorAll(
              '[data-workspace-window-id]:not([aria-hidden="true"])',
            ).length === expected,
          count,
        );
        expect(
          await page
            .locator('[data-workspace-window-id]')
            .evaluateAll((windows) =>
              windows.map((window) => window.getAttribute('data-workspace-window-id')),
            ),
        ).toEqual(windowIds);
        await cdp.send('HeapProfiler.collectGarbage');
        const afterMetrics = await cdp.send('Performance.getMetrics');
        const values = Object.fromEntries(
          afterMetrics.metrics.map(({ name, value }) => [name, value]),
        );
        expect(values.JSHeapUsedSize).toBeLessThan(768 * 1024 * 1024);
        expect(values.Nodes).toBeLessThan(100_000);
        samples.sort((a, b) => a - b);
        paintSamples.sort((a, b) => a - b);
        const report = {
          count,
          browser: fixture.browser.version(),
          hostSize,
          dimensions,
          p50ClickToCurrentMs: samples[49],
          p95ClickToCurrentMs: samples[94],
          p95InputToPaintMs: paintSamples[94],
          paintSamples,
          samples,
          beforeMetrics: beforeMetrics.metrics,
          stressMetrics: stressMetrics.metrics,
          afterMetrics: afterMetrics.metrics,
        };
        await mkdir(join(import.meta.dir, '../../artifacts/chromium'), {
          recursive: true,
        });
        await writeFile(
          join(
            import.meta.dir,
            `../../artifacts/chromium/workspace-capacity-${count}.json`,
          ),
          JSON.stringify(report, null, 2),
        );
        console.log(
          `Workspace capacity ${count}: heap=${Math.round(values.JSHeapUsedSize! / 1048576)}MiB nodes=${values.Nodes} p95-input-to-paint=${Math.round(paintSamples[94]!)}ms automation-p95=${Math.round(samples[94]!)}ms`,
        );
        fixture.assertNoBrowserErrors();
      },
      undefined,
      { serverEnvironment: { GARCON_TERMINAL_SHELL: '/bin/sh' } },
    );
  }, 180_000);
}
