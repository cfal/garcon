import { expect, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

type FailureGateGlobal = typeof globalThis & {
  __startFailure?: { attempts: number; release: (() => void) | null; completed: boolean };
};

for (const failure of ['attachment', 'rejection', 'unknown'] as const) {
  test.each([false, true])(`automatic start ${failure} preserves the correct editable draft (background=%s)`, async background => {
    await withE2eFixture(`automatic-start-${failure}-${background}`, async fixture => {
      const { client, directAgents, dirs } = fixture.integration;
      const otherId = fixture.integration.newChatId();
      const other = await client.startDirectChat({ chatId: otherId, projectPath: dirs.project,
        content: 'Synthetic navigation chat', agent: directAgents.openAi });
      await client.waitForTurnTerminal(otherId, other.turnId);
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.openChat(otherId);
      await fixture.waitForSpaWebSocket();
      await app.clickButton('New Chat');
      await fixture.page.waitForFunction(() => {
        const dialog = document.querySelector('[role="dialog"]');
        return dialog && !dialog.querySelector('[role="status"][aria-label="Loading chat defaults..."]');
      });
      await app.ensureDirectModelSelected({ selectedAgentLabel: 'Direct (Chat Completions)', optionAgentLabel: 'Chat Completions', modelLabel: 'Integration Echo' });
      await app.fill('[role="dialog"] input[aria-label="Project Path"]', dirs.project);
      await app.fill('[role="dialog"] textarea', 'Synthetic initial prompt');
      await fixture.page.$eval('[role="dialog"] input[type="file"]', element => {
        Object.defineProperty(element, 'files', { configurable: true, value: [new File(['Synthetic attachment'], 'context.txt', { type: 'text/plain' })] });
        element.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await app.waitForText('context.txt');
      await fixture.page.evaluate(mode => {
        const scope = globalThis as FailureGateGlobal;
        const gate: NonNullable<FailureGateGlobal['__startFailure']> = { attempts: 0, release: null, completed: false };
        scope.__startFailure = gate;
        if (mode === 'attachment') {
          const read = FileReader.prototype.readAsDataURL;
          FileReader.prototype.readAsDataURL = function() {
            FileReader.prototype.readAsDataURL = read;
            gate.release = () => {
              this.onerror?.(new ProgressEvent('error') as ProgressEvent<FileReader>);
              gate.completed = true;
            };
          };
        } else {
          const original = globalThis.fetch.bind(globalThis);
          Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true,
            value: async (input: RequestInfo | URL, init?: RequestInit) => {
              const url = new URL(input instanceof Request ? input.url : String(input), location.href);
              if (url.pathname !== '/api/v1/chats/start') return original(input, init);
              gate.attempts += 1;
              if (gate.attempts === 1) await new Promise<void>(resolve => { gate.release = resolve; });
              gate.completed = true;
              if (mode === 'unknown') throw new TypeError('Synthetic unconfirmed transport');
              return new Response(JSON.stringify({ success: false, error: 'Synthetic start rejection', errorCode: 'VALIDATION_FAILED' }),
                { status: 400, headers: { 'content-type': 'application/json' } });
            },
          });
        }
      }, failure);
      await app.waitForDialogButtonEnabled('Start session');
      await app.clickDialogButton('Start session');
      const draftId = await app.waitForSelectedChatChange(otherId);
      await fixture.page.waitForFunction(() => (globalThis as FailureGateGlobal).__startFailure?.release !== null);
      if (background) {
        await app.clickSidebarChatById(otherId);
        await app.waitForSelectedChat(otherId);
        await app.fill('[data-composer] textarea', 'Unrelated editable text');
      }
      await fixture.page.evaluate(() => (globalThis as FailureGateGlobal).__startFailure?.release?.());
      await fixture.page.waitForFunction(() => (globalThis as FailureGateGlobal).__startFailure?.completed === true);
      if (background) {
        expect(await fixture.page.$eval('[data-composer] textarea', element => (element as HTMLTextAreaElement).value)).toBe('Unrelated editable text');
        await app.clickSidebarChatById(draftId);
        await app.waitForSelectedChat(draftId);
      }
      await app.waitForText(failure === 'unknown' ? 'Message delivery could not be confirmed.' : failure === 'rejection' ? 'Synthetic start rejection' : 'Failed to prepare attachments');
      const expected = failure === 'unknown' ? '' : 'Synthetic initial prompt';
      await fixture.page.waitForFunction(text => document.querySelector<HTMLTextAreaElement>('[data-composer] textarea')?.value === text, {}, expected);
      if (failure !== 'unknown') await app.waitForButton('Remove attachment context.txt');
      const attempts = await fixture.page.evaluate(() => (globalThis as FailureGateGlobal).__startFailure?.attempts);
      expect(attempts).toBe(failure === 'attachment' ? 0 : failure === 'unknown' ? 2 : 1);
      await app.clickSidebarChatById(otherId);
      await app.waitForSelectedChat(otherId);
      await app.clickSidebarChatById(draftId);
      await app.waitForSelectedChat(draftId);
      expect(await fixture.page.$eval('[data-composer] textarea', element => (element as HTMLTextAreaElement).value)).toBe(expected);
      expect(await fixture.page.evaluate(() => (globalThis as FailureGateGlobal).__startFailure?.attempts)).toBe(attempts);
      expect((await client.listChats()).sessions.map(chat => chat.id)).toEqual([otherId]);
      expect(fixture.browserErrors.filter(error => !error.includes('[SessionController] Failed to start chat:') && !error.includes('[SessionController] Failed to prepare attachment payload:'))).toEqual([]);
    });
  }, 60_000);
}
