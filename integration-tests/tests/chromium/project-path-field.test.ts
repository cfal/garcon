import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { measureDialogHeightChange, pauseDialogResize } from '../../support/dialog-resize.js';
import { initializeFixtureRepository, runFixtureGit } from '../../support/git-fixture.js';
import type { PreamblesMutationResponse, PreamblesSnapshot } from '../../../common/preambles.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`project path field retains keyboard, pin and nested picker behavior (${executionBackend})`, async () => {
    await withChromiumFixture(`project-path-field-${executionBackend}`, async ({ page, context, integration, assertNoBrowserErrors, consumeExpectedBrowserErrors }, phase) => {
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
      await browserExpect(input).toBeFocused();
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
        await browserExpect(selection).toBeHidden();
      };
      await assertExactPreambleScope();

      phase('nested picker Escape leaves the new-chat form open');
      const worktreeButton = field.getByRole('button', { name: 'Select a different worktree', exact: true });
      await prompt.focus();
      // Activates the opener without the implicit mouse focus some browsers supply.
      await worktreeButton.dispatchEvent('click');
      const picker = page.getByRole('dialog', { name: 'Select worktree', exact: true });
      await browserExpect(picker.getByRole('option', { name: /feature/ })).toBeVisible();
      await page.keyboard.press('Escape');
      await browserExpect(picker).toHaveCount(0);
      await browserExpect(input).toHaveValue(project);
      await browserExpect(worktreeButton).toBeFocused();

      phase('worktree selection updates only the draft');
      await page.getByRole('button', { name: 'Select a different worktree', exact: true }).click();
      if (executionBackend === 'in-process') {
        const create = picker.getByRole('button', { name: 'New worktree', exact: true });
        await browserExpect(create).toBeEnabled();
        const resize = await create.evaluateHandle(pauseDialogResize);
        await page.getByRole('dialog', { name: 'New worktree', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
        await browserExpect.poll(() => resize.evaluate(animation => animation.playState)).toBe('idle');
        await resize.dispose();
        await page.getByRole('button', { name: 'Select a different worktree', exact: true }).click();
      }
      const validation = Promise.withResolvers<void>();
      await page.route('**/api/v1/chats/validate-start?**', async route => {
        await validation.promise;
        await route.continue();
      }, { times: 1 });
      try {
        await picker.getByRole('option', { name: /feature/ }).click();
        await browserExpect(input).toHaveValue(worktree);
        await browserExpect(picker).toHaveCount(0);
        await browserExpect(prompt).toBeFocused();
      } finally {
        validation.resolve();
      }
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
        const link = field.getByRole('button', { name: 'Select a different worktree' });
        const { leftOffset, verticalGap } = await link.evaluate(button => {
          const path = button.closest('[data-slot="project-path-field"]')!.querySelector('input')!.getBoundingClientRect();
          const bounds = button.getBoundingClientRect();
          return { leftOffset: bounds.left - path.left, verticalGap: bounds.top - path.bottom };
        });
        expect(Math.abs(leftOffset)).toBeLessThan(1);
        expect(verticalGap).toBe(4);
        expect(await field.evaluate(element => {
          const fieldBounds = element.getBoundingClientRect();
          const controls = [...element.querySelectorAll('input, button')]
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
        await page.screenshot({ animations: 'disabled', path: join(artifacts, `project-path-field-${executionBackend}-${width}.png`) });
      }
      await cdp.detach();

      phase('explicit name generation creates only on confirmation');
      await prompt.fill('Synthetic worktree naming task');
      let requests = 0;
      await page.route('**/api/v1/git/generate-name', async route => {
        requests++;
        expect(route.request().postDataJSON()).toEqual({ description: 'Synthetic worktree naming task', previousName: '' });
        await route.fulfill({ json: { name: 'picker-review' } });
      });
      await page.getByRole('button', { name: 'Select a different worktree', exact: true }).click();
      const newWorktree = picker.getByRole('button', { name: 'New worktree', exact: true });
      if (executionBackend === 'in-process') {
        await browserExpect(newWorktree).toBeEnabled();
        const { before, middle, after } = await newWorktree.evaluate(measureDialogHeightChange);
        expect(middle).toBeLessThan(before);
        expect(middle).toBeGreaterThan(after);
      } else {
        await newWorktree.click();
      }
      const create = page.getByRole('dialog', { name: 'New worktree', exact: true });
      const name = create.getByRole('textbox', { name: /branch name/i });
      await browserExpect(name).toHaveValue('');
      expect(requests).toBe(0);
      await create.getByRole('button', { name: 'Generate name' }).click();
      await browserExpect(name).toHaveValue('picker-review');
      await browserExpect(input).toHaveValue(worktree);
      if (executionBackend === 'remote-controller-dials') {
        phase('the same executor reconnects without discarding the create draft');
        const { client } = integration;
        const location = create.getByRole('textbox', { name: 'Location' });
        const base = create.getByRole('textbox', { name: 'Base ref' });
        const submit = create.getByRole('button', { name: 'Create worktree' });
        await create.getByRole('button', { name: 'Advanced' }).click();
        const chosenPath = join(project, '.worktrees', 'picker-review');
        await location.fill(chosenPath);
        await base.fill('main');
        await client.patch(`/api/v1/executors/${client.executorId}`, { enabled: false });
        await browserExpect(submit).toBeDisabled();
        await browserExpect(name).toHaveValue('picker-review');
        await client.patch(`/api/v1/executors/${client.executorId}`, { enabled: true });
        await browserExpect(submit).toBeEnabled({ timeout: 30_000 });
        await browserExpect(location).toHaveValue(chosenPath);
        await browserExpect(base).toHaveValue('main');
      }
      if (executionBackend === 'in-process') {
        for (const width of [390, 1440]) {
          await page.setViewportSize({ width, height: 900 });
          await browserExpect(create.getByRole('button', { name: 'Create worktree' })).toBeInViewport();
          await page.screenshot({ animations: 'disabled', path: join(artifacts, `worktree-create-${width}.png`) });
        }
        phase('keyboard retry after a destination conflict');
        await create.getByRole('button', { name: 'Advanced' }).click();
        const location = create.getByRole('textbox', { name: 'Location' });
        await location.fill(worktree);
        await name.press('Enter');
        await browserExpect(create.getByRole('alert')).toContainText('already registered');
        await browserExpect(name).toBeFocused();
        await location.fill('');
        consumeExpectedBrowserErrors(['console.error: Failed to load resource: the server responded with a status of 409 (Conflict)']);
      }
      await create.getByRole('button', { name: 'Create worktree' }).click();
      await browserExpect(input).toHaveValue(join(project, '.worktrees', 'picker-review'));
      await browserExpect(prompt).toBeFocused();
      expect(requests).toBe(1);
      assertNoBrowserErrors();
    }, undefined, { executionBackend, projectRoots: 'separate' });
  }, 120_000);
}
