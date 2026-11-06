import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { mountLauncher } from '../src/launcher.js';

const html = await Bun.file(new URL('../src/index.html', import.meta.url)).text();
const choices = (overrides = {}) => ({
  generation: 0, lastUrl: null, currentUrl: null,
  canCancel: false, connection: null, ...overrides,
  recents: (overrides.recents ?? []).map(server => typeof server === 'string' ? { url: server, name: null } : server),
});

async function withLauncherDocument(check) {
  const window = new Window();
  try {
    window.document.write(html);
    await check(window);
  } finally {
    await window.happyDOM.close();
  }
}

test('restores the saved server without connecting automatically', () => withLauncherDocument(async window => {
  const commands = [];
  await mountLauncher(window.document, async command => {
    commands.push(command);
    return choices({ lastUrl: 'https://synthetic.test/garcon/' });
  });
  expect(commands).toEqual(['server_choices']);
  expect(window.document.querySelector('input').value).toBe('https://synthetic.test/garcon/');
  expect(window.document.querySelector('button').disabled).toBe(false);
}));

test('HTTP warning follows typed URLs, saved selections and Add Server without blocking connection', () => withLauncherDocument(async window => {
  const commands = [];
  await mountLauncher(window.document, async (command, args) => {
    if (command === 'server_choices') return choices({ lastUrl: 'http://garcon.vpn.test/', recents: ['http://garcon.vpn.test/', 'https://secure.test/'] });
    commands.push([command, args]);
  });
  const input = window.document.querySelector('#server-url');
  const warning = window.document.querySelector('#insecure-endpoint');
  expect(input.getAttribute('aria-describedby').split(' ')).toContain(warning.id);
  expect(warning.hidden).toBe(false);
  expect(warning.textContent).toContain('unencrypted');
  for (const [url, hidden] of [
    ['https://secure.test/', true], ['http://garcon/', false],
    ['HTTP://garcon.vpn.test:3001/mount/', false], ['http://100.64.0.2/', false],
    ['http://[fd00::2]/', false], ['', true], ['not a URL', true],
  ]) {
    input.value = url;
    input.dispatchEvent(new window.Event('input'));
    expect(warning.hidden).toBe(hidden);
  }
  window.document.querySelector('#recent-servers li:nth-child(2) button').click();
  expect(warning.hidden).toBe(true);
  window.document.querySelector('#recent-servers button').click();
  expect(warning.hidden).toBe(false);
  window.document.querySelector('form').requestSubmit();
  expect(commands).toEqual([['connect_server', { url: 'http://garcon.vpn.test/', name: '', generation: 0 }]]);
  await new Promise(resolve => setTimeout(resolve, 0));
  window.document.querySelector('#add-server').click();
  expect(warning.hidden).toBe(true);
  input.value = 'http://autofill.test/';
  input.dispatchEvent(new window.Event('change'));
  expect(warning.hidden).toBe(false);
}));

test('opening keeps the last saved URL editable and has no reload confirmation', () => withLauncherDocument(async window => {
  await mountLauncher(window.document, async () => choices({
    currentUrl: 'https://secure.test/', lastUrl: 'http://garcon.vpn.test/', canCancel: true,
  }));
  expect(window.document.querySelector('#insecure-endpoint').hidden).toBe(false);
  expect(window.document.querySelector('#server-url').value).toBe('http://garcon.vpn.test/');
  expect(window.document.querySelector('#server-url').readOnly).toBe(false);
  expect(window.document.querySelector('#acknowledged')).toBeNull();
  expect(window.document.querySelector('#switch-warning')).toBeNull();
}));

test('submit paths share pending admission and show native validation errors', () => withLauncherDocument(async window => {
  let reject;
  let connections = 0;
  await mountLauncher(window.document, command => {
    if (command === 'server_choices') return Promise.resolve(choices());
    connections++;
    return new Promise((_, rejectPromise) => { reject = rejectPromise; });
  });
  const form = window.document.querySelector('form');
  window.document.querySelector('input').value = 'https://synthetic.test/';
  const submit = () => form.dispatchEvent(new window.Event('submit', { cancelable: true }));
  submit();
  submit();
  expect(connections).toBe(1);
  expect(window.document.querySelector('button').disabled).toBe(true);
  reject('Synthetic rejection');
  await Promise.resolve();
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(window.document.querySelector('[role="alert"]').textContent).toBe('Synthetic rejection');
  expect(window.document.querySelector('button').disabled).toBe(false);
}));

test('cancel preserves the page and opening another server requires no loss acknowledgement', () => withLauncherDocument(async window => {
  const commands = [];
  await mountLauncher(window.document, async (command, args) => {
    if (command === 'server_choices') return choices({ generation: 9, recents: ['https://a.test/', 'https://b.test/'], currentUrl: 'https://a.test/', canCancel: true });
    commands.push([command, args]);
  });
  expect(window.document.querySelector('[aria-current]').textContent).toBe('https://a.test/');
  window.document.querySelector('#cancel').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(commands).toEqual([['cancel_chooser', { generation: 9 }]]);
  window.document.querySelector('#server-url').value = 'https://b.test/';
  window.document.querySelector('form').requestSubmit();
  expect(commands[1]).toEqual(['connect_server', { url: 'https://b.test/', name: '', generation: 9 }]);
}));

