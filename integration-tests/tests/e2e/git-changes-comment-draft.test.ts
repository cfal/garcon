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
  const [stderr, exitCode] = await Promise.all([new Response(process.stderr).text(), process.exited]);
  if (exitCode !== 0) throw new Error(`git ${args[0]} failed: ${stderr.trim()}`);
}

describe('Lightpanda Git Changes comments', () => {
  test('appends an editable line comment to Chat without sending', async () => {
    await withE2eFixture('git-changes-comment-draft', async (fixture) => {
      const project = fixture.integration.dirs.project;
      await runGit(project, ['init', '-b', 'main']);
      await runGit(project, ['config', 'user.email', 'test@example.com']);
      await runGit(project, ['config', 'user.name', 'E2E Test']);
      await writeFile(join(project, 'change.txt'), 'before\n', 'utf8');
      await runGit(project, ['add', 'change.txt']);
      await runGit(project, ['commit', '-m', 'base']);
      await writeFile(join(project, 'change.txt'), 'after\n', 'utf8');

      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('git-changes-comment-seed');
      await app.waitForText('echo:git-changes-comment-seed');
      await fixture.page.evaluate(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'p',
            ctrlKey: true,
            bubbles: true,
          }),
        );
      });
      await fixture.page.waitForSelector('[role="dialog"][aria-label="Command palette"]');
      await fixture.page.evaluate(() => {
        const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((button) =>
          button.textContent?.includes('Switch to Git'),
        );
        if (!option) throw new Error('Missing Switch to Git command.');
        option.click();
      });
      await fixture.page.waitForSelector('[data-git-virtual-diff-root] button[aria-label="Add to chat"]', {
        timeout: 20_000,
      });
      await fixture.page.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>(
          '[data-git-virtual-diff-root] button[aria-label="Add to chat"]',
        );
        if (!button) throw new Error('Missing Changes comment affordance.');
        button.click();
      });
      await fixture.page.waitForSelector('[data-git-comment-composer] textarea');
      await app.fill('[data-git-comment-composer] textarea', 'Please verify the current change.');
      await fixture.page.evaluate(() => {
        const composer = document.querySelector('[data-git-comment-composer]');
        const button = [...(composer?.querySelectorAll('button') ?? [])].find(
          (candidate) => candidate.textContent?.trim() === 'Add to chat',
        );
        if (!button) throw new Error('Missing Changes Add to chat submit action.');
        button.click();
      });
      await app.waitForText('Added to the Chat composer.');
      await app.clickButton('Chat');
      const draft = await fixture.page.$eval(
        'textarea[placeholder="Reply..."]',
        (element) => (element as HTMLTextAreaElement).value,
      );
      expect(draft).toContain('Git review comment');
      expect(draft).toContain('Please verify the current change.');
      expect(
        fixture.integration.fakeProviders.openAi
          .requests()
          .filter((request) => request.lastUserText === 'git-changes-comment-seed'),
      ).toHaveLength(1);
      fixture.assertNoBrowserErrors();
    });
  });
});
