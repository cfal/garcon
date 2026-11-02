import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { GARCON_WS_PROTOCOL, webSocketProtocolsForAuth } from '../../common/ws-auth.ts';

const root = resolve(import.meta.dir, '..');
const binary = resolve(root, 'src-tauri/target/debug/garcon-native');
const artifacts = resolve(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const temporaryRoot = resolve(homedir(), 'tmp');
await mkdir(temporaryRoot, { recursive: true });
const isolation = await mkdtemp(resolve(temporaryRoot, 'garcon-native-smoke-'));

async function unusedPort() {
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '0.0.0.0', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function until(check, description) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) { lastError = error; }
    await Bun.sleep(50);
  }
  throw new Error(`Timed out: ${description}`, { cause: lastError });
}

const port = await unusedPort();
const nativePort = await unusedPort();
const driver = Bun.spawn(['tauri-driver', '--port', String(port), '--native-port', String(nativePort)], {
  env: { ...process.env, XDG_DATA_HOME: isolation, XDG_CONFIG_HOME: isolation, XDG_CACHE_HOME: isolation,
    WEBKIT_DISABLE_DMABUF_RENDERER: '1' },
  detached: true,
  stdout: 'pipe', stderr: 'pipe',
});
const stdout = new Response(driver.stdout).text();
const stderr = new Response(driver.stderr).text();
const endpoint = `http://127.0.0.1:${port}`;
let session;

async function webdriver(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(endpoint + path, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(35_000),
  });
  const result = await response.json();
  if (!response.ok || result.value?.error) throw new Error(JSON.stringify(result));
  return result.value;
}

const evaluate = (script, args = []) => webdriver(`/session/${session}/execute/sync`, { script, args });
async function launchApp() {
  console.log('Opening native launcher');
  const created = await webdriver('/session', {
    capabilities: { alwaysMatch: { 'tauri:options': { application: binary } } },
  });
  session = created.sessionId;
}

async function openApp() {
  await launchApp();
  await until(() => evaluate('return !!document.querySelector("#server-form button:not(:disabled)")'), 'launcher readiness');
}

async function closeApp() {
  if (!session) return;
  await webdriver(`/session/${session}`, undefined, 'DELETE');
  session = undefined;
}

async function connect(url) {
  await evaluate('document.querySelector("input").value = arguments[0]; document.querySelector("form").requestSubmit();', [url]);
}

async function assertNavigationBlocked(url, currentUrl) {
  await webdriver(`/session/${session}/execute/async`, {
    script: `const done = arguments[arguments.length - 1];
      location.href = arguments[0];
      setTimeout(() => done(location.href), 300);`,
    args: [url],
  });
  assert.equal(await evaluate('return location.href'), currentUrl);
}

async function assertPostNavigationBlocked(url, currentUrl) {
  await webdriver(`/session/${session}/execute/async`, {
    script: `const done = arguments[arguments.length - 1];
      const form = document.createElement('form');
      form.method = 'POST'; form.action = arguments[0]; document.body.append(form); form.submit();
      setTimeout(() => { form.remove(); done(location.href); }, 300);`,
    args: [url],
  });
  assert.equal(await evaluate('return location.href'), currentUrl);
}

function fixture(base, outsideUrl) {
  const token = 'synthetic-native-token';
  let apiReceived = false;
  let socketReceived = false;
  let requests = 0;
  const server = Bun.serve({
    hostname: '0.0.0.0', port: 0,
    fetch(request, server) {
      requests++;
      const path = new URL(request.url).pathname;
      for (const status of [307, 308]) {
        if (outsideUrl && path === `${base}/redirect-external-${status}`) return Response.redirect(outsideUrl, status);
        if (path === `${base}/redirect-sibling-${status}`) return Response.redirect(new URL('/other/', request.url).href, status);
      }
      if (path === `${base}/api`) {
        apiReceived = request.headers.get('Authorization') === `Bearer ${token}`;
        return Response.json({ success: apiReceived });
      }
      if (path === `${base}/ws`) {
        const protocols = request.headers.get('sec-websocket-protocol')?.split(',').map(value => value.trim());
        socketReceived = webSocketProtocolsForAuth(token).every(value => protocols?.includes(value));
        if (socketReceived && server.upgrade(request, { headers: { 'Sec-WebSocket-Protocol': GARCON_WS_PROTOCOL } })) return;
        return new Response('Unauthorized', { status: 401 });
      }
      return new Response(`<!doctype html><title>Synthetic remote</title><h1 id="remote">Synthetic remote</h1>
        <script>
          fetch(${JSON.stringify(`${base}/api`)}, {headers: {Authorization: ${JSON.stringify(`Bearer ${token}`)}}});
          const socket = new WebSocket('ws://' + location.host + ${JSON.stringify(`${base}/ws`)}, ${JSON.stringify(webSocketProtocolsForAuth(token))});
          socket.onmessage = () => document.body.dataset.connected = 'true';
        </script>`, { headers: { 'Content-Type': 'text/html' } });
    },
    websocket: { open(socket) { socket.send('synthetic-connected'); }, message() {} },
  });
  return {
    url: `http://127.0.0.1:${server.port}${base}/`,
    connected: () => apiReceived && socketReceived,
    requests: () => requests,
    stop: () => server.stop(true),
  };
}

