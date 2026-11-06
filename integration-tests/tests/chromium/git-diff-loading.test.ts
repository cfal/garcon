import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import type { Page } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import {
  collapseCanonicalFilesWindow,
  clickWorkspaceWindowAddAction,
} from '../../support/chromium-workspace.js';
import { initializeFixtureRepository, runFixtureGit } from '../../support/git-fixture.js';

interface LoadingSample {
  startedAt: number;
  firstVisibleDomMs: number | null;
  visibleReadyMs: number | null;
  firstVisibleSyntaxMs: number | null;
  mountedRows: number;
  requests: Array<{ files: string[]; purpose: string }>;
  resources: Array<{ path: string; duration: number; encodedBytes: number; decodedBytes: number }>;
}

async function beginSample(page: Page, selector: string, scrollFraction?: number): Promise<void> {
  await page.evaluate(
    ({ selector, scrollFraction }) => {
      const started = performance.now();
      const sample: LoadingSample = {
        startedAt: started,
        firstVisibleDomMs: null,
        visibleReadyMs: null,
        firstVisibleSyntaxMs: null,
        mountedRows: 0,
        requests: [],
        resources: [],
      };
      const scope = window as typeof window & { gitLoadingSample?: LoadingSample };
      scope.gitLoadingSample = sample;
      if (scrollFraction !== undefined) {
        const viewport = document.querySelector<HTMLElement>(
          `${selector} [data-git-virtual-diff-root]`,
        )!;
        viewport.scrollTop = viewport.scrollHeight * scrollFraction;
      }
      const observe = () => {
        if (scope.gitLoadingSample !== sample) return;
        const viewport = document.querySelector<HTMLElement>(
          `${selector} [data-git-virtual-diff-root]`,
        );
        if (viewport && viewport.clientHeight > 0) {
          const rect = viewport.getBoundingClientRect();
          const visible = (element: Element) => {
            const box = element.getBoundingClientRect();
            return box.bottom > rect.top && box.top < rect.bottom;
          };
          const content = [...viewport.querySelectorAll('[data-git-diff-review-row]')].filter(
            visible,
          );
          const pending = [...viewport.querySelectorAll('[data-git-placeholder-row]')].some(
            visible,
          );
          if (content.length > 0) {
            sample.firstVisibleDomMs ??= performance.now() - started;
            if (!pending) sample.visibleReadyMs ??= performance.now() - started;
            if (content.some((row) => row.querySelector('.cm-code-keyword'))) {
              sample.firstVisibleSyntaxMs ??= performance.now() - started;
            }
          }
          sample.mountedRows = viewport.querySelectorAll('[data-git-virtual-row]').length;
        }
        if (sample.visibleReadyMs === null || sample.firstVisibleSyntaxMs === null)
          requestAnimationFrame(observe);
      };
      requestAnimationFrame(observe);
    },
    { selector, scrollFraction },
  );
}

async function finishSample(
  page: Page,
  requests: LoadingSample['requests'],
): Promise<LoadingSample> {
  await page.waitForFunction(() => {
    const sample = (window as typeof window & { gitLoadingSample?: LoadingSample })
      .gitLoadingSample;
    return sample?.visibleReadyMs != null && sample.firstVisibleSyntaxMs != null;
  });
  return page.evaluate((requests) => {
    const sample = (window as typeof window & { gitLoadingSample: LoadingSample }).gitLoadingSample;
    return {
      ...sample,
      requests,
      resources: performance
        .getEntriesByType('resource')
        .filter(
          (entry) => entry.startTime >= sample.startedAt && entry.name.includes('/api/v1/git/'),
        )
        .map((entry) => {
          const resource = entry as PerformanceResourceTiming;
          return {
            path: new URL(entry.name).pathname,
            duration: resource.duration,
            encodedBytes: resource.encodedBodySize,
            decodedBytes: resource.decodedBodySize,
          };
        }),
    };
  }, requests);
}