test('recent removal is a host operation, and Add Server resets the selection', () => withLauncherDocument(async window => {
  const commands = [];
  await mountLauncher(window.document, async (command, args) => {
    commands.push([command, args]);
    return choices({ generation: 2, lastUrl: 'https://a.test/', recents: ['https://a.test/'] });
  });
  window.document.querySelector('#add-server').click();
  expect(window.document.querySelector('#server-url').value).toBe('');
  window.document.querySelector('[title="Remove from recents"]').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(commands).toContainEqual(['remove_recent', { url: 'https://a.test/', generation: 2 }]);
}));

test('unreadable settings fail closed', () => withLauncherDocument(async window => {
  await mountLauncher(window.document, async () => { throw new Error('Synthetic corruption'); });
  expect(window.document.querySelector('button').disabled).toBe(true);
  expect(window.document.querySelector('[role="alert"]').textContent).toContain('Restart');
}));

test('settings errors supplied by the host remain visible without enabling connection', () => withLauncherDocument(async window => {
  await mountLauncher(window.document, async () => { throw 'Another Garcon native client is already open.'; });
  expect(window.document.querySelector('[role="alert"]').textContent).toBe('Another Garcon native client is already open.');
  expect(window.document.querySelector('button').disabled).toBe(true);
}));

test('refreshes requests arriving during an open transition after it settles', () => withLauncherDocument(async window => {
  let finish;
  let snapshots = 0;
  await mountLauncher(window.document, (command) => {
    if (command === 'server_choices') {
      snapshots++;
      return Promise.resolve(choices({ generation: snapshots, lastUrl: 'https://a.test/', canCancel: true }));
    }
    return new Promise(resolve => { finish = resolve; });
  });
  expect(window.document.querySelector('#server-form button').textContent).toBe('Open server');
  expect(window.document.querySelector('#server-url').value).toBe('https://a.test/');
  window.document.querySelector('form').requestSubmit();
  window.dispatchEvent(new window.Event('garcon-chooser-open'));
  expect(snapshots).toBe(1);
  finish();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(snapshots).toBe(2);
  expect(window.document.querySelector('#server-form button').disabled).toBe(false);
}));

test('named recents show their URL and reopen as a new window, including the current server', () => withLauncherDocument(async window => {
  const commands = [];
  await mountLauncher(window.document, async (command, args) => {
    if (command === 'server_choices') return choices({ generation: 4, currentUrl: 'https://a.test/', lastUrl: 'https://a.test/', canCancel: true, recents: [{ url: 'https://a.test/', name: 'Work' }] });
    commands.push([command, args]);
  });
  expect(window.document.querySelector('#server-name').value).toBe('Work');
  expect(window.document.querySelector('#recent-servers small').textContent).toBe('https://a.test/');
  window.document.querySelector('#recent-servers button').click();
  expect(window.document.querySelector('#server-form button').textContent).toBe('Open server');
  window.document.querySelector('#server-name').value = 'Personal';
  window.document.querySelector('form').requestSubmit();
  expect(commands).toEqual([['connect_server', { url: 'https://a.test/', name: 'Personal', generation: 4 }]]);
  await new Promise(resolve => setTimeout(resolve, 0));
  window.document.querySelector('#add-server').click();
  expect(window.document.querySelector('#server-name').value).toBe('');
}));

test('stale snapshot failures cannot overwrite a newer successful chooser refresh', () => withLauncherDocument(async window => {
  let rejectOld;
  let count = 0;
  const mounting = mountLauncher(window.document, async () => {
    if (++count === 1) return new Promise((_, reject) => { rejectOld = reject; });
    return choices({ generation: 2, lastUrl: 'https://new.test/' });
  });
  window.dispatchEvent(new window.Event('garcon-chooser-open'));
  await new Promise(resolve => setTimeout(resolve, 0));
  rejectOld('Stale failure');
  await mounting;
  expect(window.document.querySelector('#connection-error').textContent).toBe('');
  expect(window.document.querySelector('#server-url').value).toBe('https://new.test/');
}));

