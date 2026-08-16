import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chatCompletionsText } from '../../support/fake-chat-completions-model.js';
import {
  withIntegrationFixture,
  type IntegrationFixture,
  type IntegrationFixtureOptions,
} from '../../support/integration-fixture.js';
import {
  expectFinished,
  LIVE_TURN_TIMEOUT_MS,
  waitForVisibleResponse,
} from '../../support/live-agent.js';
import { OpenCodeTransportController } from '../../support/opencode-transport-controller.js';
import {
  openCodeNativeSession,
  openCodePaths,
  readOpenCodeSessionCount,
  readOpenCodeSessionRows,
  scriptedOpenCodeRunRequest,
  scriptedOpenCodeStartRequest,
  startScriptedOpenCodeTestEnvironment,
  type ScriptedOpenCodeTestEnvironment,
} from '../../support/scripted-opencode.js';

// Locks the 119ecb4f transport contracts against the real pinned binary through the
// supervisor's reverse proxy: readiness waits for the connected frame and a transient event
// echo, a genuine socket reset fails the active turn before any reconnect, late provider events
// cannot leak under the retired turn, and the replacement global stream recovers.
let environment: ScriptedOpenCodeTestEnvironment | undefined;

const describeOnLinux = process.platform === 'linux' ? describe : describe.skip;

describeOnLinux('OpenCode global event stream through a real proxy', () => {
  beforeEach(() => {
    environment = startScriptedOpenCodeTestEnvironment({ proxy: true });
  });

  afterEach(() => {
    environment?.dispose();
    environment = undefined;
  });

  test('does not create a session or prompt before the global connected frame', async () => {
    const testEnvironment = requireEnvironment();
    const reply = marker('HELD_REPLY');
    testEnvironment.model.scriptTurn([chatCompletionsText(reply)]);

    await withIntegrationFixture('opencode-held-connected-frame', async (fixture) => {
      const controller = OpenCodeTransportController.forFixture(fixture.dirs);
      // Starting model discovery boots the pinned server and proxy without opening the
      // global event stream, so the hold can be armed deterministically.
      await fixture.client.listAgentCatalog();
      await controller.holdNextConnectedFrame();

      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const startPromise = fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: marker('HELD_PROMPT'),
      }));

      const heldConnection = await controller.waitForConnectedFrameHeld();
      expect(nativeSessionCount(fixture)).toBe(0);
      expect(testEnvironment.model.requests()).toHaveLength(0);
      expect(fixture.client.eventsSince(cursor).some((event) =>
        event.type === 'chat-session-created' && event.chatId === chatId
      )).toBe(false);

      await controller.releaseConnectedFrame(heldConnection);
      const turn = await startPromise;
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: turn.turnId,
        marker: reply,
        afterIndex: cursor,
      });
      expect(nativeSessionCount(fixture)).toBe(1);
      expect(testEnvironment.model.requests()).toHaveLength(1);

      const requests = await controller.requests();
      const paths = requests.map((request) => request.path);
      expect(paths).toContain('/global/event');
      expect(paths).not.toContain('/event');
      const globalStreamIndex = requests.findIndex((request) => request.path === '/global/event');
      const deliveryProbeIndex = requests.findIndex((request) =>
        request.method === 'POST' && request.path === '/tui/show-toast'
      );
      const promptIndex = requests.findIndex((request) => (
        request.method === 'POST'
        && /\/session\/[^/]+\/message$/.test(request.path)
      ));
      expect(deliveryProbeIndex).toBeGreaterThan(globalStreamIndex);
      expect(promptIndex).toBeGreaterThan(deliveryProbeIndex);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('fails an active turn before reconnect and ignores late events from the retired turn', async () => {
    const testEnvironment = requireEnvironment();
    const heldReply = marker('RESET_HELD_REPLY');
    const successorReply = marker('RESET_SUCCESSOR_REPLY');
    const held = testEnvironment.model.scriptHeldTurn([chatCompletionsText(heldReply)]);

    await withIntegrationFixture('opencode-global-stream-reset', async (fixture) => {
      const controller = OpenCodeTransportController.forFixture(fixture.dirs);
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: marker('RESET_HELD_PROMPT'),
      }));
      if (!turn.turnId) throw new Error('OpenCode start response omitted its turn id.');
      await held.requested;

      const activeConnection = await controller.activeGlobalConnectionId();
      const terminalPromise = fixture.client.waitForTurnTerminal(chatId, turn.turnId, {
        afterIndex: cursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      const terminalWinner = terminalPromise.then(() => 'terminal' as const);
      const reconnectWinner = controller.waitForGlobalConnectionCount(2)
        .then(() => 'reconnect' as const);

      await controller.resetGlobalConnection(activeConnection);
      // A silent SDK-owned retry would open the second connection before failing the turn.
      expect(await Promise.race([terminalWinner, reconnectWinner])).toBe('terminal');
      const terminal = await terminalPromise;
      expect(terminal.type).toBe('agent-run-failed');
      const events = fixture.client.eventsSince(cursor);
      const terminalIndex = events.findIndex((event) =>
        event.type === 'agent-run-failed'
        && event.chatId === chatId
        && event.turnId === turn.turnId);
      expect(terminalIndex).toBeGreaterThanOrEqual(0);

      // Garcon's outer retry owns the replacement stream.
      await controller.waitForGlobalConnectionCount(2);

      // The successor is admitted while the retired provider request remains held. Garcon
      // must quiesce that provider run before submitting the next prompt.
      testEnvironment.model.scriptTurn([chatCompletionsText(successorReply)]);
      const successorCursor = fixture.client.markEvents();
      const successor = await fixture.client.runChat(scriptedOpenCodeRunRequest({
        chatId,
        command: marker('RESET_SUCCESSOR_PROMPT'),
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: successor.turnId,
        marker: successorReply,
        afterIndex: successorCursor,
      });
      // The successor response proves that OpenCode cancelled the held request and started a
      // new one. Releasing earlier lets the retired response beat the provider abort.
      held.release();
      // The successor terminal is a stream-order barrier after the provider's late completion.
      expect(fixture.client.eventsSince(cursor).slice(terminalIndex + 1).some((event) =>
        event.type === 'chat-messages'
        && event.chatId === chatId
        && event.turnId === turn.turnId
      )).toBe(false);
      const native = await openCodeNativeSession(fixture, chatId);
      const rows = readOpenCodeSessionRows(native);
      expect(rows.parts.some((row) =>
        row.data.type === 'text' && row.data.text === heldReply
      )).toBe(false);

      const paths = (await controller.requests()).map((request) => request.path);
      expect(paths).toContain('/global/event');
      expect(paths).not.toContain('/event');
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);
});

function requireEnvironment(): ScriptedOpenCodeTestEnvironment {
  if (!environment) throw new Error('Scripted OpenCode environment was not initialized.');
  return environment;
}

function withScriptedOpenCode(): IntegrationFixtureOptions {
  const testEnvironment = requireEnvironment();
  return {
    resolveServerEnvironment: testEnvironment.resolveServerEnvironment,
    prepareWorkspace: testEnvironment.prepareWorkspace,
    afterGarconStop: testEnvironment.afterGarconStop,
    extraDiagnostics: testEnvironment.extraDiagnostics,
  };
}

function nativeSessionCount(fixture: IntegrationFixture): number {
  const databasePath = openCodePaths(fixture.dirs).database;
  return existsSync(databasePath) ? readOpenCodeSessionCount(databasePath) : 0;
}

function marker(label: string): string {
  return `SCRIPTED_OPENCODE_STREAM_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}