try {
  await until(async () => {
    if (driver.exitCode !== null) throw new Error(`Driver exited: ${driver.exitCode}`);
    try { await webdriver('/status'); return true; } catch { return false; }
  }, 'WebDriver startup');
  for (const base of ['', '/tools/garcon']) {
    const outside = fixture('');
    const remote = fixture(base, outside.url);
    try {
      await openApp();
      await webdriver(`/session/${session}/window/rect`, base ? { width: 390, height: 844 } : { width: 1200, height: 800 });
      assert.equal(await evaluate('return document.documentElement.scrollWidth <= innerWidth'), true);
      const screenshot = await webdriver(`/session/${session}/screenshot`);
      await Bun.write(resolve(artifacts, base ? 'launcher-mobile.png' : 'launcher.png'), Buffer.from(screenshot, 'base64'));
      await connect(remote.url);
      await until(() => evaluate('return document.body.dataset.connected === "true"'), 'remote HTTP and WebSocket');
      assert.equal(remote.connected(), true);
      const denied = await webdriver(`/session/${session}/execute/async`, {
        script: `const done = arguments[arguments.length - 1];
          window.__TAURI_INTERNALS__.invoke('saved_server').then(() => done(false), () => done(true));`,
        args: [],
      });
      assert.equal(denied, true, 'remote page must not read host settings');
      await assertNavigationBlocked(outside.url, remote.url);
      await assertPostNavigationBlocked(outside.url, remote.url);
      assert.equal(outside.requests(), 0, 'external navigation must not reach the destination');
      if (base) {
        const requestsBefore = remote.requests();
        await assertNavigationBlocked(new URL('/other/', remote.url).href, remote.url);
        await assertPostNavigationBlocked(new URL('/other/', remote.url).href, remote.url);
        assert.equal(remote.requests(), requestsBefore, 'sibling navigation must not reach the server');
      }
      for (const status of [307, 308]) {
        const beforeExternalRedirect = remote.requests();
        await assertPostNavigationBlocked(new URL(`redirect-external-${status}`, remote.url).href, remote.url);
        assert.equal(remote.requests(), beforeExternalRedirect + 1, 'the allowed redirect source must receive the POST');
        assert.equal(outside.requests(), 0, 'redirected POST must not reach an external origin');
        if (base) {
          const beforeSiblingRedirect = remote.requests();
          await assertPostNavigationBlocked(new URL(`redirect-sibling-${status}`, remote.url).href, remote.url);
          assert.equal(remote.requests(), beforeSiblingRedirect + 1, 'redirected POST must not reach a sibling mount');
        }
      }
      await closeApp();
      await openApp();
      assert.equal(await evaluate('return document.querySelector("input").value'), remote.url);
      await connect(new URL('/different-mount/', remote.url).href);
      await until(() => evaluate('return document.querySelector("[role=alert]").textContent.includes("another mount")'), 'sibling mount rejection');
      await closeApp();
    } finally { remote.stop(); outside.stop(); }
  }
  const config = await Bun.file(resolve(root, 'src-tauri/tauri.conf.json')).json();
  await Bun.write(resolve(isolation, config.identifier, 'servers.json'), '{');
  await launchApp();
  await until(() => evaluate('return document.querySelector("[role=alert]")?.textContent.includes("Saved server settings are invalid")'), 'corrupt settings error display');
  assert.equal(await evaluate('return document.querySelector("button").disabled'), true);
  const rejected = await webdriver(`/session/${session}/execute/async`, {
    script: `const done = arguments[arguments.length - 1];
      window.__TAURI_INTERNALS__.invoke('connect_server', {url: 'https://synthetic.test/'})
        .then(() => done(false), error => done(error.includes('Saved server settings are invalid')));`,
    args: [],
  });
  assert.equal(rejected, true, 'invalid settings must also reject direct native connection requests');
  const outside = fixture('');
  try {
    const launcherUrl = await evaluate('return location.href');
    await assertNavigationBlocked(outside.url, launcherUrl);
    assert.equal(outside.requests(), 0, 'invalid settings must prevent remote navigation');
    assert.equal(await Bun.file(resolve(isolation, config.identifier, 'servers.json')).text(), '{');
  } finally { outside.stop(); }
  console.log('Native WebView smoke passed: launcher, root/mount HTTP + WS, restart, IPC denial, GET/POST and 307/308 navigation boundaries, storage isolation, corrupt settings recovery.');
} finally {
  try { await closeApp(); } finally {
    // WebKit can retain the application after a failed WebDriver session creation.
    try { process.kill(-driver.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await driver.exited;
    await Bun.write(resolve(artifacts, 'driver.log'), (await stdout) + (await stderr));
    await rm(isolation, { recursive: true, force: true });
  }
}
