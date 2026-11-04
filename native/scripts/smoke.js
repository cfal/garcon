import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { GARCON_WS_PROTOCOL, webSocketProtocolsForAuth } from '../../common/ws-auth.ts';
import { prepareWorkflows, checkWorkflows } from './workflows-smoke.js';

const root = resolve(import.meta.dir, '..');
const binary = resolve(process.env.CARGO_TARGET_DIR ?? resolve(root, 'src-tauri/target'), 'debug/garcon-native');
const artifacts = resolve(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const temporaryRoot = process.env.GARCON_NATIVE_SMOKE_TMP ?? process.env.TMPDIR ?? resolve(homedir(), 'tmp');
await mkdir(temporaryRoot, { recursive: true });
const isolation = await mkdtemp(resolve(temporaryRoot, 'garcon-native-smoke-'));
const workflows = await prepareWorkflows(isolation).catch(async error => {
  await rm(isolation, { recursive: true, force: true });
  throw error;
});

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
  env: workflows.env,
  detached: true,
  stdout: 'pipe', stderr: 'pipe',
});
const stdout = new Response(driver.stdout).text();
const stderr = new Response(driver.stderr).text();
const endpoint = `http://127.0.0.1:${port}`;
let session;
let chooserHandle;

async function webdriver(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(endpoint + path, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(35_000),
  }).catch(cause => {
    throw new Error(`WebDriver ${method} ${path} failed`, { cause });
  });
  const result = await response.json();
  if (!response.ok || result.value?.error) throw new Error(JSON.stringify(result));
  return result.value;
}

const evaluate = (script, args = []) => webdriver(`/session/${session}/execute/sync`, { script, args });
async function launchApp() {
  console.log('Opening native launcher');
  const created = await webdriver('/session', {
    capabilities: { alwaysMatch: {
      'tauri:options': { application: binary },
      pageLoadStrategy: 'none',
      timeouts: { script: 10_000, pageLoad: 10_000, implicit: 0 },
    } },
  });
  session = created.sessionId;
  chooserHandle = await webdriver(`/session/${session}/window`);
}

async function openApp() {
  await launchApp();
  await until(() => evaluate('return !!document.querySelector("#server-form button:not(:disabled)")'), 'launcher readiness');
}

async function closeApp() {
  if (!session) return;
  await nativeKey('ctrl+q');
  await webdriver(`/session/${session}`, undefined, 'DELETE');
  session = undefined;
}

async function connect(url) {
  console.log(`Connecting synthetic server: ${url}`);
  await evaluate('document.querySelector("#server-url").value = arguments[0]; document.querySelector("#acknowledged").checked = true; document.querySelector("form").requestSubmit();', [url]);
}

async function replacementRemote(previous) {
  console.log('Waiting for replacement remote window');
  let current;
  await until(async () => {
    const handles = await webdriver(`/session/${session}/window/handles`);
    const remote = handles.find(handle => handle !== chooserHandle && handle !== previous);
    if (!remote) return false;
    assert.equal(handles.length, 2, 'exactly one host chooser and one remote page');
    current = remote;
    return true;
  }, 'single replacement remote window');
  await until(() => evaluate('return !document.querySelector("#server-form button").disabled'), 'completed host transition');
  return current;
}

async function openChooser(remote) {
  await remote.run('window.__GARCON_NATIVE__.requestServerChooser(); window.__GARCON_NATIVE__.requestServerChooser();');
  await until(() => evaluate('return !document.querySelector("#cancel").hidden && !document.querySelector("#server-form button").disabled'), 'chooser readiness');
}

