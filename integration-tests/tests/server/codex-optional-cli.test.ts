import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import { rejectionOf } from '../../support/promise-assertions.js';

test('Codex auth distinguishes an absent CLI from a failed probe and uses the installed override for device login', async () => {
  await withIntegrationFixture('codex-optional-cli', async (fixture) => {
    const { client, executionDirs } = fixture;
    const query = new URLSearchParams({ executorId: client.executorId });
    const authUrl = `/api/v1/agents/auth?agent=codex&${query}`;
    expect(await client.get(authUrl)).toMatchObject({
      codex: { authenticated: false, canReauth: false, source: 'none', detail: expect.stringContaining('GARCON_CODEX_CLI') },
    });
    expect(await client.get(`/api/v1/agents/readiness?${query}`)).toMatchObject({
      codex: { nativeReady: false }, shell: { ready: true },
    });

    const chatId = fixture.newChatId();
    const cursor = client.markEvents();
    await rejectionOf(client.startChat(liveCodexStartRequest({
      chatId, projectPath: executionDirs.project, command: 'Synthetic request.',
    })));
    expect(await client.waitForTurnTerminal(chatId, undefined, { afterIndex: cursor })).toMatchObject({
      type: 'agent-run-failed', error: expect.stringContaining('GARCON_CODEX_CLI'),
    });

    const binary = join(executionDirs.home, 'selected codex');
    await writeFile(binary, '#!/bin/sh\nexit 17\n', { mode: 0o755 });
    const failedProbe = await client.fetch(authUrl);
    expect(failedProbe.status).toBeGreaterThanOrEqual(500);
    expect(await failedProbe.json()).toMatchObject({ success: false });

    await writeFile(binary, `#!/bin/sh
case "$1 $2" in
  'login status') echo 'Not logged in' >&2; exit 1 ;;
  'login --device-auth')
    printf '%s\\n' "$@" > "$HOME/device-login-args"
    printf 'https://example.invalid/device\\n  TEST-CODE\\n'
    read -r unused ;;
  *) exit 17 ;;
esac
`);
    expect(await client.get(authUrl)).toMatchObject({ codex: { authenticated: false, canReauth: true } });
    const login = await client.post('/api/v1/agents/auth/login', { agentId: 'codex', executorId: client.executorId });
    expect(login).toMatchObject({ launched: true });
    expect(await Bun.file(join(executionDirs.home, 'device-login-args')).text()).toBe('login\n--device-auth\n');
  }, {
    resolveServerEnvironment: ({ home }) => ({ GARCON_CODEX_CLI: join(home, 'selected codex'), PATH: `${home}:/usr/bin:/bin` }),
    prepareWorkspace: async ({ home }) => { await writeFile(join(home, 'codex'), '#!/bin/sh\nexit 17\n', { mode: 0o755 }); },
  });
}, 30_000);