test('host updates retain selection drafts while refreshing source and generation', () => withLauncherDocument(async window => {
  let snapshot = choices({ currentUrl: 'https://source.test/', canCancel: true, lastUrl: 'https://saved.test/' });
  const commands = [];
  await mountLauncher(window.document, async (command, args) => {
    if (command === 'server_choices') return snapshot;
    commands.push([command, args]);
  });
  const document = window.document;
  document.querySelector('#server-url').value = 'http://draft.test/';
  document.querySelector('#server-name').value = 'Draft';
  document.querySelector('#connection-error').textContent = 'Synthetic error';
  snapshot = choices({ generation: 2, lastUrl: 'https://saved.test/' });
  window.dispatchEvent(new window.Event('garcon-chooser-update'));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.querySelector('#server-url').value).toBe('http://draft.test/');
  expect(document.querySelector('#server-name').value).toBe('Draft');
  expect(document.querySelector('#connection-error').textContent).toBe('Synthetic error');
  expect(document.querySelector('#insecure-endpoint').hidden).toBe(false);
  expect(document.querySelector('#current-server').textContent).toBe('');
  expect(document.querySelector('#cancel').hidden).toBe(true);
  document.querySelector('form').requestSubmit();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(commands).toEqual([['connect_server', { url: 'http://draft.test/', name: 'Draft', generation: 2 }]]);
  window.dispatchEvent(new window.Event('garcon-chooser-open'));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.querySelector('#server-url').value).toBe('https://saved.test/');
  expect(document.querySelector('#server-name').value).toBe('');
}));

test('overlapping host updates cannot replace a retained draft with transient empty fields', () => withLauncherDocument(async window => {
  let finishOld;
  let count = 0;
  await mountLauncher(window.document, async () => {
    if (++count === 2) return new Promise(resolve => { finishOld = resolve; });
    return choices({ lastUrl: 'https://saved.test/' });
  });
  const document = window.document;
  document.querySelector('#server-url').value = 'https://draft.test/';
  document.querySelector('#server-name').value = 'Draft';
  document.querySelector('#connection-error').textContent = 'Synthetic error';
  window.dispatchEvent(new window.Event('garcon-chooser-update'));
  window.dispatchEvent(new window.Event('garcon-chooser-update'));
  await new Promise(resolve => setTimeout(resolve, 0));
  finishOld(choices());
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.querySelector('#server-url').value).toBe('https://draft.test/');
  expect(document.querySelector('#server-name').value).toBe('Draft');
  expect(document.querySelector('#connection-error').textContent).toBe('Synthetic error');
}));

test('failed opens retain the attempted URL and name across queued host refreshes', () => withLauncherDocument(async window => {
  let rejectOpen;
  await mountLauncher(window.document, command => command === 'server_choices'
    ? Promise.resolve(choices({ lastUrl: 'https://saved.test/' }))
    : new Promise((_, reject) => { rejectOpen = reject; }));
  window.document.querySelector('#server-url').value = 'http://attempt.test/';
  window.document.querySelector('#server-name').value = 'Attempt';
  window.document.querySelector('form').requestSubmit();
  window.dispatchEvent(new window.Event('garcon-chooser-open'));
  rejectOpen('Synthetic failure');
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(window.document.querySelector('#server-url').value).toBe('http://attempt.test/');
  expect(window.document.querySelector('#insecure-endpoint').hidden).toBe(false);
  expect(window.document.querySelector('#server-name').value).toBe('Attempt');
  expect(window.document.querySelector('#connection-error').textContent).toBe('Synthetic failure');
}));

test('loading hides selection while Cancel and Retry remain independently actionable', () => withLauncherDocument(async window => {
  let connection = { id: 8, server: 'Work', url: 'https://synthetic.test/', message: null, ready: false, canRetry: false, canShow: false };
  const commands = [];
  await mountLauncher(window.document, async (command, args) => {
    if (command === 'server_choices') return choices({ connection });
    commands.push([command, args]);
  });
  const document = window.document;
  expect(document.querySelector('#server-selection').hidden).toBe(true);
  expect(document.querySelector('#connection').hidden).toBe(false);
  expect(document.querySelector('#retry-connection').disabled).toBe(true);
  expect(document.querySelector('#cancel-connection').disabled).toBe(false);
  expect(document.querySelector('#show-connection').hidden).toBe(true);
  document.querySelector('#server-url').value = 'https://ignored.test/';
  document.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  expect(commands).toEqual([]);
  connection = { ...connection, message: 'Garcon has not become ready.', canRetry: true, canShow: true };
  window.dispatchEvent(new window.Event('garcon-chooser-open'));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.querySelector('#connection-status').textContent).toBe(connection.message);
  expect(document.querySelector('#retry-connection').disabled).toBe(false);
  expect(document.querySelector('#show-connection').hidden).toBe(false);
  document.querySelector('#retry-connection').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  document.querySelector('#show-connection').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(commands).toEqual([
    ['retry_connection', { id: 8 }], ['show_connection', { id: 8 }], ['cancel_connection', { id: 8 }],
  ]);
  connection = { ...connection, ready: true, message: null };
  window.dispatchEvent(new window.Event('garcon-chooser-open'));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.querySelector('#connection-heading').textContent).toBe('Ready');
  expect(document.querySelector('#show-connection').textContent).toBe('Show page');
  connection = null;
  window.dispatchEvent(new window.Event('garcon-chooser-open'));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.querySelector('#server-selection').hidden).toBe(false);
  expect(document.querySelector('#server-form button').disabled).toBe(false);
}));