async function menuChooser(key, shift = false) {
  // Native menu accelerators require OS input, not synthesized DOM keyboard events.
  const visible = Bun.spawn(['xdotool', 'search', '--onlyvisible', '--name', '^Garcon$'], { stdout: 'pipe', stderr: 'pipe' });
  const windows = (await new Response(visible.stdout).text()).trim().split('\n');
  assert.equal(await visible.exited, 0, 'native window must be visible');
  assert.equal(windows.length, 1, 'only the remote window is visible before a native menu request');
  const focus = Bun.spawn(['xdotool', 'windowfocus', '--sync', windows[0]], { stdout: 'ignore', stderr: 'inherit' });
  assert.equal(await focus.exited, 0, 'native remote window focus');
  await nativeKey(shift ? `ctrl+shift+${key}` : `ctrl+${key}`);
  const action = key === 'r' ? 'Reload Server' : 'Switch Server';
  await until(() => evaluate('return !document.querySelector("#cancel").hidden && document.querySelector("#server-form button").textContent === arguments[0]', [action]), 'native menu chooser');
}

async function nativeKey(key) {
  const input = Bun.spawn(['xdotool', 'key', '--clearmodifiers', key], {
    stdout: 'ignore', stderr: 'inherit',
  });
  assert.equal(await input.exited, 0, 'native menu keyboard input');
}

async function settleChooserPaint() {
  await webdriver(`/session/${session}/execute/async`, {
    script: `const done = arguments[arguments.length - 1];
      document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(() => done(null))));`,
    args: [],
  });
  assert.equal(await evaluate(`return ['#switch-warning', '#cancel'].every(selector => {
    const element = document.querySelector(selector);
    const rect = element.getBoundingClientRect();
    return !element.hidden && rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight;
  }) && !document.querySelector('#server-form button').disabled`), true, 'settled warning and Cancel fit in the chooser');
}

async function assertNavigationBlocked(url, currentUrl, remote) {
  if (remote) {
    assert.equal(await remote.run('location.href = arguments[0]; return new Promise(resolve => setTimeout(() => resolve(location.href), 300));', [url]), currentUrl);
    return;
  }
  await webdriver(`/session/${session}/execute/async`, {
    script: `const done = arguments[arguments.length - 1];
      location.href = arguments[0];
      setTimeout(() => done(location.href), 300);`,
    args: [url],
  });
  assert.equal(await evaluate('return location.href'), currentUrl);
}

async function assertPostNavigationBlocked(url, currentUrl, remote) {
  assert.equal(await remote.run(`
      const form = document.createElement('form');
      form.method = 'POST'; form.action = arguments[0]; document.body.append(form); form.submit();
      return new Promise(resolve => setTimeout(() => { form.remove(); resolve(location.href); }, 300));`, [url]), currentUrl);
}

async function assertRemoteWorkflows(remote, handle) {
  const connections = remote.socketConnections();
  await webdriver(`/session/${session}/window`, { handle });
  try {
    await checkWorkflows({
      evaluate: remote.run,
      webdriver: (path, body) => webdriver(`/session/${session}${path}`, body),
      until, workflows, remoteUrl: remote.url,
    });
    assert.equal(remote.socketConnections(), connections, 'native workflows must not replace the app socket');
  } finally {
    await webdriver(`/session/${session}/window`, { handle: chooserHandle });
  }
}

