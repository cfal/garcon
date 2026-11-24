import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { measureDialogHeightChange, pauseDialogResize } from '../../support/dialog-resize.js';
import { initializeFixtureRepository, runFixtureGit } from '../../support/git-fixture.js';
import type { PreamblesMutationResponse, PreamblesSnapshot } from '../../../common/preambles.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`project worktree selection retains keyboard, pin and nested picker behavior (${executionBackend})`, async () => {
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
      await integration.client.put('/api/v1/app/settings', { paths: integration.client.executorId === 'local'
        ? { recentProjectPaths: [project], pinnedProjectPaths: [] }
        : { byExecutor: { [integration.client.executorId]: { pinnedPaths: [project] } } },
      });
      await page.goto(integration.garcon.baseUrl);
      const landing = page.getByRole('dialog', { name: 'New Chat', exact: true });
      await browserExpect(landing).toBeVisible();
      const projectCard = landing.getByRole('button', { name: integration.client.executorId === 'local' ? project : `Integration worker: ${project}`, exact: true });
      await projectCard.focus();
      await page.keyboard.press('Enter');
      const field = landing.getByRole('region', { name: 'Worktrees', exact: true });
      const primary = field.getByRole('radio', { name: /^main/ });
      await browserExpect(primary).toBeChecked();
      const prompt = landing.getByPlaceholder('How can I help you today?');
      await browserExpect(prompt).toBeFocused();
      await prompt.fill('Preserve this worktree draft');
      await browserExpect(landing.locator('#project-path-input')).toHaveCount(0);

      phase('pin the owning executor path');
      const projectActions = projectCard.locator('..').getByRole('button', { name: /^Project actions:/ });
      if (integration.client.executorId !== 'local') {
        await projectActions.click();
        await page.getByRole('menuitem', { name: 'Unpin', exact: true }).click();
        await browserExpect(projectActions).toHaveAttribute('aria-busy', 'false');
        await browserExpect(projectCard.getByRole('img', { name: 'Pinned', exact: true })).toHaveCount(0);
      }
      await projectActions.click();
      await page.getByRole('menuitem', { name: 'Pin', exact: true }).click();
      await browserExpect(projectActions).toHaveAttribute('aria-busy', 'false');
      await browserExpect(projectCard.getByRole('img', { name: 'Pinned', exact: true })).toBeVisible();
      await browserExpect(landing.getByRole('button', { name: 'Choose folder', exact: true })).toBeEnabled();
      await browserExpect(projectCard).toHaveAttribute('aria-pressed', 'true');

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

      phase('nested folder browser Escape leaves the new-chat form open');
      await landing.getByRole('button', { name: 'Choose folder', exact: true }).click();
      const picker = landing.getByRole('dialog', { name: 'Select Directory', exact: true });
      await browserExpect(picker.locator('[aria-current="location"]')).toHaveText(basename(integration.executionDirs.project));
      await browserExpect(picker.getByRole('button', { name: 'feature', exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await browserExpect(picker).toHaveCount(0);
      await browserExpect(landing).toBeVisible();
      await browserExpect(primary).toBeChecked();

      phase('worktree selection updates only the draft');
      const feature = field.getByRole('radio', { name: /feature/ });
      await feature.click();
      await browserExpect(feature).toBeChecked();
      await browserExpect(prompt).toHaveValue('Preserve this worktree draft');
      const worktreePicker = page.getByRole('dialog', { name: 'Select worktree', exact: true });
      if (executionBackend === 'in-process') {
        await field.getByRole('button', { name: 'New worktree', exact: true }).click();
        const create = worktreePicker.getByRole('button', { name: 'New worktree', exact: true });
        await browserExpect(create).toBeEnabled();
        const resize = await create.evaluateHandle(pauseDialogResize);
        await page.getByRole('dialog', { name: 'New worktree', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
        await browserExpect.poll(() => resize.evaluate(animation => animation.playState)).toBe('idle');
        await resize.dispose();
        await page.keyboard.press('Escape');
        await browserExpect(worktreePicker).toHaveCount(0);
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
          const enterPath = landing.getByRole('button', { name: 'Enter path', exact: true });
          if (await enterPath.isVisible()) await enterPath.click();
          expect(await landing.getByRole('textbox', { name: 'Project Path', exact: true }).evaluate(element =>
            parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
        }
        await browserExpect.poll(() => field.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        for (const radio of await field.getByRole('radio').all()) {
          await browserExpect.poll(async () => (await radio.locator('..').boundingBox())!.height).toBe(44);
        }
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
      await field.getByRole('button', { name: 'New worktree', exact: true }).click();
      const newWorktree = worktreePicker.getByRole('button', { name: 'New worktree', exact: true });
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
      await browserExpect(feature).toBeChecked();
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
      await browserExpect(field.getByRole('radio', { name: /picker-review/ })).toBeChecked();
      expect(requests).toBe(1);
      assertNoBrowserErrors();
    }, undefined, { executionBackend, projectRoots: 'separate' });
  }, 120_000);
}
