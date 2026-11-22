import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import type { IntegrationDirectories } from '../../support/integration-fixture.js';

const PACKAGE = '@anthropic-ai/claude-code';
const INSTALLED_VERSION = '2.1.285';
const LATEST_VERSION = '2.1.300';

const toolsDirectory = (directories: IntegrationDirectories) => join(directories.root, 'cli-update-tools');
const npmPrefix = (directories: IntegrationDirectories) => join(directories.root, 'cli-update-npm-prefix');
const packageDirectory = (directories: IntegrationDirectories) => join(npmPrefix(directories), 'lib', 'node_modules', PACKAGE);
const releaseFile = (directories: IntegrationDirectories) => join(directories.root, 'cli-update-release');

test('Settings updates an outdated Claude Code CLI and reports the result', async () => {
  await withChromiumFixture('agent-cli-updates', async ({ page, integration }, phase) => {
    const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
    await mkdir(artifacts, { recursive: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(integration.garcon.baseUrl);
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    await dialog.getByRole('tab', { name: 'Providers', exact: true }).click();

    phase('reporting the outdated CLI');
    const claude = dialog.getByRole('group', { name: 'Claude Code', exact: true });
    const codex = dialog.getByRole('group', { name: 'Codex CLI', exact: true });
    await browserExpect(claude.getByText(`Update available: ${LATEST_VERSION}`)).toBeVisible();
    await browserExpect(claude.getByText(INSTALLED_VERSION, { exact: true })).toBeVisible();
    await browserExpect(codex.getByText('Garcon runs its bundled Codex CLI, which updates with Garcon.')).toBeVisible();
    await browserExpect(codex.getByRole('button', { name: 'Update', exact: true })).toHaveCount(0);
    await claude.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(artifacts, 'agent-cli-updates-available.png') });

    phase('running the update');
    await claude.getByRole('button', { name: 'Update', exact: true }).click();
    await browserExpect(claude.getByRole('button', { name: 'Updating...', exact: true })).toBeDisabled();
    await browserExpect(claude.getByRole('status')).toContainText('added 1 package');
    await page.screenshot({ path: join(artifacts, 'agent-cli-updates-running.png') });
    await writeFile(releaseFile(integration.executionDirs), 'release');

    phase('reporting the updated CLI');
    await browserExpect(claude.getByText(`Updated Claude Code to ${LATEST_VERSION}.`)).toBeVisible({ timeout: 15_000 });
    await browserExpect(claude.getByText('Up to date', { exact: true })).toBeVisible();
    await browserExpect(claude.getByText(LATEST_VERSION, { exact: true })).toBeVisible();
    await page.screenshot({ path: join(artifacts, 'agent-cli-updates-succeeded.png') });

    phase('fitting a mobile dialog');
    await page.setViewportSize({ width: 390, height: 844 });
    await claude.scrollIntoViewIfNeeded();
    const panel = dialog.getByRole('tabpanel');
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: join(artifacts, 'agent-cli-updates-mobile.png') });
  }, undefined, {
    resolveServerEnvironment: (directories) => ({
      CLAUDE_BINARY: join(npmPrefix(directories), 'bin', 'claude'),
      CLAUDE_CONFIG_DIR: join(directories.home, '.claude-isolated'),
      PATH: `${toolsDirectory(directories)}:${process.env.PATH ?? ''}`,
    }),
    async prepareWorkspace(directories) {
      const packageDir = packageDirectory(directories);
      const versionFile = join(packageDir, 'VERSION');
      await writeExecutable(join(packageDir, 'cli.sh'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "$(cat ${JSON.stringify(versionFile)}) (Claude Code)"; exit 0; fi
echo "The CLI update fixture cannot run model commands" >&2
exit 2
`);
      await writeFile(versionFile, INSTALLED_VERSION);
      await mkdir(join(npmPrefix(directories), 'bin'), { recursive: true });
      await symlink(join(packageDir, 'cli.sh'), join(npmPrefix(directories), 'bin', 'claude'));
      // Holds the install until the test releases it, so the running state can be observed.
      await writeExecutable(join(toolsDirectory(directories), 'npm'), `#!/bin/sh
case "$1" in
  view) echo '"${LATEST_VERSION}"' ;;
  install)
    echo "added 1 package in 1s"
    while [ ! -f ${JSON.stringify(releaseFile(directories))} ]; do sleep 0.05; done
    echo "${LATEST_VERSION}" > ${JSON.stringify(versionFile)} ;;
  *) echo "Unsupported npm fixture command" >&2; exit 1 ;;
esac
`);
    },
  });
}, 120_000);

async function writeExecutable(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source);
  await chmod(path, 0o755);
}
