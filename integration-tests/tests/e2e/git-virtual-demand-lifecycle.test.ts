import { describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

async function runGit(projectPath: string, args: string[]): Promise<void> {
  const process = Bun.spawn(['git', ...args], {
    cwd: projectPath,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args[0]} failed: ${stderr.trim()}`);
}

async function switchWorkspaceSurface(
  page: Page,
  commandLabel: string,
  readySelector: string,
): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }));
  });
  await page.waitForSelector('[role="dialog"][aria-label="Command palette"]');
  await page.evaluate((label) => {
    const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (button) => button.textContent?.includes(label),
    );
    if (!option) throw new Error(`Missing ${label} command.`);
    option.click();
  }, commandLabel);
  await page.waitForSelector(readySelector);
}

async function switchToGit(page: Page): Promise<void> {
  await switchWorkspaceSurface(page, 'Switch to Git', '[data-git-virtual-diff-root]');
}

async function switchToChat(page: Page): Promise<void> {
  await switchWorkspaceSurface(page, 'Switch to Chat', 'textarea[placeholder="Reply..."]');
}

async function showWorkbenchDiff(page: Page): Promise<void> {
  const isHidden = await page.$eval(
    '[data-git-diff-pane]',
    (pane) => pane.getAttribute('aria-hidden') === 'true',
  );
  if (isHidden) {
    await page.evaluate(() => {
      const button = [
        ...document.querySelectorAll<HTMLButtonElement>('[data-git-segmented-navigation] button'),
      ].find((candidate) => candidate.textContent?.trim() === 'Diff');
      if (!button) throw new Error('Missing narrow Git Diff pane control.');
      button.click();
    });
  }
  await page.waitForSelector('[data-git-diff-pane][aria-hidden="false"]');
}

describe('Lightpanda Git virtual demand lifecycle', () => {
  test('continues loading far visible rows after the retained Git surface is hidden and restored', async () => {
    await withE2eFixture('git-virtual-demand-lifecycle', async (fixture) => {
      const project = fixture.integration.dirs.project;
      await runGit(project, ['init', '-b', 'main']);
      await runGit(project, ['config', 'user.email', 'test@example.com']);
      await runGit(project, ['config', 'user.name', 'E2E Test']);
      const fileCount = 120;
      const lineCount = 30;
      await Promise.all(
        Array.from({ length: fileCount }, (_, fileIndex) => {
          const name = `file-${String(fileIndex).padStart(3, '0')}.txt`;
          const content = Array.from(
            { length: lineCount },
            (_, lineIndex) => `before ${fileIndex} line ${lineIndex}`,
          ).join('\n');
          return writeFile(join(project, name), `${content}\n`, 'utf8');
        }),
      );
      await runGit(project, ['add', '.']);
      await runGit(project, ['commit', '-m', 'base']);
      await Promise.all(
        Array.from({ length: fileCount }, (_, fileIndex) => {
          const name = `file-${String(fileIndex).padStart(3, '0')}.txt`;
          const content = Array.from(
            { length: lineCount },
            (_, lineIndex) => `after ${fileIndex} line ${lineIndex}`,
          ).join('\n');
          return writeFile(join(project, name), `${content}\n`, 'utf8');
        }),
      );

      await fixture.page.evaluateOnNewDocument(() => {
        localStorage.setItem('garcon.gitReviewDemandTrace', '1');
        const scope = globalThis as typeof globalThis & {
          __garconHoldFarGitBodyRequest?: boolean;
          __garconHeldGitBodyRequest?: {
            files: string[];
            purpose: string;
          } | null;
          __garconReleaseGitBodyRequest?: (() => void) | null;
          __garconGitBodyRequestsInFlight?: number;
          __garconHeldGitBodyCompleted?: boolean;
          __garconHeldGitBodyStatus?: number | null;
        };
        const nativeFetch = globalThis.fetch.bind(globalThis);
        scope.__garconHoldFarGitBodyRequest = false;
        scope.__garconHeldGitBodyRequest = null;
        scope.__garconReleaseGitBodyRequest = null;
        scope.__garconGitBodyRequestsInFlight = 0;
        scope.__garconHeldGitBodyCompleted = false;
        scope.__garconHeldGitBodyStatus = null;
        globalThis.fetch = (async (input, init) => {
          const url = new URL(
            input instanceof Request ? input.url : String(input),
            globalThis.location.href,
          );
          const isBodyRequest = url.pathname === '/api/v1/git/review-documents/files';
          if (isBodyRequest)
            scope.__garconGitBodyRequestsInFlight =
              (scope.__garconGitBodyRequestsInFlight ?? 0) + 1;
          let heldFarBodyRequest = false;
          try {
            if (
              scope.__garconHoldFarGitBodyRequest &&
              !scope.__garconHeldGitBodyRequest &&
              isBodyRequest &&
              typeof init?.body === 'string'
            ) {
              const body = JSON.parse(init.body) as {
                files?: unknown;
                purpose?: unknown;
              };
              const files = Array.isArray(body.files)
                ? body.files.filter((file): file is string => typeof file === 'string')
                : [];
              const hasFarFile = files.some((file) => {
                const match = /file-(\d+)\.txt$/.exec(file);
                return match ? Number(match[1]) >= 40 : false;
              });
              if (body.purpose === 'visible' && hasFarFile) {
                heldFarBodyRequest = true;
                scope.__garconHeldGitBodyRequest = {
                  files,
                  purpose: body.purpose,
                };
                await new Promise<void>((resolve) => {
                  scope.__garconReleaseGitBodyRequest = resolve;
                });
              }
            }
            const response = await nativeFetch(input, init);
            if (heldFarBodyRequest) {
              scope.__garconHeldGitBodyStatus = response.status;
              scope.__garconHeldGitBodyCompleted = true;
            }
            return response;
          } finally {
            if (isBodyRequest)
              scope.__garconGitBodyRequestsInFlight = Math.max(
                0,
                (scope.__garconGitBodyRequestsInFlight ?? 1) - 1,
              );
          }
        }) as typeof globalThis.fetch;
      });

      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('git-virtual-demand-seed');
      await app.waitForText('echo:git-virtual-demand-seed');
      await switchToGit(fixture.page);
      await showWorkbenchDiff(fixture.page);
      await fixture.page.waitForFunction(
        () => document.querySelectorAll('[data-git-virtual-row]').length > 0,
        { timeout: 20_000 },
      );

      await fixture.page.evaluate(() => {
        const viewport = document.querySelector<HTMLElement>('[data-git-virtual-diff-root]');
        if (!viewport) throw new Error('Missing Git virtual viewport.');
        viewport.scrollTop = Math.max(2_000, viewport.scrollHeight * 0.2);
        viewport.dispatchEvent(new Event('scroll'));
      });
      await fixture.page.waitForFunction(
        () =>
          Number(
            document.querySelector<HTMLElement>('[data-git-virtual-row]')?.dataset.index ?? 0,
          ) > 0,
        { timeout: 20_000 },
      );
      await fixture.page.waitForFunction(
        () => {
          const scope = globalThis as typeof globalThis & {
            __garconGitBodyRequestsInFlight?: number;
          };
          const hasLoadingPlaceholder = [
            ...document.querySelectorAll<HTMLElement>('[data-git-placeholder-row]'),
          ].some((row) => row.dataset.gitPlaceholderState === 'loading');
          return (scope.__garconGitBodyRequestsInFlight ?? 0) === 0 && !hasLoadingPlaceholder;
        },
        { timeout: 20_000 },
      );
      await fixture.page.evaluate(() => {
        const viewport = document.querySelector<HTMLElement>('[data-git-virtual-diff-root]');
        if (!viewport) throw new Error('Missing settled Git virtual viewport.');
        viewport.scrollTop = Math.max(2_000, viewport.scrollHeight * 0.2);
        viewport.dispatchEvent(new Event('scroll'));
      });
      await fixture.page.waitForFunction(
        () =>
          Number(
            document.querySelector<HTMLElement>('[data-git-virtual-row]')?.dataset.index ?? 0,
          ) > 0,
        { timeout: 20_000 },
      );
      await fixture.page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      const retainedBefore = await fixture.page.evaluate(() => {
        const viewport = document.querySelector<HTMLElement>('[data-git-virtual-diff-root]');
        const firstRow = document.querySelector<HTMLElement>('[data-git-virtual-row]');
        const spacer = document.querySelector<HTMLElement>(
          '[data-git-virtual-row-window]',
        )?.parentElement;
        return {
          scrollTop: viewport?.scrollTop ?? -1,
          firstIndex: Number(firstRow?.dataset.index ?? -1),
          spacerHeight: spacer?.style.height ?? '',
        };
      });
      expect(retainedBefore.scrollTop).toBeGreaterThan(0);
      expect(retainedBefore.firstIndex).toBeGreaterThan(0);

      await switchToChat(fixture.page);
      await fixture.page.waitForFunction(
        () =>
          document
            .querySelector('[data-git-virtual-diff-root]')
            ?.closest('[data-workspace-surface-id]')
            ?.getAttribute('aria-hidden') === 'true',
        { timeout: 20_000 },
      );
      await switchToGit(fixture.page);
      await fixture.page.waitForFunction(
        () =>
          document
            .querySelector('[data-git-virtual-diff-root]')
            ?.closest('[data-workspace-surface-id]')
            ?.getAttribute('aria-hidden') === 'false',
        { timeout: 20_000 },
      );
      await showWorkbenchDiff(fixture.page);
      const retainedAfter = await fixture.page.evaluate(() => {
        const viewport = document.querySelector<HTMLElement>('[data-git-virtual-diff-root]');
        const firstRow = document.querySelector<HTMLElement>('[data-git-virtual-row]');
        const spacer = document.querySelector<HTMLElement>(
          '[data-git-virtual-row-window]',
        )?.parentElement;
        return {
          scrollTop: viewport?.scrollTop ?? -1,
          firstIndex: Number(firstRow?.dataset.index ?? -1),
          spacerHeight: spacer?.style.height ?? '',
        };
      });
      expect(retainedAfter.scrollTop).toBe(retainedBefore.scrollTop);
      expect(retainedAfter.firstIndex).toBe(retainedBefore.firstIndex);
      expect(retainedAfter.spacerHeight).toBeTruthy();

      await fixture.page.evaluate(() => {
        const scope = globalThis as typeof globalThis & {
          __garconHoldFarGitBodyRequest?: boolean;
        };
        scope.__garconHoldFarGitBodyRequest = true;
        const viewport = document.querySelector<HTMLElement>('[data-git-virtual-diff-root]');
        if (!viewport) throw new Error('Missing restored Git virtual viewport.');
        const rowWindow = viewport.querySelector<HTMLElement>('[data-git-virtual-row-window]');
        const virtualHeight = Number.parseFloat(rowWindow?.parentElement?.style.height ?? '');
        if (!Number.isFinite(virtualHeight) || virtualHeight <= 0)
          throw new Error('Missing Git virtual spacer height.');
        viewport.scrollTop = Math.max(60_000, virtualHeight * 0.75);
        viewport.dispatchEvent(new Event('scroll'));
      });
      await fixture.page.waitForFunction(
        (previousIndex) =>
          Number(
            document.querySelector<HTMLElement>('[data-git-virtual-row]')?.dataset.index ?? 0,
          ) > previousIndex,
        { timeout: 20_000 },
        retainedAfter.firstIndex,
      );
      await fixture.page.waitForFunction(
        () =>
          Boolean(
            (
              globalThis as typeof globalThis & {
                __garconHeldGitBodyRequest?: unknown;
              }
            ).__garconHeldGitBodyRequest,
          ),
        { timeout: 20_000 },
      );
      const heldPaths = await fixture.page.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __garconHeldGitBodyRequest?: { files: string[] } | null;
            }
          ).__garconHeldGitBodyRequest?.files ?? [],
      );
      const visiblePath = heldPaths[0] ?? '';
      expect(visiblePath).toBeTruthy();
      expect(Number(/file-(\d+)\.txt$/.exec(visiblePath)?.[1])).toBeGreaterThanOrEqual(40);

      await fixture.page.evaluate(() => {
        const scope = globalThis as typeof globalThis & {
          __garconReleaseGitBodyRequest?: (() => void) | null;
        };
        const release = scope.__garconReleaseGitBodyRequest;
        if (!release) throw new Error('The far visible body request was not retained.');
        scope.__garconReleaseGitBodyRequest = null;
        release();
      });
      await fixture.page.waitForFunction(
        () =>
          Boolean(
            (
              globalThis as typeof globalThis & {
                __garconHeldGitBodyCompleted?: boolean;
              }
            ).__garconHeldGitBodyCompleted,
        ),
        { timeout: 20_000 },
      );
      const heldResponseStatus = await fixture.page.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __garconHeldGitBodyStatus?: number | null;
            }
          ).__garconHeldGitBodyStatus,
      );
      expect(heldResponseStatus).toBe(200);
      const mountedRows = await fixture.page.$$eval(
        '[data-git-virtual-row]',
        (rows) => rows.length,
      );
      expect(mountedRows).toBeLessThan(200);
      fixture.assertNoBrowserErrors();
    });
  });
});
