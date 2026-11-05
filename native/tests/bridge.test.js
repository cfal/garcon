import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';

const bridge = await Bun.file(new URL('../src-tauri/bridge.js', import.meta.url)).text();

function fixture(hidden = false, childFrame = false) {
  const destinations = [];
  const window = new EventTarget();
  window.top = childFrame ? {} : window;
  window.location = { assign: url => destinations.push(url) };
  runInNewContext(`${bridge}(${hidden});`, { window });
  return {
    window, destinations,
    publish(detail) { window.dispatchEvent(Object.assign(new Event('garcon-titlebar-state'), { detail })); },
  };
}

test('desktop bridge exposes only fixed chooser and titlebar requests on the top frame', () => {
  const { window, destinations } = fixture();
  const host = window.__GARCON_NATIVE__;
  expect(Object.isFrozen(host)).toBe(true);
  expect(Object.isFrozen(host.titlebar)).toBe(true);
  expect(Object.isFrozen(host.lifecycle)).toBe(true);
  host.requestServerChooser();
  host.titlebar.requestHidden(true);
  host.titlebar.requestHidden(false);
  host.lifecycle.requestReload('https://ignored.test/');
  host.lifecycle.reportReady();
  expect(destinations).toEqual(['garcon-host://switch-server/', 'garcon-host://hide-titlebar/', 'garcon-host://show-titlebar/', 'garcon-host://reload-server/', 'garcon-host://page-ready/']);
  expect(() => host.titlebar.requestHidden('yes')).toThrow('Expected titlebar visibility');
  expect(fixture(false, true).window.__GARCON_NATIVE__).toBeUndefined();
});

test('titlebar subscriptions report host state, failures and cleanup without optimistic changes', () => {
  const page = fixture(true);
  const snapshots = [];
  const titlebar = page.window.__GARCON_NATIVE__.titlebar;
  const unsubscribe = titlebar.subscribe(value => snapshots.push(value));
  expect(snapshots).toEqual([{ hidden: true, failed: false }]);
  titlebar.requestHidden(false);
  expect(snapshots).toHaveLength(1);
  page.publish({ hidden: true, failed: true });
  page.publish({ hidden: false, failed: false });
  page.publish({ hidden: 'false', failed: false });
  expect(snapshots).toEqual([
    { hidden: true, failed: false }, { hidden: true, failed: true }, { hidden: false, failed: false },
  ]);
  expect(Object.isFrozen(snapshots[2])).toBe(true);
  unsubscribe();
  page.publish({ hidden: true, failed: false });
  expect(snapshots).toHaveLength(3);
  const current = [];
  titlebar.subscribe(value => current.push(value))();
  expect(current).toEqual([{ hidden: true, failed: false }]);
});
