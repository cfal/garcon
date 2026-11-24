import { expect, test } from 'bun:test';
import type { RemoteSettingsSnapshot } from '../../../common/settings.js';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { selectExecutor } from '../../support/executor-ui.js';
import { SpaDriver } from '../../support/spa-driver.js';

interface StartupSettingsGate {
  hold: boolean;
  pending: Array<() => void>;
  release(): void;
}

for (const executionBackend of ['remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`new chats restore the last started executor without learning cancelled selections (${executionBackend})`, async () => {
    await withE2eFixture(`executor-startup-recents-${executionBackend}`, async fixture => {
      const { client, directAgents, dirs, executionDirs } = fixture.integration;
      await client.put(`/api/v1/api-provider-assignments?executorId=local&apiProviderId=${directAgents.openAi.provider.providerId}`, {});
      const localChatId = fixture.integration.newChatId();
      const started = await client.startChat({
        ...client.directStartRequest({ chatId: localChatId, content: 'Synthetic Local startup', projectPath: dirs.project, agent: directAgents.openAi }),
        executorId: 'local',
      });
      await client.waitForTurnTerminal(localChatId, started.turnId);
      await fixture.page.evaluateOnNewDocument(() => {
        const scope = window as typeof window & { __startupSettingsGate: StartupSettingsGate };
        const gate: StartupSettingsGate = {
          hold: false,
          pending: [],
          release() {
            this.hold = false;
            for (const deliver of this.pending.splice(0)) deliver();
          },
        };
        scope.__startupSettingsGate = gate;
        const NativeWebSocket = window.WebSocket;
        window.WebSocket = new Proxy(NativeWebSocket, {
          construct(Target, args: ConstructorParameters<typeof WebSocket>) {
            const socket = new Target(...args);
            if (new URL(String(args[0]), location.href).pathname !== '/ws') return socket;
            let handler: typeof socket.onmessage = null;
            Object.defineProperty(socket, 'onmessage', {
              get: () => handler,
              set: (value: typeof handler) => { handler = value; },
            });
            socket.addEventListener('message', (event) => {
              const payload = JSON.parse(String(event.data));
              if (gate.hold && payload.type === 'settings-changed') {
                // Copies the payload before Lightpanda releases the event's backing storage.
                const data = JSON.stringify(payload);
                gate.pending.push(() => handler?.call(socket, new MessageEvent('message', { data })));
              } else {
                handler?.call(socket, event);
              }
            });
            return socket;
          },
        });
      });
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.open();
      await app.dismissEmptyWorkspaceLanding();
      await fixture.waitForSpaWebSocket();

      const executorPicker = '[role="dialog"] [data-executor-picker]';
      async function expectTarget(pathSelector: string, label: string, path: string) {
        if (pathSelector.includes('Project Path')) await app.revealNewChatProjectPath();
        await fixture.page.waitForFunction(({ pathSelector, executorPicker, label, path }) => {
          const input = document.querySelector<HTMLInputElement>(pathSelector);
          return input?.value === path && document.querySelector(executorPicker)?.getAttribute('aria-label') === `Executor: ${label}`;
        }, {}, { pathSelector, executorPicker, label, path });
      }
      async function closeNewChat() {
        await app.clickDialogButton('Close');
        await fixture.page.waitForFunction(() => document.querySelector('[data-new-chat-landing="true"]') === null);
      }

      await app.clickButton('New Chat');
      await expectTarget('[data-new-chat-landing="true"] input[aria-label="Project Path"]', 'Local', dirs.project);
      await selectExecutor(fixture.page, executorPicker, 'Integration worker');
      await app.enterNewChatProjectPath(executionDirs.project);
      await app.fill('[role="dialog"] textarea[placeholder="How can I help you today?"]', 'Synthetic remote startup');
      await app.waitForDialogButtonEnabled('Start session');
      await fixture.page.evaluate(() => {
        (window as typeof window & { __startupSettingsGate: StartupSettingsGate }).__startupSettingsGate.hold = true;
      });
      const startResponse = fixture.page.waitForResponse(response => response.url().endsWith('/api/v1/chats/start') && response.request().method() === 'POST');
      await app.clickButton('Start session', { last: true });
      expect((await startResponse).status()).toBe(202);
      await app.waitForAssistantMessageContaining('echo:Synthetic remote startup');
      await app.waitForChatProcessing(false);
      const snapshot = await client.get<RemoteSettingsSnapshot>('/api/v1/app/settings');
      expect(snapshot.recentAgentSettings[0]?.executorId).toBe(client.executorId);

      for (const reload of [false, true]) {
        if (reload) await fixture.page.reload();
        await app.waitForButton('New Chat');
        await app.clickButton('New Chat');
        await expectTarget('[data-new-chat-landing="true"] input[aria-label="Project Path"]', 'Integration worker', executionDirs.project);
        await fixture.page.waitForFunction(() => document.querySelector('[role="dialog"] [data-slot="model-selector-trigger-secondary"]')?.textContent?.includes('Integration Echo'));
        await selectExecutor(fixture.page, executorPicker, 'Local');
        if (!reload) {
          await fixture.page.waitForFunction(() => (window as typeof window & { __startupSettingsGate: StartupSettingsGate }).__startupSettingsGate.pending.length > 0);
          await fixture.page.evaluate(() => {
            (window as typeof window & { __startupSettingsGate: StartupSettingsGate }).__startupSettingsGate.release();
          });
          await expectTarget('#project-path-input', 'Local', dirs.project);
        }
        await closeNewChat();
      }

      await app.clickButton('More actions');
      await app.waitForMenuItemEnabled('Scheduled prompts');
      await app.clickMenuItem('Scheduled prompts');
      await app.waitForButtonEnabled('Add Prompt');
      await app.clickButton('Add Prompt');
      await expectTarget('#scheduled-project-path', 'Integration worker', executionDirs.project);
      await app.clickButton('Cancel', { last: true });
      expect((await client.get<RemoteSettingsSnapshot>('/api/v1/app/settings')).recentAgentSettings).toEqual(snapshot.recentAgentSettings);

      const nextLocalChatId = fixture.integration.newChatId();
      const localStarted = await client.startChat({
        ...client.directStartRequest({ chatId: nextLocalChatId, content: 'Synthetic latest Local startup', projectPath: dirs.project, agent: directAgents.openAi }),
        executorId: 'local',
      });
      await client.waitForTurnTerminal(nextLocalChatId, localStarted.turnId);
      await fixture.page.reload();
      await app.waitForButton('New Chat');
      await app.clickButton('New Chat');
      await expectTarget('[data-new-chat-landing="true"] input[aria-label="Project Path"]', 'Local', dirs.project);
      fixture.assertNoBrowserErrors();
    }, { executionBackend, projectRoots: 'separate' });
  }, 90_000);
}
