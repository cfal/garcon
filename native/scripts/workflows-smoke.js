import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function prepareWorkflows(isolation) {
  const browserLog = resolve(isolation, 'browser.jsonl');
  const applications = resolve(isolation, 'applications');
  await mkdir(applications, { recursive: true });
  await Bun.write(browserLog, '');
  const attachment = resolve(isolation, 'synthetic-attachment.txt');
  await Bun.write(attachment, 'Synthetic attachment content.');
  const clipboard = await Bun.build({
    entrypoints: [resolve(import.meta.dir, '../../web/src/lib/utils/clipboard.ts')],
    target: 'browser', format: 'esm',
  });
  assert.equal(clipboard.success, true, 'shared clipboard helper must bundle');
  await Bun.write(resolve(applications, 'garcon-smoke-browser.desktop'), `[Desktop Entry]
Type=Application
Name=Garcon Synthetic Browser
Exec="${process.execPath}" "${resolve(import.meta.dir, 'smoke-browser.js')}" %u
MimeType=x-scheme-handler/http;x-scheme-handler/https;
NoDisplay=true
`);
  await Bun.write(resolve(isolation, 'mimeapps.list'), `[Default Applications]
x-scheme-handler/http=garcon-smoke-browser.desktop
x-scheme-handler/https=garcon-smoke-browser.desktop
`);
  const env = {
    ...process.env, XDG_DATA_HOME: isolation, XDG_CONFIG_HOME: isolation, XDG_CACHE_HOME: isolation,
    XDG_DATA_DIRS: isolation, XDG_CONFIG_DIRS: isolation, GTK_USE_PORTAL: '0',
    GSETTINGS_SCHEMA_DIR: '/usr/share/glib-2.0/schemas', GSETTINGS_BACKEND: 'memory',
    GARCON_SMOKE_BROWSER_LOG: browserLog,
  };
  return { env, browserLog, attachment, clipboardScript: await clipboard.outputs[0].text() };
}

