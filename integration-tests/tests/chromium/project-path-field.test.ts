import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { initializeFixtureRepository, runFixtureGit } from '../../support/git-fixture.js';
import type { PreamblesMutationResponse, PreamblesSnapshot } from '../../../common/preambles.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`project worktree selection retains keyboard, pin and nested picker behavior (${executionBackend})`, async () => {
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
      await integration.client.put('/api/v1/app/settings', { paths: integration.client.executorId === 'local'
        ? { recentProjectPaths: [project], pinnedProjectPaths: [] }
        : { byExecutor: { [integration.client.executorId]: { recentPaths: [project], pinnedPaths: [], defaultPath: project } } },
      });
      await page.goto(integration.garcon.baseUrl);
      await page.getByRole('button', { name: 'New Chat', exact: true }).first().click();
      const landing = page.getByRole('dialog', { name: 'New Chat', exact: true });
      const projectCard = landing.getByRole('button', { name: integration.client.executorId === 'local' ? project : `Integration worker: ${project}`, exact: true });
      await projectCard.focus();
      await page.keyboard.press('Enter');
      const field = landing.getByRole('region', { name: 'Worktrees', exact: true });
      const primary = field.getByRole('radio', { name: /main.*Main checkout/ });
      await browserExpect(primary).toBeChecked();
      const prompt = landing.getByPlaceholder('How can I help you today?');
      await browserExpect(prompt).toBeFocused();
      await prompt.fill('Preserve this worktree draft');
      await browserExpect(landing.locator('#project-path-input')).toHaveCount(0);

      phase('pin the owning executor path');
      await page.getByRole('button', { name: 'Pin project path', exact: true }).click();
      await browserExpect(page.getByRole('button', { name: 'Unpin project path', exact: true })).toHaveAttribute('aria-busy', 'false');
      await browserExpect(landing.getByRole('button', { name: 'Choose project', exact: true })).toBeEnabled();
      await browserExpect(projectCard).toHaveAttribute('aria-pressed', 'true');

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
      await browserExpect(primary).toBeChecked();

      phase('worktree selection updates only the draft');
      await page.getByRole('button', { name: 'Select a different worktree', exact: true }).click();
      await picker.getByRole('option', { name: /feature/ }).click();
      const feature = field.getByRole('radio', { name: /feature/ });
      await browserExpect(feature).toBeChecked();
      await browserExpect(prompt).toHaveValue('Preserve this worktree draft');
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
        await browserExpect.poll(() => field.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        for (const radio of await field.getByRole('radio').all()) {
          expect((await radio.locator('..').boundingBox())!.height).toBeGreaterThanOrEqual(64);
        }
        await page.screenshot({ path: join(artifacts, `project-path-field-${executionBackend}-${width}.png`) });
      }
      await cdp.detach();
      assertNoBrowserErrors();
    }, undefined, { executionBackend, projectRoots: 'separate' });
  }, 120_000);
}
