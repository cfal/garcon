import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
let remoteTitle;
let beforeOpen = [];
let reloading = false;

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
  await evaluate(`window.chooserOpenCount = 0;
    window.addEventListener('garcon-chooser-open', () => window.chooserOpenCount++);`);
}

async function closeApp() {
  if (!session) return;
  await nativeKey('ctrl+q');
  await webdriver(`/session/${session}`, undefined, 'DELETE');
  session = undefined;
}

async function closeRemote(handle, title = remoteTitle) {
  const window = await focusNativeRemote(title);
  const raise = Bun.spawn(['xdotool', 'windowraise', window], { stdout: 'ignore', stderr: 'inherit' });
  assert.equal(await raise.exited, 0, 'native window must be raised before pointer input');
  const geometry = Bun.spawn(['xdotool', 'getwindowgeometry', '--shell', window], { stdout: 'pipe', stderr: 'inherit' });
  const width = Number((await new Response(geometry.stdout).text()).match(/^WIDTH=(\d+)$/m)?.[1]);
  assert.equal(await geometry.exited, 0);
  assert.ok(width > 100);
  console.log('Closing native window', { title, width, handle });
  const click = Bun.spawn(['xdotool', 'mousemove', '--window', window, String(width - 20), '16', 'click', '1'], { stdout: 'ignore', stderr: 'inherit' });
  assert.equal(await click.exited, 0, 'native titlebar close button');
  await until(async () => !(await webdriver(`/session/${session}/window/handles`)).includes(handle), 'closed server window');
}

async function connect(url, name = '') {
  console.log(`Connecting synthetic server: ${url}`);
  beforeOpen = await webdriver(`/session/${session}/window/handles`);
  reloading = await evaluate('return document.querySelector("#server-form button").textContent === "Reload Server"');
  remoteTitle = `${name.trim() || new URL(url).hostname} \u2014 Garcon`;
  await evaluate('document.querySelector("#server-url").value = arguments[0]; document.querySelector("#server-name").value = arguments[1]; document.querySelector("#acknowledged").checked = true; document.querySelector("form").requestSubmit();', [url, name]);
}

async function openedRemote() {
  console.log('Waiting for a new remote window');
  let current;
  await until(async () => {
    const handles = await webdriver(`/session/${session}/window/handles`);
    const remote = handles.find(handle => !beforeOpen.includes(handle));
    if (!remote) return false;
    assert.equal(handles.length, beforeOpen.length + (reloading ? 0 : 1), 'only reload may replace a server window');
    if (!reloading) assert.ok(beforeOpen.every(handle => handles.includes(handle)), 'opening must keep every existing window');
    current = remote;
    return true;
  }, 'new remote window');
  await until(() => evaluate('return !document.querySelector("#server-form button").disabled'), 'completed host transition');
  return current;
}

async function openChooser(remote) {
  await remote.run('window.__GARCON_NATIVE__.requestServerChooser(); window.__GARCON_NATIVE__.requestServerChooser();');
  await until(() => evaluate('return !document.querySelector("#cancel").hidden && !document.querySelector("#server-form button").disabled'), 'chooser readiness');
}

async function hostShortcutChooser(key, shift = false) {
  const opened = await evaluate('return window.chooserOpenCount');
  await nativeRemoteKey(shift ? `ctrl+shift+${key}` : `ctrl+${key}`);
  const action = key === 'r' ? 'Reload Server' : 'Open Server';
  await until(() => evaluate(`return window.chooserOpenCount > arguments[1]
    && !document.querySelector('#cancel').hidden
    && !document.querySelector('#server-form button').disabled
    && document.querySelector('#server-form button').textContent === arguments[0]`, [action, opened]), 'native recovery chooser');
}

async function focusNativeRemote(title = remoteTitle) {
  const pattern = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const visible = Bun.spawn(['xdotool', 'search', '--onlyvisible', '--name', `^${pattern}$`], { stdout: 'pipe', stderr: 'pipe' });
  const windows = (await new Response(visible.stdout).text()).trim().split('\n');
  assert.equal(await visible.exited, 0, 'native window must be visible');
  assert.equal(windows.length, 1, 'the named test window must be unambiguous');
  const focus = Bun.spawn(['xdotool', 'windowfocus', '--sync', windows[0]], { stdout: 'ignore', stderr: 'inherit' });
  assert.equal(await focus.exited, 0, 'native remote window focus');
  return windows[0];
}

