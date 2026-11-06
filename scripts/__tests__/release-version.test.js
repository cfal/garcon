import { expect, test } from 'bun:test';
import { readReleaseVersion, validateReleaseVersion } from '../release-version.js';

function documents() {
  return {
    root: { version: '0.4.0' }, native: { version: '0.4.0' },
    cargo: { package: { name: 'garcon-native', version: '0.4.0' } },
    cargoLock: { package: [
      { name: 'garcon-native', version: '0.4.0' },
      { name: 'unrelated', version: '0.3.4' },
      { name: 'garcon-native', version: '0.1.0', source: 'registry+synthetic' },
    ] },
    bunLock: { workspaces: { native: { version: '0.4.0' } } },
    tauri: { version: '../../package.json' },
  };
}

test('release versions agree across the real repository and both lockfiles', async () => {
  expect(await readReleaseVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  expect(validateReleaseVersion(documents(), 'v0.4.0')).toBe('0.4.0');
});

test('every native version surface must match the root version', () => {
  for (const mutate of [
    value => { value.native.version = '0.3.4'; },
    value => { value.cargo.package.version = '0.3.4'; },
    value => { value.cargoLock.package[0].version = '0.3.4'; },
    value => { value.bunLock.workspaces.native.version = '0.3.4'; },
    value => { value.tauri.version = '0.4.0'; },
    value => { value.cargoLock.package.shift(); },
    value => { value.cargoLock.package.push({ name: 'garcon-native', version: '0.4.0' }); },
  ]) {
    const value = documents();
    mutate(value);
    expect(() => validateReleaseVersion(value)).toThrow();
  }
});

test('release tags require exact numeric versions, without shell or prerelease syntax', () => {
  for (const version of ['', '00.4.0', '0.4', '0.4.0-rc.1', '0.4.0+build', '0.4.0\n', 4]) {
    const value = documents();
    value.root.version = version;
    expect(() => validateReleaseVersion(value)).toThrow('numeric');
  }
  for (const tag of ['', '0.4.0', 'v0.4', 'v0.4.1', 'v0.4.0-rc.1', 'v0.4.0+b', 'v0.4.0$(id)', 'v0.4.0\n']) {
    expect(() => validateReleaseVersion(documents(), tag)).toThrow('Release tag');
  }
});
