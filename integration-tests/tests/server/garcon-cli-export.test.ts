import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  withIntegrationFixture,
  type IntegrationFixture,
} from '../../support/integration-fixture.js';
import { claudeText, claudeToolUse } from '../../support/fake-claude-model.js';
import { LIVE_TURN_TIMEOUT_MS, waitForVisibleResponse } from '../../support/live-agent.js';
import { liveClaudeStartRequest } from '../../support/live-claude.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORKSPACE = 'cli-export';

describe('garcon-cli export', () => {
  test('[TLV5-L01.02-EXPORT-SERVER-01] exports pinned full transcripts with filtering and atomic file output', async () => {
    await withIntegrationFixture('garcon-cli-export', async (fixture) => {
      const chatId = fixture.newChatId();
      const started = await fixture.client.startDirectChat({
        chatId,
        content: 'synthetic export prompt',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      expect((await fixture.client.waitForTurnTerminal(chatId, started.turnId)).type)
        .toBe('agent-run-finished');
      const row = await runCli(fixture, [
        'add-row', chatId,
        '--type', 'notice',
        '--title', 'Synthetic checkpoint',
        'synthetic diagnostic row',
      ]);
      expect(row.exitCode).toBe(0);

      const markdown = await runCli(fixture, ['export', chatId]);
      expect(markdown.exitCode).toBe(0);
      expect(markdown.stderr).toBe('');
      expect(markdown.stdout).toContain(`# Transcript export`);
      expect(markdown.stdout).toContain('synthetic export prompt');
      expect(markdown.stdout).toContain('echo:synthetic export prompt');
      expect(markdown.stdout).toContain('synthetic diagnostic row');
      expect(markdown.stdout).toContain('## [4] Run ended');

      const filtered = await runCli(fixture, [
        'export', chatId,
        '--exclude', 'diagnostics,tools',
      ]);
      expect(filtered.exitCode).toBe(0);
      expect(filtered.stderr).toBe('');
      expect(filtered.stdout).toContain('> Omitted: diagnostics 2');
      expect(filtered.stdout).toContain('synthetic export prompt');
      expect(filtered.stdout).toContain('echo:synthetic export prompt');
      expect(filtered.stdout).not.toContain('synthetic diagnostic row');
      expect(filtered.stdout).not.toContain('## [4] Run ended');

      const outputPath = path.join(fixture.dirs.home, 'transcript.xml');
      const xml = await runCli(fixture, [
        'export', chatId,
        '--format', 'xml',
        '--exclude', 'reasoning',
        '--output', outputPath,
      ]);
      expect(xml.exitCode).toBe(0);
      expect(xml.stderr).toBe('');
      expect(xml.stdout).toContain(`chat id: ${chatId}\nformat: xml\noutput: ${outputPath}\n`);
      expect(xml.stdout).not.toContain('<transcript-export');
      const document = await readFile(outputPath, 'utf8');
      expect(document).toContain('<transcript-export version="1">');
      expect(document).toContain('<user ordinal="1"');
      expect(document).toContain('<assistant ordinal="3"');
      expect(document).not.toContain('<exclusions>');
      expect(document).not.toContain('<omitted');
      expect(document).not.toContain('category=');
      expect(document).not.toContain('timestamp=');

      const refused = await runCli(fixture, [
        'export', chatId, '--format', 'xml', '--output', outputPath,
      ]);
      expect(refused.exitCode).toBe(2);
      expect(refused.stderr).toContain('output already exists; use --force');

      const replaced = await runCli(fixture, [
        'export', chatId, '--format', 'xml', '--output', outputPath, '--force',
      ]);
      expect(replaced.exitCode).toBe(0);
      expect((await readdir(fixture.dirs.home)).filter((name) => name.includes('.garcon-export-')))
        .toEqual([]);
    }, { namedWorkspace: WORKSPACE });
  }, 30_000);

  test('filters real tool and permission lifecycle rows from a scripted provider export', async () => {
    const environment = await startScriptedClaudeTestEnvironment();
    const prompt = 'synthetic export tool prompt';
    const toolOutput = 'synthetic-export-tool-output';
    const reply = 'synthetic export tool reply';
    const command = `printf %s ${toolOutput} > .garcon-export-tool-output && cat .garcon-export-tool-output`;
    environment.model.scriptTurn([
      claudeToolUse('toolu_export_bash', 'Bash', { command }),
    ]);
    environment.model.scriptTurn([claudeText(reply)]);

    try {
      await withIntegrationFixture('garcon-cli-export-tools', async (fixture) => {
        const chatId = fixture.newChatId();
        const cursor = fixture.client.markEvents();
        const turn = await fixture.client.startChat(liveClaudeStartRequest({
          chatId,
          projectPath: fixture.dirs.project,
          command: prompt,
        }));
        const permission = await fixture.client.waitForTransientPermission(
          chatId,
          (row) => row.message.type === 'permission-request'
            && row.message.requestedTool.type === 'bash-tool-use'
            && row.message.requestedTool.command === command,
          { afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
        );
        if (permission.message.type !== 'permission-request') {
          throw new Error('Scripted Bash permission request was not found.');
        }
        expect((await fixture.client.sendPermissionDecision({
          clientRequestId: crypto.randomUUID(),
          chatId,
          permissionOccurrenceId: permission.message.permissionOccurrenceId,
          allow: true,
          alwaysAllow: false,
        })).status).toBe('accepted');
        await waitForVisibleResponse({
          fixture,
          chatId,
          turnId: turn.turnId,
          marker: reply,
          afterIndex: cursor,
        });

        const complete = await runCli(fixture, ['export', chatId, '--format', 'xml']);
        expect(complete.exitCode).toBe(0);
        expect(complete.stdout).toContain('<tool-call ');
        expect(complete.stdout).toContain('type="bash-tool-use"');
        expect(complete.stdout).toContain('<tool-result ');
        expect(complete.stdout).toContain('type="permission-request"');
        expect(complete.stdout).toContain('type="permission-resolved"');
        expect(complete.stdout).toContain(toolOutput);

        const filtered = await runCli(fixture, [
          'export', chatId, '--format', 'xml',
          '--exclude', 'tools', '--exclude', 'permissions',
        ]);
        expect(filtered.exitCode).toBe(0);
        expect(filtered.stdout).not.toContain('<exclusions>');
        expect(filtered.stdout).toContain(
          '<omitted tool-calls="1" tool-results="1" permissions="2"/>',
        );
        expect(filtered.stdout).toContain(prompt);
        expect(filtered.stdout).toContain(reply);
        expect(filtered.stdout).not.toContain(command);
        expect(filtered.stdout).not.toContain(toolOutput);
        environment.model.assertSettled();
      }, {
        namedWorkspace: WORKSPACE,
        serverEnvironment: environment.serverEnvironment,
      });
    } finally {
      environment.dispose();
    }
  }, 60_000);
});

async function runCli(
  fixture: IntegrationFixture,
  arguments_: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      'cli/main.ts',
      '--config-dir', fixture.dirs.config,
      '--workspace', WORKSPACE,
      '--server', fixture.garcon.baseUrl,
      ...arguments_,
    ],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GARCON_CONFIG_DIR: '',
      GARCON_WORKSPACE: '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
