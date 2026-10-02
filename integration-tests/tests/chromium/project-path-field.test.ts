import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { initializeFixtureRepository, runFixtureGit } from '../../support/git-fixture.js';
import type { PreamblesMutationResponse, PreamblesSnapshot } from '../../../common/preambles.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`project path field retains keyboard, pin and nested picker behavior (${executionBackend})`, async () => {
    await withChromiumFixture(`project-path-field-${executionBackend}`, async ({ page, context, integration, assertNoBrowserErrors }, phase) => {
      const project = join(integration.executionDirs.project, 'repository ');
      await mkdir(project);
      await mkdir(project.trimEnd());
      const worktree = join(project, 'feature');
      await initializeFixtureRepository(project);
      await runFixtureGit(project, 'worktree', 'add', '-b', 'feature', worktree);
      let catalog = await integration.client.get<PreamblesSnapshot>('/api/v1/preambles');
      for (const [title, projectPath] of [['Exact project', project], ['Sibling project', project.trimEnd()]]) {
        const response = await integration.client.post<PreamblesMutationResponse>('/api/v1/preambles', {
          expectedRevision: catalog.revision,
          preamble: {
            enabled: true, title, content: 'Synthetic scoped instructions',
            scope: { type: 'project-paths', rules: [{ executorId: integration.client.executorId, projectPath, includeNested: true }] },
          },
        });
        catalog = response.snapshot;
      }
      await page.goto(integration.garcon.baseUrl);
      await page.getByRole('button', { name: 'New Chat', exact: true }).first().click();
      const input = page.locator('#project-path-input');
      const field = page.locator('[data-slot="project-path-field"]');
      await browserExpect(input).toBeVisible();
      if (executionBackend !== 'in-process') {
        await page.getByRole('dialog').locator('[data-executor-picker]').click();
        await page.getByRole('menuitemradio', { name: 'Integration worker', exact: true }).click();
      }
      await input.fill(project);
      const prompt = page.getByPlaceholder('How can I help you today?');
      await browserExpect(field.locator('.text-status-success-foreground')).toBeVisible();
      await input.press('Enter');
      await browserExpect(prompt).toBeFocused();
      const inputBounds = (await input.boundingBox())!;
      await page.mouse.click(inputBounds.x + inputBounds.width - 12, inputBounds.y + inputBounds.height / 2);
      await browserExpect(input).toBeFocused();
      await input.press('Enter');
      await browserExpect(prompt).toBeFocused();
      await browserExpect(page.getByRole('dialog', { name: 'Select Directory', exact: true })).toHaveCount(0);

      phase('pin the owning executor path');
      await page.getByRole('button', { name: 'Pin project path', exact: true }).click();
      await browserExpect(page.getByRole('button', { name: 'Unpin project path', exact: true })).toHaveAttribute('aria-busy', 'false');
      await browserExpect(input).not.toHaveAttribute('readonly');
      await browserExpect(page.getByRole('dialog').getByRole('button', { name: project, exact: true })).toBeVisible();

      phase('preamble eligibility distinguishes the spaced project from its sibling');
      const assertExactPreambleScope = async () => {
        await page.locator('[data-slot="new-chat-preambles-configure"]').click();
        const selection = page.locator('[data-slot="new-chat-preamble-selection-dialog"]');
        await browserExpect(selection.getByRole('switch', { name: 'Remove Exact project', exact: true })).toBeEnabled();
        await browserExpect(selection.getByRole('switch', { name: 'Add Sibling project', exact: true })).toBeDisabled();
        await selection.locator('[data-slot="new-chat-preamble-cancel"]').click();
      };
      await assertExactPreambleScope();

      phase('nested picker Escape leaves the new-chat form open');
      await page.getByRole('button', { name: 'Select a different worktree', exact: true }).click();
      const picker = page.getByRole('dialog', { name: 'Select worktree', exact: true });
      await browserExpect(picker.getByRole('option', { name: /feature/ })).toBeVisible();
      await page.keyboard.press('Escape');
      await browserExpect(picker).toHaveCount(0);
      await browserExpect(input).toHaveValue(project);

      phase('worktree selection updates only the draft');
      await page.getByRole('button', { name: 'Select a different worktree', exact: true }).click();
      await picker.getByRole('option', { name: /feature/ }).click();
      await browserExpect(input).toHaveValue(worktree);
      await input.press('Enter');
      await browserExpect(prompt).toBeFocused();
      expect((await integration.client.listChats()).sessions).toEqual([]);
      await assertExactPreambleScope();

      phase('desktop and touch geometry');
      const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
      await mkdir(artifacts, { recursive: true });
      const cdp = await context.newCDPSession(page);
      for (const width of [1440, 768, 390]) {
        const touch = width < 1000;
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: touch });
        await page.setViewportSize({ width, height: 900 });
        if (touch) {
          expect(await input.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
        }
        expect(await field.evaluate(element => {
          const feedback = element.nextElementSibling!;
          return feedback.getBoundingClientRect().top - element.getBoundingClientRect().bottom;
        })).toBe(4);
        expect(await field.evaluate(element => {
          const fieldBounds = element.getBoundingClientRect();
          const controls = [...element.firstElementChild!.children]
            .filter(child => child.checkVisibility({ checkVisibilityCSS: true }))
            .map(child => child.getBoundingClientRect());
          return controls.every((rect, index) => {
            const fitsWithinField = rect.left >= fieldBounds.left && rect.right <= fieldBounds.right + 1;
            if (!fitsWithinField) return false;
            return controls.slice(index + 1).every(other => {
              const horizontallySeparated = rect.right <= other.left || other.right <= rect.left;
              const verticallySeparated = rect.bottom <= other.top || other.bottom <= rect.top;
              return horizontallySeparated || verticallySeparated;
            });
          });
        })).toBe(true);
        await page.screenshot({ path: join(artifacts, `project-path-field-${executionBackend}-${width}.png`) });
      }
      await cdp.detach();
      assertNoBrowserErrors();
    }, undefined, { executionBackend, projectRoots: 'separate' });
  }, 120_000);
}
