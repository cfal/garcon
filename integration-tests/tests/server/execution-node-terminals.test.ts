import { expect, test } from 'bun:test';
import type { TerminalCreateResponse, TerminalListResponse, TerminalStreamServerMessage } from '../../../common/terminal.js';
import { parseTerminalReference } from '../../../common/terminal-identity.js';
import type { PrimaryWsServerMessage as ServerWsMessage } from '../../../common/ws-protocol.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import type { GarconTestClient } from '../../support/garcon-client.js';

const list = (client: GarconTestClient, nodeId: string) => client.get<TerminalListResponse>(`/api/v1/terminals?nodeId=${nodeId}`);
function event<K extends TerminalStreamServerMessage['type']>(type: K, attachmentId: string) {
  return (message: ServerWsMessage): message is Extract<TerminalStreamServerMessage, { type: K }> =>
    message.type === type && 'attachmentId' in message && message.attachmentId === attachmentId;
}
async function attach(client: GarconTestClient, terminalId: string, inventory: TerminalListResponse, intent: 'restore' | 'takeover' = 'restore') {
  const attachmentId = crypto.randomUUID();
  client.sendTerminal({ type: 'terminal-attach', terminalId, attachmentId, attachmentEpoch: inventory.attachmentEpoch, clientId: 'synthetic-browser', afterSequence: 0, intent });
  const attached = await client.waitForEvent(event('terminal-attached', attachmentId), 'terminal attachment');
  return { attachmentId, attached };
}

for (const backend of ['in-process', 'remote-controller-dials', 'remote-node-dials'] as const) {
  test(`real PTYs preserve identity and jobs through browser/controller replacement (${backend})`, async () => {
    await withIntegrationFixture(`terminals-${backend}`, async fixture => {
      let client = fixture.client;
      const nodeId = client.nodeId;
      const inventory = await list(client, nodeId);
      expect(inventory.terminalRuntimeId).toBeString();
      const request = { nodeId, expectedTerminalRuntimeId: inventory.terminalRuntimeId, requestId: 'synthetic-create', requestedInitialWorkingDirectory: fixture.executionDirs.project };
      const { terminal } = await client.post<TerminalCreateResponse>('/api/v1/terminals', request);
      const terminalId = terminal.terminalId;
      expect(parseTerminalReference(terminalId)).toMatchObject({ nodeId, terminalRuntimeId: inventory.terminalRuntimeId });
      expect(terminal.initialWorkingDirectory).toBe(fixture.executionDirs.project);
      let { attachmentId } = await attach(client, terminalId, inventory);
      client.sendTerminal({ type: 'terminal-input', terminalId, attachmentId, data: "stty -echo; export TERMINAL_TEST_VALUE=survived; printf '\\033[32mready\\033[0m\\n'\r" });
      await client.waitForEvent((message): message is Extract<TerminalStreamServerMessage, { type: 'terminal-output' }> =>
        message.type === 'terminal-output' && message.attachmentId === attachmentId && message.data.includes('\u001b[32mready'), 'native ANSI output');
      client.sendTerminal({ type: 'terminal-resize', terminalId, attachmentId, cols: 117, rows: 39 });
      client.sendTerminal({ type: 'terminal-input', terminalId, attachmentId, data: "stty size; printf '\\342\\230\\203\\n'\r" });
      await client.waitForEvent((message): message is Extract<TerminalStreamServerMessage, { type: 'terminal-output' }> =>
        message.type === 'terminal-output' && message.attachmentId === attachmentId && message.data.includes('39 117'), 'native resize');
      await client.reconnect();
      const restored = await attach(client, terminalId, await list(client, nodeId));
      expect(restored.attached.replay.map(chunk => chunk.data).join('')).toContain('ready');
      attachmentId = restored.attachmentId;
      if (backend !== 'in-process') {
        expect((await list(client, 'local')).terminals).toEqual([]);
        await fixture.crashAndRestartGarcon({ preserveExecutionWorker: true });
        client = fixture.client;
        const after = await list(client, nodeId);
        expect(after.terminalRuntimeId).toBe(inventory.terminalRuntimeId);
        expect(after.attachmentEpoch).not.toBe(inventory.attachmentEpoch);
        expect(after.terminals[0]).toMatchObject({ terminalId, processStatus: 'running' });
        expect((await client.post<TerminalCreateResponse>('/api/v1/terminals', request)).terminal.terminalId).toBe(terminalId);
        attachmentId = (await attach(client, terminalId, after)).attachmentId;
      }
      const start = client.eventRecords().length;
      client.sendTerminal({ type: 'terminal-input', terminalId, attachmentId, data: 'printf "job-%s\\n" "$TERMINAL_TEST_VALUE"; exit 7\r' });
      await client.waitForEvent((message): message is Extract<TerminalStreamServerMessage, { type: 'terminal-status' }> =>
        message.type === 'terminal-status' && message.attachmentId === attachmentId && message.terminal.processStatus === 'exited', 'native exit', { afterIndex: start });
      const events = client.eventRecords().slice(start).map(record => record.parsed);
      expect(events.filter(message => message.type === 'terminal-output').map(message => message.data).join('')).toContain('job-survived');
      expect((await list(client, nodeId)).terminals[0]).toMatchObject({ terminalId, exitCode: 7 });
      await client.delete('/api/v1/terminals', { terminalId, requestId: 'synthetic-terminate' });
      expect((await list(client, nodeId)).terminals).toEqual([]);
      if (backend !== 'in-process') {
        await fixture.crashAndRestartExecutionWorker();
        const replacement = await list(client, nodeId);
        expect(replacement.terminalRuntimeId).not.toBe(inventory.terminalRuntimeId);
        expect(replacement.terminals).toEqual([]);
        await expect(client.post('/api/v1/terminals', request)).rejects.toMatchObject({
          status: 409, body: { errorCode: 'terminal-runtime-changed' },
        });
        await expect(client.delete('/api/v1/terminals', { terminalId, requestId: 'stale-terminate' })).rejects.toMatchObject({
          status: 409, body: { errorCode: 'terminal-runtime-changed' },
        });
        expect((await list(client, nodeId)).terminals).toEqual([]);
      }
    }, { executionBackend: backend, projectRoots: 'separate', serverEnvironment: { GARCON_TERMINAL_SHELL: '/bin/sh' } });
  }, 60_000);
}
