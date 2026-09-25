import { expect, test } from 'bun:test';
import type { PullRequestSummary } from '../../../common/gh.js';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { initializeFixtureRepository } from '../../support/git-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

declare global {
  interface Window {
    __pullRequestRecovery: {
      holdCapability: boolean;
      replacement: boolean;
      listRequests: number;
      detailRequests: number;
      releaseCapability: (() => void) | null;
    };
  }
}

test('selected PR detail refreshes after project recovery precedes GitHub capability', async () => {
  await withE2eFixture('pull-request-capability-recovery', async fixture => {
    const { client, executionDirs, directAgents } = fixture.integration;
    await initializeFixtureRepository(executionDirs.project);
    const chatId = fixture.integration.newChatId();
    const accepted = await client.startDirectChat({
      chatId, projectPath: executionDirs.project, content: 'Synthetic PR recovery chat', agent: directAgents.openAi,
    });
    await client.waitForTurnTerminal(chatId, accepted.turnId);
    await fixture.page.evaluateOnNewDocument(executorId => {
      const originalFetch = globalThis.fetch.bind(globalThis);
      const recovery = window.__pullRequestRecovery = {
        holdCapability: false, replacement: false, listRequests: 0, detailRequests: 0,
        releaseCapability: null as (() => void) | null,
      };
      const summary = {
        number: 3, title: 'Synthetic pull request', state: 'open', isDraft: false,
        author: 'synthetic-author', headRefName: 'feature', baseRefName: 'main',
        additions: 0, deletions: 0, changedFiles: 0, updatedAt: '2026-01-01T00:00:00Z',
        url: 'https://example.test/pull/3', reviewDecision: null, checksState: 'none',
      } satisfies PullRequestSummary;
      Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true,
        value: (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const url = new URL(input instanceof Request ? input.url : String(input), location.href);
          if (url.searchParams.get('executorId') !== executorId) return originalFetch(input, init);
          const scope = { executorId, instanceId: recovery.replacement ? 'replacement-instance' : 'original-instance' };
          if (url.pathname === '/api/v1/gh/status') {
            const response = () => Response.json({ ...scope, available: true, authenticated: true, reason: 'authenticated' });
            if (!recovery.holdCapability) return Promise.resolve(response());
            return new Promise(resolve => {
              recovery.releaseCapability = () => {
                recovery.holdCapability = false;
                recovery.releaseCapability = null;
                resolve(response());
              };
            });
          }
          if (url.pathname === '/api/v1/gh/pull-requests') {
            recovery.listRequests++;
            return Promise.resolve(Response.json({ ...scope, pulls: [summary], repo: null }));
          }
          if (url.pathname === '/api/v1/gh/pull-request') {
            recovery.detailRequests++;
            return Promise.resolve(Response.json({
              ...scope, ...summary, title: recovery.replacement ? 'Replacement PR detail' : 'Original PR detail',
              body: '', createdAt: summary.updatedAt, mergeable: 'mergeable', checks: [], files: [], fileBodies: {}, threads: [],
            }));
          }
          return originalFetch(input, init);
        },
      });
    }, client.executorId);

    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.setViewport(1_600, 900);
    await app.openChat(chatId);
    await fixture.waitForSpaWebSocket();
    const connections = await fixture.spaWebSocketConnectionCount();
    await app.openNewWorkspaceWindow('Open Pull Requests');
    await app.waitForText('Synthetic pull request');
    await fixture.page.evaluate(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find(element => element.textContent?.includes('Synthetic pull request'));
      if (!button) throw new Error('Missing synthetic PR');
      button.click();
    });
    await app.waitForText('Original PR detail');
    await fixture.page.evaluate(() => {
      window.__pullRequestRecovery.holdCapability = true;
      window.__pullRequestRecovery.replacement = true;
    });
    await client.patch(`/api/v1/executors/${client.executorId}`, { enabled: false });
    await app.waitForText('Git is unavailable on this executor.');
    await client.patch(`/api/v1/executors/${client.executorId}`, { enabled: true });
    await fixture.page.waitForFunction(() => window.__pullRequestRecovery.releaseCapability !== null);
    await app.waitForText('Checking pull request availability...');
    expect(await fixture.page.evaluate(() => window.__pullRequestRecovery.detailRequests)).toBe(1);
    await fixture.page.evaluate(() => window.__pullRequestRecovery.releaseCapability!());
    await app.waitForText('Replacement PR detail');
    expect(await fixture.page.evaluate(() => ({
      lists: window.__pullRequestRecovery.listRequests,
      details: window.__pullRequestRecovery.detailRequests,
    }))).toEqual({ lists: 2, details: 2 });
    expect(await fixture.spaWebSocketConnectionCount()).toBe(connections);
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'remote-controller-dials', projectRoots: 'separate' });
}, 60_000);