function fixture(base, outsideUrl) {
  const token = 'synthetic-native-token';
  let apiReceived = false;
  let socketReceived = false;
  let socketConnections = 0;
  let requests = 0;
  let activeSocket;
  let nextId = 0;
  const waiters = new Map();
  const server = Bun.serve({
    hostname: '0.0.0.0', port: 0,
    async fetch(request, server) {
      requests++;
      const path = new URL(request.url).pathname;
      if (path === `${base}/workflow-clipboard.js`) return new Response(workflows.clipboardScript, { headers: { 'Content-Type': 'text/javascript' } });
      if (path === `${base}/workflow-upload`) {
        const file = (await request.formData()).get('file');
        return Response.json({ name: file.name, content: await file.text() });
      }
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
        <script type="module">import { copyToClipboard } from ${JSON.stringify(`${base}/workflow-clipboard.js`)}; window.copyToClipboard = copyToClipboard;</script>
        <script>
          fetch(${JSON.stringify(`${base}/api`)}, {headers: {Authorization: ${JSON.stringify(`Bearer ${token}`)}}});
          const socket = new WebSocket('ws://' + location.host + ${JSON.stringify(`${base}/ws`)}, ${JSON.stringify(webSocketProtocolsForAuth(token))});
          socket.onopen = () => { document.body.dataset.connected = 'true'; };
          socket.onmessage = async event => {
            const { id, script, args } = JSON.parse(event.data);
            try {
              const result = await new Function(script)(...args);
              socket.send(JSON.stringify({ id, result: result ?? null }));
            } catch (error) { socket.send(JSON.stringify({ id, error: String(error) })); }
          };
        </script>`, { headers: { 'Content-Type': 'text/html' } });
    },
    websocket: {
      open(socket) { activeSocket = socket; socketConnections++; },
      close(socket) { if (activeSocket === socket) activeSocket = undefined; },
      message(_socket, message) {
        const { id, result, error } = JSON.parse(String(message));
        const waiter = waiters.get(id);
        if (!waiter) return;
        waiters.delete(id);
        clearTimeout(waiter.timer);
        if (error) waiter.reject(new Error(error));
        else waiter.resolve(result);
      },
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}${base}/`,
    connected: () => apiReceived && socketReceived && !!activeSocket,
    socketConnections: () => socketConnections,
    requests: () => requests,
    async run(script, args = []) {
      await until(() => !!activeSocket, 'synthetic page command socket');
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`Synthetic page timed out: ${script}`)); }, 10_000);
        waiters.set(id, { resolve, reject, timer });
        activeSocket.send(JSON.stringify({ id, script, args }));
      });
    },
    stop: () => server.stop(true),
  };
}

