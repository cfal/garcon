import { describe, expect, test } from 'bun:test';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTicketDetail, parseTicketPage } from '../../../common/ticket-responses.js';
import { parseTicketWriteResult } from '../../../common/ticket-records.js';
import { withIntegrationFixture, type IntegrationFixture } from '../../support/integration-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

async function runCli(fixture: IntegrationFixture, args: readonly string[], body?: string) {
  const child = Bun.spawn({ cmd: [process.execPath, 'cli/main.ts', '--config-dir', fixture.dirs.config,
    '--workspace', 'integration', '--server', fixture.garcon.baseUrl, 'ticket', ...args], cwd: REPO_ROOT,
    env: { ...process.env, GARCON_CONFIG_DIR: '', GARCON_WORKSPACE: '' },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  if (body !== undefined) child.stdin.write(body);
  child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exitCode, stdout, stderr };
}

describe('ticket CLI public server integration', () => {
  test('creates with a captured folder default, shares comments and fields with HTTP, and retries after restart and directory movement', async () => {
    await withIntegrationFixture('cli-tickets', async (fixture) => {
      const create = await runCli(fixture, ['create', '--title', 'Synthetic CLI ticket', '--cwd', fixture.dirs.project, '--json']);
      expect(create.exitCode).toBe(0);
      const initial = parseTicketWriteResult(JSON.parse(create.stdout));
      expect(initial.ticket.project).toBe(fixture.dirs.project);
      expect(create.stderr).toContain('Project (folder)');
      const requestId = /^Request: (.+)$/m.exec(create.stderr)?.[1];
      expect(requestId).toBeDefined();
      const comment = await runCli(fixture, ['comment', initial.ticket.id, '--stdin', '--json'], 'Synthetic\ncomment\0tail');
      expect(comment.exitCode).toBe(0);
      expect(parseTicketWriteResult(JSON.parse(comment.stdout)).comment?.body).toBe('Synthetic\ncomment\0tail');
      const update = await runCli(fixture, ['update', initial.ticket.id, '--expected-revision', '1', '--patch', '{"title":"Current server title"}', '--json']);
      expect(update.exitCode).toBe(0);
      const current = parseTicketDetail(await fixture.client.get(`/api/v1/tickets/detail?ticketId=${initial.ticket.id}`));
      expect(current.ticket.title).toBe('Current server title');
      expect(current.comments.items).toHaveLength(1);
      await fixture.restartGarcon();
      await rename(fixture.dirs.project, join(fixture.dirs.root, 'moved-project'));
      const retried = await runCli(fixture, ['create', '--title', 'Synthetic CLI ticket', '--project', initial.ticket.project,
        '--request-id', requestId!, '--expected-store-id', initial.storeId, '--json']);
      expect(retried.exitCode).toBe(0);
      expect(parseTicketWriteResult(JSON.parse(retried.stdout))).toEqual(initial);
      const list = await runCli(fixture, ['list', '--json']);
      expect(list.exitCode).toBe(0);
      const page = parseTicketPage(JSON.parse(list.stdout));
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.title).toBe('Current server title');
    }, { namedWorkspace: 'integration' });
  });

  test('denies outside-base defaults but permits an explicit project without touching that directory', async () => {
    await withIntegrationFixture('cli-ticket-boundary', async (fixture) => {
      const denied = await runCli(fixture, ['create', '--title', 'Synthetic ticket', '--cwd', fixture.dirs.root]);
      expect(denied.exitCode).toBe(3);
      expect(denied.stdout).toBe('');
      expect(denied.stderr).toContain('TICKET_PROJECT_UNAVAILABLE');
      const explicit = await runCli(fixture, ['create', '--title', 'Synthetic ticket', '--cwd', fixture.dirs.root, '--project', 'Arbitrary group', '--json']);
      expect(explicit.exitCode).toBe(0);
      expect(parseTicketWriteResult(JSON.parse(explicit.stdout)).ticket.project).toBe('Arbitrary group');
      expect(explicit.stderr).toContain('Project (explicit)');
    }, { namedWorkspace: 'integration' });
  });
});
