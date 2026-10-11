import { expect, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

test('mounted login returns to the protected deep link and reconnects after reload', async () => {
  const basePath = '/tools/garcon';
  await withE2eFixture('runtime-mount-login', async fixture => {
    const { integration, page } = fixture;
    const credentials = integration.garcon.credentials;
    if (!credentials) throw new Error('Fixture credentials missing');
    const chatId = integration.newChatId();
    const turn = await integration.client.startDirectChat({ chatId, content: 'Synthetic mounted login',
      projectPath: integration.dirs.project, agent: integration.directAgents.openAi });
    await integration.client.waitForTurnTerminal(chatId, turn.turnId);
    await page.evaluateOnNewDocument(() => {
      if (!sessionStorage.getItem('synthetic-login-started')) {
        localStorage.removeItem('bearer-token');
        sessionStorage.setItem('synthetic-login-started', '1');
      }
    });
    const returnTo = `/chat/${chatId}?synthetic=query#synthetic-fragment`;
    await page.goto(integration.garcon.baseUrl + returnTo);
    const app = new SpaDriver(page, integration);
    await page.waitForSelector('input[name="username"]');
    const loginUrl = new URL(page.url());
    expect(loginUrl.pathname).toBe(`${basePath}/login`);
    expect(loginUrl.searchParams.get('returnTo')).toBe(returnTo);
    await app.fill('input[name="username"]', credentials.username);
    await app.fill('input[name="password"]', credentials.password);
    await app.clickButton('Sign in');
    await page.waitForFunction(path => location.pathname === path, {}, `${basePath}/chat/${chatId}`);
    expect(new URL(page.url()).search).toBe('?synthetic=query');
    expect(new URL(page.url()).hash).toBe('#synthetic-fragment');
    await app.waitForText('echo:Synthetic mounted login');
    await fixture.waitForSpaWebSocket();
    const connections = await fixture.spaWebSocketConnectionCount();
    await page.reload();
    await app.waitForText('echo:Synthetic mounted login');
    await fixture.waitForSpaWebSocket({ afterConnectionCount: connections });
    expect(new URL(page.url()).pathname).toBe(`${basePath}/chat/${chatId}`);
    fixture.assertNoBrowserErrors();
  }, { serverEnvironment: { GARCON_BASE_PATH: basePath } });
}, 60_000);