async function untrustedTlsFixture() {
  const keyPath = resolve(isolation, 'synthetic-key.pem');
  const certPath = resolve(isolation, 'synthetic-cert.pem');
  const certificate = Bun.spawn(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyPath, '-out', certPath],
  { stdout: 'ignore', stderr: 'ignore' });
  assert.equal(await certificate.exited, 0, 'synthetic TLS fixture certificate');
  const port = await unusedPort();
  let diagnostics = '';
  const server = Bun.spawn(['openssl', 's_server', '-accept', `0.0.0.0:${port}`, '-cert', certPath, '-key', keyPath, '-www', '-state'], {
    stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
  });
  const drain = async stream => { for await (const chunk of stream) diagnostics += new TextDecoder().decode(chunk); };
  const stdout = drain(server.stdout);
  const stderr = drain(server.stderr);
  await until(() => diagnostics.includes('ACCEPT'), 'synthetic TLS server readiness');
  const preflight = Bun.spawn(['curl', '--insecure', '--silent', '--show-error', '--fail', '--max-time', '5', `https://127.0.0.1:${port}/`], {
    stdout: 'ignore', stderr: 'inherit',
  });
  assert.equal(await preflight.exited, 0, 'synthetic TLS server serves HTTP when its certificate is accepted');
  await until(() => diagnostics.includes('read finished'), 'synthetic TLS preflight handshake');
  diagnostics = '';
  return {
    url: `https://127.0.0.1:${port}/`,
    rejected: () => diagnostics.includes('write certificate') && diagnostics.includes('SSL_accept:error') && !diagnostics.includes('read finished'),
    stop: async () => {
      server.kill('SIGTERM');
      await server.exited;
      await stdout;
      await stderr;
      await Bun.write(resolve(artifacts, 'synthetic-tls.log'), diagnostics);
    },
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
      const rendered = await webdriver(`/session/${session}/execute/async`, {
        script: `const done = arguments[arguments.length - 1];
          Promise.all([document.fonts.ready, ...Array.from(document.images, image => image.decode())])
            .then(() => requestAnimationFrame(() => requestAnimationFrame(() => done(null))))
            .catch(error => done(error.message));`,
        args: [],
      });
      assert.equal(rendered, null, 'launcher assets must render before capture');
      const screenshot = await webdriver(`/session/${session}/screenshot`);
      await Bun.write(resolve(artifacts, base ? 'launcher-mobile.png' : 'launcher.png'), Buffer.from(screenshot, 'base64'));
      await connect(remote.url);
      await until(() => remote.connected(), 'host-created remote HTTP and WebSocket');
      console.log('Remote transport connected');
      const aHandle = await replacementRemote();
      await until(() => remote.run('return document.body.dataset.connected === "true"'), 'remote HTTP and WebSocket');
      assert.equal(remote.connected(), true);
      const denied = await remote.run(`
          return Promise.all(['server_choices', 'connect_server', 'cancel_chooser', 'remove_recent', 'plugin:window|close'].map(command =>
            window.__TAURI_INTERNALS__.invoke(command, {url: 'https://synthetic.test/', generation: 1, acknowledged: true})
              .then(() => false, () => true))).then(results => results.every(Boolean));`);
      assert.equal(denied, true, 'remote page must not read host settings');
      await assertRemoteWorkflows(remote, aHandle);
      await assertNavigationBlocked(outside.url, remote.url, remote);
      await assertPostNavigationBlocked(outside.url, remote.url, remote);
      assert.equal(outside.requests(), 0, 'external navigation must not reach the destination');
      if (base) {
        const requestsBefore = remote.requests();
        await assertNavigationBlocked(new URL('/other/', remote.url).href, remote.url, remote);
        await assertPostNavigationBlocked(new URL('/other/', remote.url).href, remote.url, remote);
        assert.equal(remote.requests(), requestsBefore, 'sibling navigation must not reach the server');
      }
      for (const status of [307, 308]) {
        const beforeExternalRedirect = remote.requests();
        await assertPostNavigationBlocked(new URL(`redirect-external-${status}`, remote.url).href, remote.url, remote);
        assert.equal(remote.requests(), beforeExternalRedirect + 1, 'the allowed redirect source must receive the POST');
        assert.equal(outside.requests(), 0, 'redirected POST must not reach an external origin');
        if (base) {
          const beforeSiblingRedirect = remote.requests();
          await assertPostNavigationBlocked(new URL(`redirect-sibling-${status}`, remote.url).href, remote.url, remote);
          assert.equal(remote.requests(), beforeSiblingRedirect + 1, 'redirected POST must not reach a sibling mount');
        }
      }
      await remote.run('window.cancelSentinel = "synthetic-unsaved"; localStorage.setItem("synthetic-auth", "synthetic-a"); document.cookie = "synthetic-session=synthetic-a; path=/";');
      await openChooser(remote);
      assert.equal(await evaluate('return document.querySelector("#current-server").textContent'), `Current: ${remote.url}`);
      assert.equal(await evaluate('return document.documentElement.scrollWidth <= innerWidth'), true);
      await settleChooserPaint();
      await Bun.write(resolve(artifacts, base ? 'chooser-mobile.png' : 'chooser.png'), Buffer.from(await webdriver(`/session/${session}/screenshot`), 'base64'));
      await evaluate('document.querySelector("#server-url").value = "https://edited.test/";');
      await remote.run('window.__GARCON_NATIVE__.requestServerChooser();');
      assert.equal(await evaluate('return document.querySelector("#server-url").value'), 'https://edited.test/', 'repeated requests must not reset chooser edits');
      await evaluate('document.querySelector("#cancel").click();');
      assert.equal(await remote.run('return window.cancelSentinel'), 'synthetic-unsaved');
      await openChooser(remote);
      await connect(outside.url);
      const bHandle = await replacementRemote(aHandle);
      await until(() => outside.connected(), 'server B');
      assert.equal(await outside.run('return localStorage.getItem("synthetic-auth")'), null, 'origins must not share credentials');
      await openChooser(outside);
      const stale = await webdriver(`/session/${session}/execute/async`, {
        script: `const done = arguments[arguments.length - 1];
          window.__TAURI_INTERNALS__.invoke('connect_server', {url: arguments[0], generation: 0, acknowledged: true}).then(() => done(false), () => done(true));`,
        args: [remote.url],
      });
      assert.equal(stale, true, 'stale chooser submissions must be rejected');
      await connect(remote.url);
      const beforeReload = await replacementRemote(bHandle);
      await until(() => remote.connected(), 'server A restored');
      assert.equal(await remote.run('return localStorage.getItem("synthetic-auth")'), 'synthetic-a');
      assert.equal(await remote.run('return document.cookie.includes("synthetic-session=synthetic-a")'), true);
      assert.equal(await remote.run('return typeof window.cancelSentinel'), 'undefined', 'old remote page must not remain alive');
      await assertRemoteWorkflows(remote, beforeReload);
      await menuChooser('r');
      await until(() => evaluate('return document.querySelector("#server-form button").textContent === "Reload Server"'), 'host reload confirmation');
      await connect(remote.url);
      await replacementRemote(beforeReload);
      await until(() => remote.connected(), 'host reload');
      await closeApp();
      await openApp();
      assert.equal(await evaluate('return document.querySelector("#server-url").value'), remote.url);
      await connect(new URL('/different-mount/', remote.url).href);
      await until(() => evaluate('return document.querySelector("[role=alert]").textContent.includes("another mount")'), 'sibling mount rejection');
      await closeApp();
    } finally { remote.stop(); outside.stop(); }
  }
  await openApp();
  const unreachable = `http://127.0.0.1:${await unusedPort()}/`;
  await connect(unreachable);
  await replacementRemote();
  await menuChooser('s', true);
  assert.equal(await evaluate('return document.querySelector("#current-server").textContent'), `Current: ${unreachable}`);
  await Bun.write(resolve(artifacts, 'chooser-recovery.png'), Buffer.from(await webdriver(`/session/${session}/screenshot`), 'base64'));
  await connect('http://not-loopback.test/');
  await until(() => evaluate('return document.querySelector("[role=alert]").textContent.includes("Use HTTPS")'), 'bad URL recovery');
  const recovered = fixture('');
  try {
    const handles = await webdriver(`/session/${session}/window/handles`);
    const failedHandle = handles.find(handle => handle !== chooserHandle);
    await connect(recovered.url);
    await replacementRemote(failedHandle);
    await until(() => recovered.connected(), 'recovery after unreachable server');
  } finally { await closeApp(); recovered.stop(); }
  const untrusted = await untrustedTlsFixture();
  try {
    await openApp();
    await connect(untrusted.url);
    await replacementRemote();
    await until(() => untrusted.rejected(), 'native rejection of the synthetic TLS certificate');
    await menuChooser('s', true);
    assert.equal(await evaluate('return document.querySelector("#current-server").textContent'), `Current: ${untrusted.url}`);
  } finally { await closeApp(); await untrusted.stop(); }
  const config = await Bun.file(resolve(root, 'src-tauri/tauri.conf.json')).json();
  await Bun.write(resolve(isolation, config.identifier, 'servers.json'), '{');
  await launchApp();
  await until(() => evaluate('return document.querySelector("[role=alert]")?.textContent.includes("Saved server settings are invalid")'), 'corrupt settings error display');
  assert.equal(await evaluate('return document.querySelector("button").disabled'), true);
  const rejected = await webdriver(`/session/${session}/execute/async`, {
    script: `const done = arguments[arguments.length - 1];
      window.__TAURI_INTERNALS__.invoke('connect_server', {url: 'https://synthetic.test/', generation: 0, acknowledged: false})
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
  console.log('Native WebView smoke passed: launcher, root/mount HTTP + WS, A-B-A, cancel, repeated chooser, host reload, stale submission, auth persistence, restart, IPC denial, GET/POST and 307/308 navigation boundaries, corrupt settings recovery.');
} catch (error) {
  console.error('Native smoke failed:', error);
  throw error;
} finally {
  try { await closeApp(); } catch (error) { console.error('WebDriver cleanup failed:', error); } finally {
    // WebKit can retain the application after a failed WebDriver session creation.
    try { process.kill(-driver.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await driver.exited;
    await Bun.write(resolve(artifacts, 'driver.log'), (await stdout) + (await stderr));
    await rm(isolation, { recursive: true, force: true });
  }
}