async function nativeTitlebarChooser() {
  const opened = await evaluate('return window.chooserOpenCount');
  const window = await focusNativeRemote();
  const click = Bun.spawn(['xdotool', 'mousemove', '--window', window, '24', '16', 'click', '1'], {
    stdout: 'ignore', stderr: 'inherit',
  });
  assert.equal(await click.exited, 0, 'native titlebar recovery button');
  await until(() => evaluate(`return window.chooserOpenCount > arguments[0]
    && !document.querySelector('#cancel').hidden
    && !document.querySelector('#server-form button').disabled`, [opened]), 'titlebar chooser');
}

async function nativeRemoteKey(key) {
  // Host recovery requires OS input, not synthesized DOM keyboard events.
  await focusNativeRemote();
  await nativeKey(key);
}

async function nativeKey(key) {
  const input = Bun.spawn(['xdotool', 'key', '--clearmodifiers', key], {
    stdout: 'ignore', stderr: 'inherit',
  });
  assert.equal(await input.exited, 0, 'native keyboard input');
}

async function settleChooserPaint() {
  await webdriver(`/session/${session}/execute/async`, {
    script: `const done = arguments[arguments.length - 1];
      document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(() => done(null))));`,
    args: [],
  });
  assert.equal(await evaluate(`return ['#server-name', '#cancel'].every(selector => {
    const element = document.querySelector(selector);
    const rect = element.getBoundingClientRect();
    return !element.hidden && rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight;
  }) && document.querySelector('#switch-warning').hidden && !document.querySelector('#server-form button').disabled`), true, 'name and Cancel fit; opening is non-destructive');
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
  const windowCount = (await webdriver(`/session/${session}/window/handles`)).length;
  await webdriver(`/session/${session}/window`, { handle });
  try {
    await checkWorkflows({
      evaluate: remote.run,
      webdriver: (path, body) => webdriver(`/session/${session}${path}`, body),
      until, workflows, remoteUrl: remote.url, nativeKey: nativeRemoteKey, windowCount,
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
  const sockets = new Map();
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
      open(socket) { activeSocket = socket; sockets.set(++socketConnections, socket); },
      close(socket) {
        if (activeSocket === socket) activeSocket = undefined;
        for (const [id, current] of sockets) if (current === socket) sockets.delete(id);
      },
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
  const client = {
    url: `http://${process.env.GARCON_NATIVE_SMOKE_HOST ?? '127.0.0.1'}:${server.port}${base}/`,
    connected: () => apiReceived && socketReceived && !!activeSocket,
    socketConnections: () => socketConnections,
    requests: () => requests,
    page() {
      const connection = socketConnections;
      return { ...client, run: (script, args) => client.run(script, args, connection) };
    },
    async run(script, args = [], connection) {
      await until(() => connection ? sockets.has(connection) : !!activeSocket, 'synthetic page command socket');
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`Synthetic page timed out: ${script}`)); }, 10_000);
        waiters.set(id, { resolve, reject, timer });
        (connection ? sockets.get(connection) : activeSocket).send(JSON.stringify({ id, script, args }));
      });
    },
    stop: () => server.stop(true),
  };
  return client;
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
      await connect(remote.url, 'Synthetic A');
      await until(() => remote.connected(), 'host-created remote HTTP and WebSocket');
      console.log('Remote transport connected');
      const aHandle = await openedRemote();
      const aPage = remote.page();
      await until(() => remote.run('return document.body.dataset.connected === "true"'), 'remote HTTP and WebSocket');
      assert.equal(remote.connected(), true);
      const denied = await remote.run(`
          return Promise.all(['server_choices', 'connect_server', 'cancel_chooser', 'remove_recent', 'plugin:window|close'].map(command =>
            window.__TAURI_INTERNALS__.invoke(command, {url: 'https://synthetic.test/', generation: 1, acknowledged: true})
              .then(() => false, () => true))).then(results => results.every(Boolean));`);
      assert.equal(denied, true, 'remote page must not read host settings');
      await assertRemoteWorkflows(remote, aHandle);
      await assertNavigationBlocked(pathToFileURL(workflows.attachment).href, remote.url, remote);
      await remote.run(`
        window.syntheticDocument = URL.createObjectURL(new Blob(['<h1>Synthetic document</h1>'], { type: 'text/html' }));
      `);
      await assertNavigationBlocked(await remote.run('return window.syntheticDocument'), remote.url, remote);
      await remote.run('URL.revokeObjectURL(window.syntheticDocument); delete window.syntheticDocument;');
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
      assert.equal(await evaluate('return document.querySelector("#current-server").textContent'), `Opened from: ${remote.url}`);
      assert.equal(await evaluate('return document.documentElement.scrollWidth <= innerWidth'), true);
      await settleChooserPaint();
      await Bun.write(resolve(artifacts, base ? 'chooser-mobile.png' : 'chooser.png'), Buffer.from(await webdriver(`/session/${session}/screenshot`), 'base64'));
      await evaluate('document.querySelector("#server-url").value = "https://edited.test/";');
      await remote.run('window.__GARCON_NATIVE__.requestServerChooser();');
      assert.equal(await evaluate('return document.querySelector("#server-url").value'), 'https://edited.test/', 'repeated requests must not reset chooser edits');
      await evaluate('document.querySelector("#cancel").click();');
      assert.equal(await remote.run('return window.cancelSentinel'), 'synthetic-unsaved');
      const focusBeforeTitlebar = await remote.run('return document.activeElement.id');
      await nativeTitlebarChooser();
      await evaluate('document.querySelector("#cancel").click();');
      await until(() => remote.run('return document.hasFocus()'), 'titlebar chooser cancel restores page focus');
      assert.equal(await remote.run('return document.activeElement.id'), focusBeforeTitlebar);
      assert.equal(await remote.run('return window.cancelSentinel'), 'synthetic-unsaved', 'titlebar chooser cancel retains the page');
      await nativeTitlebarChooser();
      await connect(outside.url, 'Synthetic B');
      let bHandle = await openedRemote();
      await until(() => outside.connected(), 'server B');
      assert.equal(await aPage.run('return window.cancelSentinel'), 'synthetic-unsaved', 'opening B preserves A');
      assert.equal(await aPage.run('return location.href'), remote.url, 'A retains its own navigation boundary');
      await assertNavigationBlocked(outside.url, remote.url, aPage);
      assert.equal(await outside.run('return localStorage.getItem("synthetic-auth")'), null, 'origins must not share credentials');
      await openChooser(outside);
      const stale = await webdriver(`/session/${session}/execute/async`, {
        script: `const done = arguments[arguments.length - 1];
          window.__TAURI_INTERNALS__.invoke('connect_server', {url: arguments[0], generation: 0, acknowledged: true}).then(() => done(false), () => done(true));`,
        args: [remote.url],
      });
      assert.equal(stale, true, 'stale chooser submissions must be rejected');
      const beforeDuplicate = remote.socketConnections();
      await connect(remote.url, 'Synthetic Duplicate');
      const beforeReload = await openedRemote();
      await until(() => remote.socketConnections() > beforeDuplicate && remote.connected(), 'independent duplicate server A');
      assert.equal(await remote.run('return localStorage.getItem("synthetic-auth")'), 'synthetic-a');
      assert.equal(await remote.run('return document.cookie.includes("synthetic-session=synthetic-a")'), true);
      assert.equal(await remote.run('return typeof window.cancelSentinel'), 'undefined', 'duplicate opens a fresh document');
      assert.equal(await aPage.run('return window.cancelSentinel'), 'synthetic-unsaved', 'duplicate leaves the original page alive');
      await remote.run('window.duplicateSentinel = "duplicate-unsaved";');
      const bConnections = outside.socketConnections();
      remoteTitle = 'Synthetic B \u2014 Garcon';
      await hostShortcutChooser('r');
      await connect(outside.url, 'Synthetic B');
      bHandle = await openedRemote();
      await until(() => outside.socketConnections() > bConnections && outside.connected(), 'reload B while both A windows remain alive');
      assert.equal(await aPage.run('return window.cancelSentinel'), 'synthetic-unsaved', 'B reload preserves original A');
      assert.equal(await remote.run('return window.duplicateSentinel'), 'duplicate-unsaved', 'B reload preserves duplicate A');
      remoteTitle = 'Synthetic Duplicate \u2014 Garcon';
      await closeRemote(bHandle, 'Synthetic B \u2014 Garcon');
      assert.equal(await aPage.run('return window.cancelSentinel'), 'synthetic-unsaved', 'closing B does not close A');
      await openChooser(aPage);
      await closeRemote(aHandle, 'Synthetic A \u2014 Garcon');
      await until(() => evaluate('return document.querySelector("#current-server").textContent === "" && !document.querySelector("#cancel").hidden'), 'closed chooser source is not retargeted');
      await evaluate('document.querySelector("#cancel").click();');
      assert.equal(await remote.run('return location.href'), remote.url, 'duplicate survives closing original and cancelling chooser');
      await assertRemoteWorkflows(remote, beforeReload);
      await remote.run(`window.nativeKeys = []; document.addEventListener('keydown', event => window.nativeKeys.push([event.key, event.ctrlKey, event.shiftKey]));`);
      await hostShortcutChooser('r').catch(async error => {
        console.error('Recovery diagnostics', await remote.run('return { keys: window.nativeKeys, active: document.activeElement.tagName }'), await evaluate('return { button: document.querySelector("#server-form button").textContent, cancelHidden: document.querySelector("#cancel").hidden }'));
        throw error;
      });
      await until(() => evaluate('return document.querySelector("#server-form button").textContent === "Reload Server"'), 'host reload confirmation');
      await connect(remote.url, 'Synthetic Duplicate');
      let previousHandle = await openedRemote();
      await until(() => remote.connected(), 'host reload');
      // Repeated replacements exercise recovery handler ownership and native window cleanup.
      for (let replacement = 0; replacement < 8; replacement++) {
        await remote.run('window.reloadSentinel = "synthetic-unsaved";');
        await hostShortcutChooser('s', true);
        await evaluate('document.querySelector("#cancel").click();');
        await until(() => remote.run('return document.hasFocus()'), 'cancelled chooser focus');
        assert.equal(await remote.run('return window.reloadSentinel'), 'synthetic-unsaved');
        await hostShortcutChooser('r');
        await connect(remote.url, 'Synthetic Duplicate');
        previousHandle = await openedRemote();
        await until(() => remote.connected(), 'repeated host reload');
        assert.equal(await remote.run('return typeof window.reloadSentinel'), 'undefined');
        assert.equal(await remote.run('return localStorage.getItem("synthetic-auth")'), 'synthetic-a');
      }
      console.log('Native recovery lifecycle passed: independent windows, source-only reload, native close, cancel and eight further reloads.');
      await closeRemote(previousHandle);
      await until(() => evaluate('return !document.querySelector("#server-form button").disabled && document.querySelector("#cancel").hidden'), 'last server close returns to the chooser');
      await closeApp();
      await openApp();
      assert.equal(await evaluate('return document.querySelector("#server-url").value'), remote.url);
      assert.equal(await evaluate('return document.querySelector("#server-name").value'), 'Synthetic Duplicate', 'custom name survives restart');
      await connect(new URL('/different-mount/', remote.url).href);
      await until(() => evaluate('return document.querySelector("[role=alert]").textContent.includes("another mount")'), 'sibling mount rejection');
      await closeApp();
    } finally { remote.stop(); outside.stop(); }
  }
  await openApp();
  const unreachable = `http://127.0.0.1:${await unusedPort()}/`;
  await connect(unreachable);
  await openedRemote();
  await hostShortcutChooser('s', true);
  assert.equal(await evaluate('return document.querySelector("#current-server").textContent'), `Opened from: ${unreachable}`);
  await Bun.write(resolve(artifacts, 'chooser-recovery.png'), Buffer.from(await webdriver(`/session/${session}/screenshot`), 'base64'));
  await connect('http://not-loopback.test/');
  await until(() => evaluate('return document.querySelector("[role=alert]").textContent.includes("Use HTTPS")'), 'bad URL recovery');
  const recovered = fixture('');
  try {
    await connect(recovered.url);
    await openedRemote();
    await until(() => recovered.connected(), 'recovery after unreachable server');
  } finally { await closeApp(); recovered.stop(); }
  const untrusted = await untrustedTlsFixture();
  try {
    await openApp();
    await connect(untrusted.url);
    await openedRemote();
    await until(() => untrusted.rejected(), 'native rejection of the synthetic TLS certificate');
    await hostShortcutChooser('s', true);
    assert.equal(await evaluate('return document.querySelector("#current-server").textContent'), `Opened from: ${untrusted.url}`);
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
