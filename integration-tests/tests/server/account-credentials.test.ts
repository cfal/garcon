import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { AuthSessionResponse } from '../../../common/auth.js';
import type { TerminalCreateResponse, TerminalListResponse } from '../../../common/terminal.js';
import type { PrimaryWsServerMessage } from '../../../common/ws-protocol.js';
import type { TicketBootstrap, TicketDetail, TicketWriteResult } from '../../../common/tickets.js';
import { webSocketProtocolsForAuth } from '../../../common/ws-auth.js';
import { discoverRuntime } from '../../../cli/discovery.js';
import { CLI_SERVER_INSTANCE_HEADER } from '../../../common/server-runtime.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { GarconTestClient } from '../../support/garcon-client.js';
import { GarconProcess } from '../../support/garcon-process.js';

for (const backend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`credential rotation preserves tickets, shells, and running execution (${backend})`, async () => {
    await withIntegrationFixture(`account-credentials-${backend}`, async fixture => {
      const credentials = fixture.garcon.credentials!;
      const originalToken = fixture.garcon.authToken!;
      let token = originalToken;
      let baseUrl = fixture.garcon.baseUrl;
      const request = (path: string, method = 'GET', body?: unknown, bearer = token) => fetch(`${baseUrl}${path}`, {
        method, headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const bootstrap = await fixture.client.get<TicketBootstrap>('/api/v1/tickets/bootstrap');
      const create = { requestId: crypto.randomUUID(), expectedStoreId: bootstrap.storeId,
        payload: { action: 'create', input: { title: 'Synthetic credential ticket', project: 'Project',
          assignee: { kind: 'user', ownerKey: credentials.username } } } };
      const created = await fixture.client.post<TicketWriteResult>('/api/v1/tickets/mutate', create);
      await fixture.client.post('/api/v1/tickets/mutate', { requestId: crypto.randomUUID(), expectedStoreId: bootstrap.storeId,
        payload: { action: 'comment', ticketId: created.ticket.id, body: 'Synthetic retained comment' } });

      const executorId = fixture.client.executorId;
      if (executorId !== 'local') await fixture.client.patch(`/api/v1/executors/${executorId}`, { allowControllerCli: true });
      const inventory = await fixture.client.get<TerminalListResponse>(`/api/v1/terminals?executorId=${executorId}`);
      const { terminal } = await fixture.client.post<TerminalCreateResponse>('/api/v1/terminals', {
        executorId, expectedTerminalRuntimeId: inventory.terminalRuntimeId,
        requestId: 'credential-shell', requestedInitialWorkingDirectory: fixture.executionDirs.project,
      });
      const chatId = fixture.newChatId();
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'Synthetic credential continuity' });
      const turn = await fixture.client.startDirectChat({ chatId, content: 'Synthetic credential continuity',
        projectPath: fixture.executionDirs.project, agent: fixture.directAgents.openAi });
      await held.received;

      const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws', webSocketProtocolsForAuth(originalToken));
      await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = reject; });
      const retired = new Promise<CloseEvent>(resolve => { socket.onclose = resolve; });
      let replacement: GarconTestClient | null = null;
      try {
        for (const [operation, input] of [
          ['username', { currentPassword: credentials.password, username: 'owner-after' }],
          ['password', { currentPassword: credentials.password, newPassword: 'synthetic-password-after' }],
        ] as const) {
          const previous = token;
          const response = await request(`/api/v1/auth/${operation}`, 'PATCH', input);
          expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
          const changed = await response.json() as AuthSessionResponse;
          expect(changed.user).toEqual({ id: credentials.username, username: 'owner-after' });
          token = changed.token;
          expect((await request('/api/v1/auth/user', 'GET', undefined, previous)).status).toBe(401);
          await replacement?.close();
          replacement = await GarconTestClient.connect(baseUrl, { authToken: token, executorId });
          await replacement.ping();
          expect(await (await request('/api/v1/tickets/mutate', 'POST', create)).json()).toEqual(created);
          const detail = await replacement.get<TicketDetail>(`/api/v1/tickets/detail?ticketId=${created.ticket.id}`);
          expect(detail.ticket.assignee).toEqual({ kind: 'user', ownerKey: credentials.username });
          expect(detail.comments.items[0]).toMatchObject({ canEdit: true, author: { username: credentials.username } });
          const retained = await replacement.get<TerminalListResponse>(`/api/v1/terminals?executorId=${executorId}`);
          expect(retained.terminalRuntimeId).toBe(inventory.terminalRuntimeId);
          expect(retained.terminals[0]).toMatchObject({ terminalId: terminal.terminalId, processStatus: 'running' });
          const attachmentId = crypto.randomUUID();
          replacement.sendTerminal({ type: 'terminal-attach', terminalId: terminal.terminalId, attachmentId,
            attachmentEpoch: retained.attachmentEpoch, clientId: 'synthetic-owner', afterSequence: 0, intent: 'restore' });
          await replacement.waitForEvent((message): message is Extract<PrimaryWsServerMessage, { type: 'terminal-attached' }> =>
            message.type === 'terminal-attached' && message.attachmentId === attachmentId, 'same shell reattachment');
          const marker = `verified-${operation}`;
          replacement.sendTerminal({ type: 'terminal-input', terminalId: terminal.terminalId, attachmentId,
            data: `printf '${marker}\\n'\r` });
          await replacement.waitForEvent((message): message is Extract<PrimaryWsServerMessage, { type: 'terminal-output' }> =>
            message.type === 'terminal-output' && message.attachmentId === attachmentId && message.data.includes(marker), 'same shell output');
        }
        expect((await retired).code).toBe(4001);
        for (const login of [credentials, { username: 'owner-after', password: credentials.password }]) {
          expect((await request('/api/v1/auth/login', 'POST', login)).status).toBe(401);
        }
        expect((await request('/api/v1/auth/login', 'POST', { username: 'owner-after', password: 'synthetic-password-after' })).status).toBe(200);
        const connection = await discoverRuntime({ configDir: fixture.executionDirs.config,
          runtime: executorId === 'local' ? 'controller' : 'executor' });
        const cliFetch = (path: string, method = 'GET', body?: unknown) => fetch(`${connection.baseUrl}${path}`, {
          method, headers: { Authorization: `Bearer ${connection.localCapability}`, 'Content-Type': 'application/json',
            [CLI_SERVER_INSTANCE_HEADER]: connection.instanceId },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const listed = await cliFetch(`/api/v1/tickets?assignee=user:${credentials.username}`);
        const listBody = await listed.json() as { items: unknown[] };
        expect(listed.status, JSON.stringify(listBody)).toBe(200);
        expect(listBody.items).toHaveLength(1);
        expect((await cliFetch('/api/v1/auth/password', 'PATCH', { currentPassword: 'synthetic-password-after', newPassword: 'forbidden-password' })).status)
          .toBe(403);
        held.releaseEcho();
        await replacement!.waitForTurnTerminal(chatId, turn.turnId!);
        await replacement!.close(); replacement = null;

        await fixture.garcon.stop();
        const restarted = await GarconProcess.start({ repoRoot: fileURLToPath(new URL('../../..', import.meta.url)),
          configDir: fixture.dirs.config, workspaceDir: fixture.dirs.workspace, projectDir: fixture.dirs.project,
          homeDir: fixture.dirs.home, authentication: 'existing' });
        try {
          baseUrl = restarted.baseUrl;
          expect(await (await request('/api/v1/auth/user')).json()).toEqual({ user: { id: credentials.username, username: 'owner-after' } });
          expect((await request('/api/v1/auth/user', 'GET', undefined, originalToken)).status).toBe(401);
        } finally { await restarted.stop(); }
      } finally { held.releaseEcho(); socket.close(); await replacement?.close(); }
    }, { executionBackend: backend, serverEnvironment: { GARCON_TERMINAL_SHELL: '/bin/sh' } });
  }, 120_000);
}
