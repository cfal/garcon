import { expect, test } from 'bun:test';
import type { AuthSessionResponse } from '../../../common/auth.js';
import type { TerminalCreateResponse, TerminalListResponse } from '../../../common/terminal.js';
import { webSocketProtocolsForAuth } from '../../../common/ws-auth.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { GarconTestClient } from '../../support/garcon-client.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`logout revokes only the browser session and preserves execution (${executionBackend})`, async () => {
    await withIntegrationFixture(`browser-logout-${executionBackend}`, async fixture => {
      const base = fixture.garcon.baseUrl;
      const original = fixture.garcon.authToken!;
      const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fixture.garcon.credentials) });
      const other = await login.json() as AuthSessionResponse;
      const device = await GarconTestClient.connect(base, { authToken: other.token, executorId: fixture.client.executorId });
      const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws', webSocketProtocolsForAuth(original));
      try {
        await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = reject; });
        const executorId = fixture.client.executorId;
        const inventory = await fixture.client.get<TerminalListResponse>(`/api/v1/terminals?executorId=${executorId}`);
        const { terminal } = await fixture.client.post<TerminalCreateResponse>('/api/v1/terminals', {
          executorId, expectedTerminalRuntimeId: inventory.terminalRuntimeId, requestId: 'logout-shell',
          requestedInitialWorkingDirectory: fixture.executionDirs.project,
        });
        const chatId = fixture.newChatId();
        const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'Synthetic logout continuity' });
        try {
          const turn = await fixture.client.startDirectChat({ chatId, content: 'Synthetic logout continuity',
            projectPath: fixture.executionDirs.project, agent: fixture.directAgents.openAi });
          await held.received;
          const retired = new Promise<CloseEvent>(resolve => { socket.onclose = resolve; });
          for (let attempt = 0; attempt < 2; attempt++) {
            const response = await fetch(`${base}/api/v1/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${original}` } });
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({ success: true });
          }
          expect((await retired).code).toBe(4001);
          expect((await fetch(`${base}/api/v1/auth/user`, { headers: { Authorization: `Bearer ${original}` } })).status).toBe(401);
          await device.ping();
          const retained = await device.get<TerminalListResponse>(`/api/v1/terminals?executorId=${executorId}`);
          expect(retained.terminals.find(item => item.terminalId === terminal.terminalId)?.processStatus).toBe('running');
          held.releaseEcho();
          expect(await device.waitForTurnTerminal(chatId, turn.turnId!))
            .toMatchObject({ type: 'agent-run-finished', outcome: 'finished' });
        } finally { held.releaseEcho(); }
      } finally { socket.close(); await device.close(); }
    }, { executionBackend, serverEnvironment: { GARCON_TERMINAL_SHELL: '/bin/sh' } });
  }, 120_000);
}
