import { describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

describe('Lightpanda Git comparison', () => {
  test('keeps a large comparison virtualized and appends a line comment without sending', async () => {
    await withE2eFixture('git-comparison-comment', async (fixture) => {
      const project = fixture.integration.dirs.project;
      await runGit(project, ['init', '-b', 'main']);
      await runGit(project, ['config', 'user.email', 'test@example.com']);
      await runGit(project, ['config', 'user.name', 'E2E Test']);
      const shared = Array.from({ length: 1_000 }, (_, index) => `shared ${index}`).join('\n');
      const afterTail = Array.from({ length: 1_000 }, (_, index) => `after ${index}`).join('\n');
      const refreshedTail = Array.from({ length: 1_000 }, (_, index) => `refreshed ${index}`).join('\n');
      const before = `large before marker\n${shared}`;
      const after = `large after marker\n${shared}\n${afterTail}`;
      const refreshed = `large refreshed marker\n${shared}\n${refreshedTail}`;
      await writeFile(join(project, 'large.txt'), `${before}\n`, 'utf8');
      for (let index = 0; index < 9; index += 1) {
        await writeFile(join(project, `00-extra-${index}.txt`), `extra before ${index}\n`, 'utf8');
      }
      await writeFile(join(project, 'z-visible-only.txt'), 'tail before\n', 'utf8');
      await runGit(project, ['add', '.']);
      await runGit(project, ['commit', '-m', 'base']);
      await runGit(project, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
      await writeFile(join(project, 'committed.txt'), 'committed on the feature branch\n', 'utf8');
      await runGit(project, ['add', 'committed.txt']);
      await runGit(project, ['commit', '-m', 'feature']);
      await writeFile(join(project, 'large.txt'), `${after}\n`, 'utf8');
      for (let index = 0; index < 9; index += 1) {
        await writeFile(join(project, `00-extra-${index}.txt`), `extra updated ${index}\n`, 'utf8');
      }
      await writeFile(join(project, 'z-visible-only.txt'), 'tail after\n', 'utf8');

      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('git-comparison-seed');
      await app.waitForText('echo:git-comparison-seed');

			await fixture.page.evaluate(() => {
				window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }));
			});
			await fixture.page.waitForSelector('[role="dialog"][aria-label="Command palette"]');
			await fixture.page.evaluate(() => {
				const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
					.find((button) => button.textContent?.includes('Switch to Git'));
				if (!option) throw new Error('Missing Switch to Git command.');
				option.click();
			});
			await app.waitForButton('Compare revisions');
			await app.clickButton('Compare revisions');
      await fixture.page.waitForSelector('[role="dialog"][aria-label="Compare revisions"]');

      expect(await fixture.page.$eval(
        '#git-comparison-from',
        (element) => (element as HTMLInputElement).value,
      )).toBe('HEAD');
      await app.fill('#git-comparison-from', 'origin/main');
      expect(await fixture.page.$eval(
        '[role="dialog"]',
        (element) => element.textContent,
      )).toContain('staged, unstaged, untracked');
      await app.clickDialogButton('Compare');
			await fixture.page.waitForFunction(
				() => !document.querySelector('[role="dialog"][aria-label="Compare revisions"]'),
				{ timeout: 20_000 },
			);
			await fixture.page.waitForSelector('[data-git-diff-document]');
			await fixture.page.waitForFunction(
				() => document.querySelector('[data-git-diff-document]')?.getAttribute('data-git-history-layout') === 'narrow',
				{ timeout: 20_000 },
			);
			await app.fill('[data-git-history-files-pane] input[type="search"]', 'large.txt');
			await fixture.page.waitForSelector(
				'[data-git-history-files-pane] [title="large.txt"]',
			);
			await fixture.page.evaluate(() => {
				const label = document.querySelector<HTMLElement>(
					'[data-git-history-files-pane] [title="large.txt"]',
				);
				const row = label?.closest<HTMLButtonElement>('[data-git-file-list-row]');
				if (!row) throw new Error('Missing large.txt comparison row.');
				row.click();
			});
			await fixture.page.waitForSelector('[data-git-history-diff-pane][aria-hidden="false"]');
      await fixture.page.waitForSelector('[data-git-virtual-diff-root]');
			await app.waitForText('large after marker');
			const mountedRows = await fixture.page.$$eval(
        '[data-git-virtual-row]',
				(rows) => rows.length,
			);
			expect(mountedRows).toBeLessThan(300);

			await writeFile(join(project, 'large.txt'), `${refreshed}\n`, 'utf8');
			await fixture.page.waitForFunction(
				() => document.body.textContent?.includes('The Working Tree changed.'),
				{ timeout: 25_000 },
			);
			expect(await fixture.page.$eval('body', (element) => element.textContent)).toContain(
				'large after marker',
			);
			expect(await fixture.page.$eval('body', (element) => element.textContent)).not.toContain(
				'large refreshed marker',
			);
			await fixture.page.evaluate(() => {
				const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
					.find((candidate) => candidate.textContent?.trim() === 'Refresh comparison');
				if (!button) throw new Error('Missing stale comparison refresh action.');
				button.click();
			});
			await fixture.page.waitForFunction(
				() => {
					const button = document.querySelector<HTMLButtonElement>(
						'button[aria-label="Refresh comparison"]',
					);
					return Boolean(
						button &&
						!button.disabled &&
						!document.body.textContent?.includes('The Working Tree changed.'),
					);
				},
				{ timeout: 20_000 },
			);
			await app.clickButton('Files (12)');
			await app.fill('[data-git-history-files-pane] input[type="search"]', 'large.txt');
			await fixture.page.waitForSelector(
				'[data-git-history-files-pane] [title="large.txt"]',
			);
			await fixture.page.evaluate(() => {
				const label = document.querySelector<HTMLElement>(
					'[data-git-history-files-pane] [title="large.txt"]',
				);
				const row = label?.closest<HTMLButtonElement>('[data-git-file-list-row]');
				if (!row) throw new Error('Missing refreshed large.txt comparison row.');
				row.click();
			});
			await fixture.page.waitForSelector('[data-git-history-diff-pane][aria-hidden="false"]');
			await app.waitForText('large refreshed marker');
			await fixture.page.waitForFunction(
				() => {
					const button = [...document.querySelectorAll<HTMLButtonElement>(
						'button[aria-label="Add to chat"]',
					)].find((element) => !element.closest('[aria-hidden="true"]'));
					if (!button) return false;
					button.click();
					return true;
				},
				{ timeout: 20_000 },
			);
      await fixture.page.waitForSelector('[data-git-comment-composer] textarea');
      await app.fill('[data-git-comment-composer] textarea', 'Please verify this line.');
      try {
        await fixture.page.evaluate(() => {
          const button = document.querySelector<HTMLButtonElement>(
            '[data-git-comment-composer] button:last-of-type',
          );
          if (!button) throw new Error('Missing Add to chat submit action.');
          button.click();
        });
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('Promise was collected')) throw error;
      }
      expect(await fixture.page.$('[data-git-virtual-diff-root]')).not.toBeNull();

      await app.clickButton('Chat');
      await fixture.page.waitForSelector('textarea[placeholder="Reply..."]');
      const draft = await fixture.page.$eval(
        'textarea[placeholder="Reply..."]',
        (element) => (element as HTMLTextAreaElement).value,
      );
      expect(draft).toContain('Git review comment');
      expect(draft).toContain('Please verify this line.');

      expect(fixture.integration.fakeProviders.openAi.requests().filter((request) =>
        request.lastUserText === 'git-comparison-seed')).toHaveLength(1);
      fixture.assertNoBrowserErrors();
    });
  });
});
