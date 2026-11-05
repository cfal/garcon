import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { mountLauncher } from '../src/launcher.js';

const html = await Bun.file(new URL('../src/index.html', import.meta.url)).text();
const choices = (overrides = {}) => ({
  generation: 0, recents: [], lastUrl: null, currentUrl: null,
  canCancel: false, pending: false, action: 'open', currentName: null, ...overrides,
  recents: (overrides.recents ?? []).map(server => typeof server === 'string' ? { url: server, name: null } : server),
});

test('restores the saved server without connecting automatically', async () => {
  const window = new Window();
  try {
    window.document.write(html);
    const commands = [];
    await mountLauncher(window.document, async command => {
      commands.push(command);
      return choices({ lastUrl: 'https://synthetic.test/garcon/' });
    });
    expect(commands).toEqual(['server_choices']);
    expect(window.document.querySelector('input').value).toBe('https://synthetic.test/garcon/');
    expect(window.document.querySelector('button').disabled).toBe(false);
  } finally { await window.happyDOM.close(); }
});

test('submit paths share pending admission and show native validation errors', async () => {
  const window = new Window();
  try {
    window.document.write(html);
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
  } finally { await window.happyDOM.close(); }
});

test('cancel preserves the page and opening another server requires no loss acknowledgement', async () => {
  const window = new Window();
  try {
    window.document.write(html);
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
    expect(window.document.querySelector('#switch-warning').hidden).toBe(true);
    expect(commands[1]).toEqual(['connect_server', { url: 'https://b.test/', name: '', generation: 9, acknowledged: false }]);
  } finally { await window.happyDOM.close(); }
});

test('recent removal is a host operation, and Add Server resets the selection', async () => {
  const window = new Window();
  try {
    window.document.write(html);
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
  } finally { await window.happyDOM.close(); }
});

test('unreadable settings fail closed', async () => {
  const window = new Window();
  try {
    window.document.write(html);
    await mountLauncher(window.document, async () => { throw new Error('Synthetic corruption'); });
    expect(window.document.querySelector('button').disabled).toBe(true);
    expect(window.document.querySelector('[role="alert"]').textContent).toContain('Restart');
  } finally { await window.happyDOM.close(); }
});

test('settings errors supplied by the host remain visible without enabling connection', async () => {
  const window = new Window();
  try {
    window.document.write(html);
    await mountLauncher(window.document, async () => { throw 'Another Garcon native client is already open.'; });
    expect(window.document.querySelector('[role="alert"]').textContent).toBe('Another Garcon native client is already open.');
    expect(window.document.querySelector('button').disabled).toBe(true);
  } finally { await window.happyDOM.close(); }
});

test('reload uses the same confirmation gate and refreshes requests arriving during a transition', async () => {
  const window = new Window();
  try {
    window.document.write(html);
    let finish;
    let snapshots = 0;
    await mountLauncher(window.document, (command) => {
      if (command === 'server_choices') {
        snapshots++;
        return Promise.resolve(choices({ generation: snapshots, currentUrl: 'https://a.test/', canCancel: true, action: 'reload' }));
      }
      return new Promise(resolve => { finish = resolve; });
    });
    expect(window.document.querySelector('#server-form button').textContent).toBe('Reload Server');
    expect(window.document.querySelector('#server-url').value).toBe('https://a.test/');
    window.document.querySelector('form').requestSubmit();
    expect(finish).toBeUndefined();
    expect(window.document.querySelector('#recent-servers').hidden).toBe(true);
    expect(window.document.querySelector('#server-url').readOnly).toBe(true);
    window.document.querySelector('#acknowledged').checked = true;
    window.document.querySelector('form').requestSubmit();
    window.dispatchEvent(new window.Event('garcon-chooser-open'));
    expect(snapshots).toBe(1);
    finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(snapshots).toBe(2);
    expect(window.document.querySelector('#acknowledged').checked).toBe(false);
  } finally { await window.happyDOM.close(); }
});

test('named recents show their URL and reopen as a new window, including the current server', async () => {
  const window = new Window();
  try {
    window.document.write(html);
    const commands = [];
    await mountLauncher(window.document, async (command, args) => {
      if (command === 'server_choices') return choices({ generation: 4, currentUrl: 'https://a.test/', lastUrl: 'https://a.test/', canCancel: true, recents: [{ url: 'https://a.test/', name: 'Work' }] });
      commands.push([command, args]);
    });
    expect(window.document.querySelector('#server-name').value).toBe('Work');
    expect(window.document.querySelector('#recent-servers small').textContent).toBe('https://a.test/');
    window.document.querySelector('#recent-servers button').click();
    expect(window.document.querySelector('#server-form button').textContent).toBe('Open Server');
    window.document.querySelector('#server-name').value = 'Personal';
    window.document.querySelector('form').requestSubmit();
    expect(commands).toEqual([['connect_server', { url: 'https://a.test/', name: 'Personal', generation: 4, acknowledged: false }]]);
    await new Promise(resolve => setTimeout(resolve, 0));
    window.document.querySelector('#add-server').click();
    expect(window.document.querySelector('#server-name').value).toBe('');
  } finally { await window.happyDOM.close(); }
});

test('stale snapshot failures cannot overwrite a newer successful chooser refresh', async () => {
  const window = new Window();
  try {
    window.document.write(html);
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
  } finally { await window.happyDOM.close(); }
});

test('failed opens retain the attempted URL and name across queued host refreshes', async () => {
  const window = new Window();
  try {
    window.document.write(html);
    let rejectOpen;
    await mountLauncher(window.document, command => command === 'server_choices'
      ? Promise.resolve(choices({ lastUrl: 'https://saved.test/' }))
      : new Promise((_, reject) => { rejectOpen = reject; }));
    window.document.querySelector('#server-url').value = 'https://attempt.test/';
    window.document.querySelector('#server-name').value = 'Attempt';
    window.document.querySelector('form').requestSubmit();
    window.dispatchEvent(new window.Event('garcon-chooser-open'));
    rejectOpen('Synthetic failure');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(window.document.querySelector('#server-url').value).toBe('https://attempt.test/');
    expect(window.document.querySelector('#server-name').value).toBe('Attempt');
    expect(window.document.querySelector('#connection-error').textContent).toBe('Synthetic failure');
  } finally { await window.happyDOM.close(); }
});