export async function checkWorkflows({ evaluate, webdriver, until, workflows, remoteUrl, nativeKey }) {
  const launches = async () => (await Bun.file(workflows.browserLog).text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const before = (await launches()).length;
  const target = 'https://external.example.test/guide?q=synthetic#section';
  const keyboardTarget = 'http://external.example.test/keyboard';
  const element = async selector => {
    const result = await webdriver('/element', { using: 'css selector', value: selector });
    return result['element-6066-11e4-a52e-4f735466cecf'];
  };
  const click = async selector => webdriver(`/element/${await element(selector)}/click`, {});
  await evaluate(`
    const link = document.createElement('a');
    link.id = 'external-link'; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.href = 'https://external.example.test/synthetic-click'; link.textContent = 'Synthetic external link'; document.body.append(link);
    const button = document.createElement('button');
    button.id = 'script-popup'; button.textContent = 'Synthetic scripted popup';
    button.onclick = () => { for (let i = 0; i < 4; i++) window.open('https://external.example.test/script-popup', '_blank'); };
    document.body.append(button);
  `);
  await evaluate(`document.querySelector('#external-link').click(); window.open('https://external.example.test/automatic-popup', '_blank');`);
  await click('#script-popup');
  // A trusted link activation is the barrier after the untrusted/scripted requests.
  await evaluate('document.querySelector("#external-link").href = arguments[0]', [target]);
  await click('#external-link');
  await until(async () => (await launches()).length > before, 'native user-activated external link');
  assert.deepEqual((await launches()).slice(before), [[target]], 'only the trusted anchor may launch an OS URL');
  assert.equal(await evaluate('return location.href'), remoteUrl);
  assert.equal((await webdriver('/window/handles')).length, 2, 'only the chooser and current remote page may survive');

  // Gives policy-denial checks an open rate gate so they cannot pass due to throttling.
  await evaluate('return new Promise(resolve => setTimeout(resolve, 1100))');
  for (const denied of [
    'https://user:password@external.example.test/',
    'https://external.example.test/oauth/authorize?client_id=synthetic',
    'https://external.example.test/?code=synthetic',
    'https://external.example.test/%2fambiguous',
    new URL('/other/', remoteUrl).href,
    remoteUrl,
    'file:///synthetic-not-a-real-file',
    'mailto:synthetic@example.test',
  ]) {
    await evaluate('document.querySelector("#external-link").href = arguments[0]', [denied]);
    await click('#external-link');
  }
  await evaluate('document.querySelector("#external-link").href = arguments[0]', [keyboardTarget]);
  const link = await element('#external-link');
  await webdriver(`/element/${link}/value`, { text: '\uE007' });
  await until(async () => (await launches()).length > before + 1, 'keyboard-activated external link');
  assert.deepEqual((await launches()).slice(before), [[target], [keyboardTarget]], 'denied destinations must never reach the OS');
  assert.equal(await evaluate('return location.href'), remoteUrl);
  console.log('Native external links passed: pointer + keyboard, synthetic/scripted popups, auth exclusions, scheme/credential/mount denial, one remote WebView.');
  await evaluate('document.querySelector("#external-link").remove(); document.querySelector("#script-popup").remove()');

  await until(() => evaluate('return typeof window.copyToClipboard === "function"'), 'shared clipboard helper');
  await evaluate(`
    const input = document.createElement('input'); input.type = 'file'; input.id = 'attachment';
    input.onchange = async () => {
      const data = new FormData(); data.set('file', input.files[0]);
      try {
        const response = await fetch(new URL('workflow-upload', location.href), { method: 'POST', body: data });
        window.uploadResult = await response.json();
      } catch (error) { window.uploadResult = { error: String(error) }; }
    };
    document.body.append(input);
    const copy = document.createElement('button'); copy.id = 'copy'; copy.textContent = 'Copy synthetic text';
    copy.onclick = async () => { window.copyResult = await window.copyToClipboard('Synthetic clipboard content.'); };
    document.body.append(copy);
    const text = document.createElement('textarea'); text.id = 'paste'; document.body.append(text);
  `);
  await webdriver(`/element/${await element('#attachment')}/value`, { text: workflows.attachment });
  await until(() => evaluate('return !!window.uploadResult'), 'attachment upload');
  assert.deepEqual(await evaluate('return window.uploadResult'), { name: 'synthetic-attachment.txt', content: 'Synthetic attachment content.' });
  await click('#copy');
  await until(() => evaluate('return window.copyResult !== undefined'), 'shared clipboard copy');
  assert.equal(await evaluate('return window.copyResult'), true, 'shared helper must report a real copy');
  await click('#paste');
  await webdriver('/actions', { actions: [{ type: 'key', id: 'clipboard-keys', actions: [
    { type: 'keyDown', value: '\uE009' }, { type: 'keyDown', value: 'v' },
    { type: 'keyUp', value: 'v' }, { type: 'keyUp', value: '\uE009' },
  ] }] });
  await until(() => evaluate('return document.querySelector("#paste").value === "Synthetic clipboard content."'), 'keyboard paste');
  assert.equal(await evaluate('return document.activeElement.id'), 'paste');
  await evaluate(`
    window.controlKeys = [];
    window.controlReleases = 0;
    document.querySelector('#paste').onkeydown = event => {
      if (event.ctrlKey && ['c', 'z'].includes(event.key)) {
        event.preventDefault(); window.controlKeys.push(event.key);
      }
    };
    document.querySelector('#paste').onkeyup = event => {
      if (event.key === 'Control') window.controlReleases++;
    };
  `);
  await nativeKey('ctrl+c');
  await nativeKey('ctrl+z');
  await until(() => evaluate('return window.controlKeys.length === 2 && window.controlReleases === 2'), 'terminal/editor control keys and modifier release');
  assert.deepEqual(await evaluate('return window.controlKeys'), ['c', 'z']);
  console.log('Native browser primitives passed: file selection through WebDriver, multipart upload, shared clipboard helper + keyboard paste, input focus, OS-level Ctrl+C/Ctrl+Z.');
  await evaluate('for (const id of ["attachment", "copy", "paste"]) document.getElementById(id).remove(); delete window.uploadResult; delete window.copyResult; delete window.controlKeys; delete window.controlReleases;');
}
