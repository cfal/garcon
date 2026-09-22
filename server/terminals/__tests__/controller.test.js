import { expect, test } from 'bun:test';
import { TerminalController } from '../controller.ts';
import { TerminalRuntime } from '../node-service.ts';
import { LOCAL_SERVER_PRINCIPAL } from '../../lib/http-route-types.ts';
import { homedir } from 'node:os';

function peer() {
  return { connectionId: crypto.randomUUID(), ownedTerminalIds: new Set(), messages: [], sendTerminalMessage(message) { this.messages.push(message); } };
}

test('controller captures node, principal mode and exact attachment for controls and cleanup', async () => {
  const runtime = new TerminalRuntime({ projectBasePath: homedir(), spawnPty: () => ({ onData() {}, onExit() {}, kill() {}, write() {}, resize() {} }) });
  const remoteId = crypto.randomUUID();
  const services = new Map(['local', remoteId].map(id => [id, runtime.service(id)]));
  const controller = new TerminalController({ requireNode(id) { return { getTerminalService: async () => services.get(id) }; } });
  const principal = LOCAL_SERVER_PRINCIPAL;
  try {
    const inventory = await controller.list(principal, remoteId);
    const { terminal } = await controller.create(principal, { nodeId: remoteId, expectedTerminalRuntimeId: inventory.terminalRuntimeId, requestId: 'create', requestedInitialWorkingDirectory: null });
    expect((await controller.list(principal)).terminals).toEqual([]);
    expect((await controller.list({ mode: 'authenticated', key: 'local', username: 'local', expiresAtMs: Date.now() + 60000 }, remoteId)).terminals).toEqual([]);
    const browser = peer();
    const request = { type: 'terminal-attach', terminalId: terminal.terminalId, attachmentEpoch: inventory.attachmentEpoch, clientId: 'browser', afterSequence: 0, intent: 'restore' };
    await controller.attach(principal, browser, { ...request, attachmentId: 'old' });
    await controller.attach(principal, browser, { ...request, attachmentId: 'new' });
    controller.detachTerminal(principal, browser, terminal.terminalId, 'old');
    expect((await controller.list(principal, remoteId)).terminals[0].attachmentStatus).toBe('attached');
    expect(() => controller.input(principal, browser, terminal.terminalId, 'stale', 'old')).toThrow('unavailable');
    await controller.input(principal, browser, terminal.terminalId, 'current', 'new');
    expect(browser.messages.at(-1).attachmentId).toBe('new');
    controller.detachPeer(principal, browser);
    expect((await controller.list(principal, remoteId)).terminals[0].attachmentStatus).toBe('detached');
  } finally { controller.shutdown(); for (const service of services.values()) service.dispose(); runtime.shutdown(); }
});

test('browser close while resolving a service cannot admit a late attachment', async () => {
  const service = Promise.withResolvers();
  let admitted = false;
  const controller = new TerminalController({ requireNode() { return { getTerminalService: () => service.promise }; } });
  const browser = peer();
  const attaching = controller.attach(LOCAL_SERVER_PRINCIPAL, browser, {
    type: 'terminal-attach', terminalId: `local/${crypto.randomUUID()}/${crypto.randomUUID()}`, attachmentId: 'closing',
    attachmentEpoch: 'epoch', clientId: 'browser', afterSequence: 0, intent: 'restore',
  });
  controller.detachPeer(LOCAL_SERVER_PRINCIPAL, browser);
  service.resolve({ async attach() { admitted = true; } });
  await attaching;
  expect(admitted).toBe(false);
});