for (const executionBackend of [
  'in-process',
  'remote-controller-dials',
  'remote-executor-dials',
] as const) {
  test(`loads and navigates many highlighted Git files on ${executionBackend}`, async () => {
    await withChromiumFixture(
      `git-diff-loading-${executionBackend}`,
      async ({ page, integration }, phase) => {
        const project = integration.executionDirs.project;
        await initializeFixtureRepository(project);
        const paths = Array.from(
          { length: 240 },
          (_, index) => `file-${String(index).padStart(4, '0')}.ts`,
        );
        for (const path of paths)
          await writeFile(join(project, path), 'export const value = "before";\n');
        await runFixtureGit(project, 'add', '.');
        await runFixtureGit(project, 'commit', '-qm', 'Synthetic many-file baseline');
        for (const path of paths)
          await writeFile(join(project, path), 'export const value = "after";\n');
        const chatId = integration.newChatId();
        const started = await integration.client.startDirectChat({
          chatId,
          content: 'synthetic-git-loading',
          projectPath: project,
          agent: integration.directAgents.openAi,
        });
        await integration.client.waitForTurnTerminal(chatId, started.turnId);
        await page.setViewportSize({ width: 1920, height: 1000 });
        await page.addInitScript(
          ({ chatId, executorId }) => {
            localStorage.setItem(
              'pref_git_comparison_ranges_v1',
              JSON.stringify({
                version: 3,
                entries: [
                  {
                    chatId,
                    executorId,
                    specification: {
                      fromRevision: 'HEAD',
                      toKind: 'working-tree',
                      toRevision: 'HEAD',
                      mode: 'direct',
                    },
                  },
                ],
                projectEntries: [],
              }),
            );
          },
          { chatId, executorId: integration.client.executorId },
        );
        await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`, {
          waitUntil: 'domcontentloaded',
        });
        await collapseCanonicalFilesWindow(page);
        const requests: LoadingSample['requests'] = [];
        page.on('request', (request) => {
          if (new URL(request.url()).pathname === '/api/v1/git/review-documents/files') {
            const { files, purpose } = request.postDataJSON();
            requests.push({ files, purpose });
          }
        });
        const samples: Array<{ surface: string; phase: string; sample: LoadingSample }> = [];
        for (const [surface, action] of [
          ['git', 'Open Workbench'],
          ['git-compare', 'Open Compare'],
        ] as const) {
          phase(`loading ${surface}`);
          requests.length = 0;
          await page.evaluate(() => performance.clearResourceTimings());
          const selector = `[data-workspace-surface-id="singleton:${surface}"][aria-hidden="false"]`;
          await beginSample(page, selector);
          await clickWorkspaceWindowAddAction(page, action);
          const sample = await finishSample(page, requests);
          samples.push({ surface, phase: 'open', sample });
          expect(sample.requests[0]?.files).toEqual([paths[0]]);
          expect(sample.requests.every((request) => request.files.length <= 4)).toBe(true);
          expect(
            sample.requests
              .filter((request) => request.purpose === 'prefetch')
              .flatMap((request) => request.files).length,
          ).toBeLessThanOrEqual(2);
          expect(sample.mountedRows).toBeLessThan(200);
          const panel = page.locator(selector);
          await browserExpect(panel.locator('.cm-code-keyword').first()).toBeVisible();

          phase(`deep scrolling ${surface}`);
          const viewport = panel.locator('[data-git-virtual-diff-root]');
          requests.length = 0;
          await page.evaluate(() => performance.clearResourceTimings());
          await beginSample(page, selector, 0.75);
          const deep = await finishSample(page, requests);
          samples.push({ surface, phase: 'deep-scroll', sample: deep });
          expect(await viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(1_000);
          expect(deep.mountedRows).toBeLessThan(200);
          const selected = await viewport.evaluate((element) => {
            const viewportBounds = element.getBoundingClientRect();
            const row = [...element.querySelectorAll('[data-git-diff-review-row]')].find((row) => {
              const bounds = row.getBoundingClientRect();
              return bounds.top >= viewportBounds.top && bounds.bottom <= viewportBounds.bottom;
            });
            if (!row) throw new Error('No fully visible diff row to select.');
            const range = document.createRange();
            range.selectNodeContents(row);
            const selection = window.getSelection()!;
            selection.removeAllRanges();
            selection.addRange(range);
            return selection.toString();
          });
          expect(selected).toContain('export const value');
          await page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
              ),
          );
          expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selected);
          phase(`warm return ${surface}`);
          requests.length = 0;
          await page.evaluate(() => performance.clearResourceTimings());
          await beginSample(page, selector, 0);
          samples.push({
            surface,
            phase: 'warm-return',
            sample: await finishSample(page, requests),
          });
        }
        console.log(
          JSON.stringify({ gitDiffLoading: executionBackend, files: paths.length, samples }),
        );
      },
      undefined,
      { executionBackend, projectRoots: 'separate' },
    );
  }, 120_000);
}
