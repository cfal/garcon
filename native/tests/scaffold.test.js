import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const config = JSON.parse(read('../src-tauri/tauri.conf.json'));
const workflow = Bun.YAML.parse(read('../../.github/workflows/native-app.yml'));

test('Apple HTTP allowance is limited to WebView content', async () => {
  const window = new Window();
  try {
    const plist = new window.DOMParser().parseFromString(read('../src-tauri/Info.plist'), 'application/xml');
    const entries = [...plist.querySelector('plist > dict').children];
    expect(entries.map(entry => entry.tagName)).toEqual(['key', 'dict']);
    expect(entries[0].textContent).toBe('NSAppTransportSecurity');
    const transport = [...entries[1].children];
    expect(transport.map(entry => entry.tagName)).toEqual(['key', 'true']);
    expect(transport[0].textContent).toBe('NSAllowsArbitraryLoadsInWebContent');
  } finally { await window.happyDOM.close(); }
});

test('only the bundled launcher receives narrowly enumerated native permissions', () => {
  const capability = JSON.parse(read('../src-tauri/capabilities/launcher.json'));
  expect(config.identifier).toBe('com.garconcloud.garcon');
  expect(config.version).toBe('../../package.json');
  expect(config.build.frontendDist).toBe('../dist');
  expect(config.app.withGlobalTauri).toBe(false);
  expect(config.app.security.capabilities).toEqual(['launcher']);
  expect(capability.remote).toBeUndefined();
  expect(capability.local).toBe(true);
  expect(capability.windows).toEqual(['main']);
  expect(capability.permissions).toEqual(['allow-server-choices', 'allow-connect-server', 'allow-cancel-chooser', 'allow-remove-recent', 'allow-retry-connection', 'allow-cancel-connection', 'allow-show-connection']);
  expect(read('../src-tauri/build.rs')).toContain('AppManifest::new().commands');
});

test('remote bridge uses host navigation requests, without native command permission', () => {
  const bridge = read('../src-tauri/bridge.js');
  expect(bridge).toContain("window.location.assign('garcon-host://switch-server/')");
  expect(bridge).not.toContain('invoke');
  expect(bridge).not.toContain('connect_server');
  expect(read('../src-tauri/src/host.rs')).toContain('host.request_chooser(Some(id)');
});

test('server pages retain browser file drag and drop instead of native path events', () => {
  for (const owner of ['host.rs', 'lib.rs']) {
    expect(read(`../src-tauri/src/${owner}`)).toContain('.disable_drag_drop_handler()');
  }
});

test('desktop chrome keeps controls without custom recovery hotkeys or a reload dialog', () => {
  const chrome = read('../src-tauri/src/chrome.rs');
  expect(chrome).toContain('window.hide_menu()?');
  expect(chrome).not.toContain('connect_key_press_event');
  expect(chrome).toContain('header.set_show_close_button(true)');
  expect(chrome).toContain('"Open server"');
  expect(read('../src-tauri/src/lib.rs')).toContain('chrome::show_initial(');
  expect(read('../src-tauri/src/host.rs')).toContain('chrome::prepare(');
  const host = read('../src-tauri/src/host.rs');
  expect(host).not.toContain('CmdOrCtrl');
  expect(host).not.toContain('acknowledged');
  expect(host).toContain('pub async fn connect_server(');
  expect(host).toContain('.focused(cfg!(target_os = "linux"))');
  expect(chrome).toContain('window.as_ref().set_focus()');
});

test('CI builds all five platform families without distribution secrets', () => {
  const desktop = workflow.jobs.desktop.strategy.matrix.include;
  expect(desktop.map(row => row.target)).toEqual([
    'x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc',
    'aarch64-apple-darwin', 'x86_64-apple-darwin',
  ]);
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(workflow.env.CARGO_BUILD_JOBS).toBe(1);
  for (const trigger of [workflow.on.push, workflow.on.pull_request]) {
    expect(trigger.paths).toContain('common/ws-auth.ts');
    expect(trigger.paths).toContain('bunfig.toml');
  }
  const android = workflow.jobs.android.steps.find(step => step.name === 'Build Android APK');
  const androidSetup = workflow.jobs.android.steps.find(step => step.uses === 'android-actions/setup-android@v3');
  expect(androidSetup.with.packages).toBe('platform-tools');
  const androidSdk = workflow.jobs.android.steps.find(step => step.name === 'Install pinned Android SDK and NDK');
  expect(androidSdk.run).toContain("'platforms;android-37.0'");
  expect(android.run).toContain('--debug --apk');
  expect(android.run).toContain('--target aarch64 --target x86_64');
  const ios = workflow.jobs.ios.steps.find(step => step.name === 'Build unsigned simulator app');
  expect(ios.run).toContain('aarch64-sim');
  expect(ios.run).toContain('--no-sign');
  expect(read('../../.github/workflows/native-app.yml')).not.toContain('secrets.');
  for (const job of Object.values(workflow.jobs)) {
    expect(job['continue-on-error']).toBeUndefined();
    const upload = job.steps.find(step => step.uses === 'actions/upload-artifact@v4');
    expect(upload.with['if-no-files-found']).toBe('error');
  }
});
