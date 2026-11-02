import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { mountLauncher } from '../src/launcher.js';

const html = await Bun.file(new URL('../src/index.html', import.meta.url)).text();

test('restores the saved server without connecting automatically', async () => {
  const window = new Window();
  try {
    window.document.write(html);
    const commands = [];
    await mountLauncher(window.document, async command => {
      commands.push(command);
      return 'https://synthetic.test/garcon/';
    });
    expect(commands).toEqual(['saved_server']);
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
      if (command === 'saved_server') return Promise.resolve(null);
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
    expect(window.document.querySelector('[role="alert"]').textContent).toBe('Synthetic rejection');
    expect(window.document.querySelector('button').disabled).toBe(false);
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
